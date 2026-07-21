// =========================================================================
// /api/imoveis/:id/documentos — upload e remoção do documento da escritura
// Espelha o padrão de routes/fotos.js (multer diskStorage, permissões por dono).
// =========================================================================
const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads', 'documentos');
const MAX_SIZE    = 5 * 1024 * 1024; // 5MB
const EXT_OK      = /pdf|jpe?g|png|webp/i;
const MIME_OK     = /application\/pdf|image\/jpeg|image\/png|image\/webp/;

// Garante que a pasta raiz existe
if (!fs.existsSync(UPLOAD_ROOT)) fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

// Storage: uploads/documentos/<id>/escritura-<timestamp>-<rand>.<ext>
const storage = multer.diskStorage({
  destination: function (req, _file, cb) {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return cb(new Error('ID inválido.'));
    const dir = path.join(UPLOAD_ROOT, String(id));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: function (_req, file, cb) {
    const ext  = path.extname(file.originalname).toLowerCase();
    const name = 'escritura-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext;
    cb(null, name);
  },
});

const upload = multer({
  storage: storage,
  limits:  { fileSize: MAX_SIZE },
  fileFilter: function (_req, file, cb) {
    const mimeOk = MIME_OK.test(file.mimetype);
    const extOk  = EXT_OK.test(path.extname(file.originalname).toLowerCase());
    if (!mimeOk || !extOk) {
      return cb(new Error('Tipo não permitido. Use PDF, JPEG, PNG ou WebP.'));
    }
    cb(null, true);
  },
});

// ---- POST /api/imoveis/:id/documentos — upload do arquivo da escritura
router.post('/', requireAuth, upload.single('escritura'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'ID inválido.' });

    const ck = await query('SELECT dono_id FROM moravo.imoveis WHERE id = $1', [id]);
    if (ck.rowCount === 0) return res.status(404).json({ ok: false, error: 'Imóvel não encontrado.' });
    if (ck.rows[0].dono_id !== req.user.id) {
      return res.status(403).json({ ok: false, error: 'Você só pode enviar documentos dos seus imóveis.' });
    }

    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'Nenhum arquivo enviado.' });
    }

    const url = '/uploads/documentos/' + id + '/' + path.basename(req.file.path);
    return res.json({ ok: true, url: url, filename: req.file.originalname });
  } catch (err) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ ok: false, error: 'Arquivo muito grande. O limite é 5MB.' });
    }
    if (err.message && err.message.indexOf('Tipo não permitido') !== -1) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    console.error('[documentos POST] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro no upload.' });
  }
});

// ---- DELETE /api/imoveis/:id/documentos — remove o arquivo da escritura do disco e zera a coluna
router.delete('/', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'ID inválido.' });

    const ck = await query(
      'SELECT dono_id, escritura_arquivo_url FROM moravo.imoveis WHERE id = $1', [id]
    );
    if (ck.rowCount === 0) return res.status(404).json({ ok: false, error: 'Imóvel não encontrado.' });
    if (ck.rows[0].dono_id !== req.user.id) {
      return res.status(403).json({ ok: false, error: 'Sem permissão.' });
    }

    const currentUrl = ck.rows[0].escritura_arquivo_url;
    if (currentUrl) {
      try {
        const filepath = path.join(UPLOAD_ROOT, String(id), path.basename(currentUrl));
        if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
      } catch (e) {
        console.warn('[documentos DELETE] não consegui deletar arquivo:', e.message);
      }
    }

    await query('UPDATE moravo.imoveis SET escritura_arquivo_url = NULL WHERE id = $1', [id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[documentos DELETE] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro ao remover documento.' });
  }
});

module.exports = router;
