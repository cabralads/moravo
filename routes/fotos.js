// =========================================================================
// /api/imoveis/:id/fotos — upload e remoção de fotos (max 5 por imóvel)
// =========================================================================
const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads', 'imoveis');
const MAX_FOTOS   = 5;
const MAX_SIZE    = 5 * 1024 * 1024; // 5MB
const TIPOS       = /jpeg|jpg|png|webp/;

// Garante que a pasta raiz existe
if (!fs.existsSync(UPLOAD_ROOT)) fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

// Storage: salva em uploads/imoveis/<id>/<timestamp>-<nome>
const storage = multer.diskStorage({
  destination: function (req, _file, cb) {
    const id = parseInt(req.params.id, 10);
    const dir = path.join(UPLOAD_ROOT, String(id));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: function (_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const name = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext;
    cb(null, name);
  },
});

const upload = multer({
  storage: storage,
  limits:  { fileSize: MAX_SIZE, files: MAX_FOTOS },
  fileFilter: function (_req, file, cb) {
    const ok = TIPOS.test(file.mimetype) && TIPOS.test(path.extname(file.originalname).toLowerCase());
    if (!ok) return cb(new Error('Tipo não permitido. Use JPEG, PNG ou WebP.'));
    cb(null, true);
  },
});

// ---- Verifica permissão (dono do imóvel) e quantas fotos já tem
async function checkPerm(req) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return { error: 'ID inválido.', status: 400 };
  const r = await query('SELECT dono_id, fotos FROM moravo.imoveis WHERE id = $1', [id]);
  if (r.rowCount === 0) return { error: 'Imóvel não encontrado.', status: 404 };
  if (r.rows[0].dono_id !== req.user.id) {
    return { error: 'Você só pode gerenciar fotos dos seus imóveis.', status: 403 };
  }
  return { id: id, fotosAtuais: Array.isArray(r.rows[0].fotos) ? r.rows[0].fotos : [] };
}

// ---- POST /api/imoveis/:id/fotos — upload (1 ou mais arquivos)
router.post('/', requireAuth, upload.array('fotos', MAX_FOTOS), async (req, res) => {
  try {
    const check = await checkPerm(req);
    if (check.error) return res.status(check.status).json({ ok: false, error: check.error });

    const files = req.files || [];
    const espaco = MAX_FOTOS - check.fotosAtuais.length;
    if (files.length > espaco) {
      // Remove os arquivos que sobraram
      files.slice(espaco).forEach(f => fs.unlinkSync(f.path));
      return res.status(400).json({
        ok: false,
        error: `Limite de ${MAX_FOTOS} fotos atingido. Você pode adicionar mais ${espaco}.`,
      });
    }

    // Monta URLs públicas
    const novasUrls = files.map(f => '/uploads/imoveis/' + check.id + '/' + path.basename(f.path));
    const todas = [...check.fotosAtuais, ...novasUrls];

    await query('UPDATE moravo.imoveis SET fotos = $1 WHERE id = $2', [JSON.stringify(todas), check.id]);

    return res.json({ ok: true, fotos: todas, adicionadas: novasUrls });
  } catch (err) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ ok: false, error: 'Cada foto deve ter no máximo 5MB.' });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ ok: false, error: `Máximo de ${MAX_FOTOS} fotos por envio.` });
    }
    console.error('[fotos POST] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro no upload.' });
  }
});

// ---- DELETE /api/imoveis/:id/fotos — remove uma foto (passa a URL no body)
router.delete('/', requireAuth, async (req, res) => {
  try {
    const check = await checkPerm(req);
    if (check.error) return res.status(check.status).json({ ok: false, error: check.error });

    const url = (req.body && req.body.url || '').trim();
    if (!url) return res.status(400).json({ ok: false, error: 'Passe a URL da foto a remover.' });

    // Remove da lista
    const novas = check.fotosAtuais.filter(f => f !== url);
    if (novas.length === check.fotosAtuais.length) {
      return res.status(404).json({ ok: false, error: 'Foto não encontrada.' });
    }

    // Tenta deletar o arquivo do disco (best-effort)
    try {
      const filename = path.basename(url);
      const filepath = path.join(UPLOAD_ROOT, String(check.id), filename);
      if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    } catch (e) {
      console.warn('[fotos DELETE] não consegui deletar arquivo:', e.message);
    }

    await query('UPDATE moravo.imoveis SET fotos = $1 WHERE id = $2', [JSON.stringify(novas), check.id]);
    return res.json({ ok: true, fotos: novas });
  } catch (err) {
    console.error('[fotos DELETE] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro ao remover foto.' });
  }
});

module.exports = router;
