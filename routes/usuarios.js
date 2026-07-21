// =========================================================================
// GET /api/usuarios — lista usuários (admin/debug)
// Query params opcionais: ?perfil=corretor&cidade=Joinville&limit=50
// =========================================================================
const express = require('express');
const router = express.Router();
const { query } = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads', 'perfis');
if (!fs.existsSync(UPLOAD_ROOT)) fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_ROOT);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const name = req.user.id + '-' + Date.now() + ext;
    cb(null, name);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: function (req, file, cb) {
    const tipos = /jpeg|jpg|png|webp/;
    const ok = tipos.test(file.mimetype) && tipos.test(path.extname(file.originalname).toLowerCase());
    if (!ok) return cb(new Error('Tipo não permitido. Use JPEG, PNG ou WebP.'));
    cb(null, true);
  }
});

const PERFIS_VALIDOS = ['proprietario', 'corretor'];

router.get('/', async (req, res) => {
  try {
    const perfil   = (req.query.perfil   || '').toLowerCase();
    const cidade   = (req.query.cidade   || '').trim();
    const limitRaw = parseInt(req.query.limit, 10);
    const limit    = Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 200
                       ? limitRaw
                       : 50;

    // Monta o WHERE dinamicamente (sempre com $1..$n numerados)
    const conditions = [];
    const params = [];

    if (PERFIS_VALIDOS.indexOf(perfil) !== -1) {
      params.push(perfil);
      conditions.push(`perfil = $${params.length}`);
    }
    if (cidade) {
      params.push(`%${cidade}%`);
      conditions.push(`cidade ILIKE $${params.length}`);
    }

    params.push(limit);
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const sql = `
      SELECT id, nome, email, whatsapp, cidade, perfil,
             tipo_imovel, preco_estimado, creci, regiao_atuacao,
             created_at
      FROM moravo.usuarios
      ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length}
    `;

    const result = await query(sql, params);
    return res.json({ ok: true, total: result.rowCount, usuarios: result.rows });
  } catch (err) {
    console.error('[usuarios] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// Resumo por perfil — útil pra um dashboard
router.get('/stats', async (_req, res) => {
  try {
    const result = await query(`
      SELECT perfil, COUNT(*)::int AS total
      FROM moravo.usuarios
      GROUP BY perfil
      ORDER BY perfil
    `);
    return res.json({ ok: true, stats: result.rows });
  } catch (err) {
    console.error('[usuarios/stats] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

const { requireAuth } = require('../middleware/auth');

router.put('/me', requireAuth, async (req, res) => {
  try {
    const { nome, email, whatsapp, cidade, creci, regiao, senha_atual, senha_nova } = req.body;
    
    if (!nome || !email) {
      return res.status(400).json({ ok: false, error: 'Nome e E-mail são obrigatórios.' });
    }

    // Se o usuário quiser alterar a senha
    if (senha_nova) {
      if (!senha_atual) {
        return res.status(400).json({ ok: false, error: 'Informe a senha atual para poder alterá-la.' });
      }
      if (senha_nova.length < 6) {
        return res.status(400).json({ ok: false, error: 'A nova senha deve ter no mínimo 6 caracteres.' });
      }

      // Busca hash atual
      const userRes = await query('SELECT senha_hash FROM moravo.usuarios WHERE id = $1', [req.user.id]);
      if (userRes.rowCount === 0) {
        return res.status(404).json({ ok: false, error: 'Usuário não encontrado.' });
      }

      const bcrypt = require('bcrypt');
      const passOk = await bcrypt.compare(senha_atual, userRes.rows[0].senha_hash);
      if (!passOk) {
        return res.status(400).json({ ok: false, error: 'Senha atual incorreta.' });
      }

      const newHash = await bcrypt.hash(senha_nova, 10);
      await query('UPDATE moravo.usuarios SET senha_hash = $1 WHERE id = $2', [newHash, req.user.id]);
    }

    // Busca os dados atuais do usuário para preencher campos não enviados
    // (importante pra campos NOT NULL como cidade, que podem estar ausentes no PUT)
    const currentUser = await query(
      'SELECT nome, email, whatsapp, cidade, creci, regiao_atuacao FROM moravo.usuarios WHERE id = $1',
      [req.user.id]
    );
    if (currentUser.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Usuário não encontrado.' });
    }
    const u = currentUser.rows[0];

    // Para corretores, o "regiao_atuacao" guarda a cidade (formato: "Cidade - UF").
    // Se a coluna cidade estiver NULL no banco, extrai da região de atuação
    // pra satisfazer a constraint NOT NULL.
    let cidadeFinal = (cidade != null && cidade !== '') ? cidade.trim() : u.cidade;
    if (!cidadeFinal && req.user.perfil === 'corretor' && u.regiao_atuacao) {
      // Extrai a cidade do formato "Cidade - UF"
      const reg = u.regiao_atuacao;
      cidadeFinal = reg.indexOf(' - ') !== -1 ? reg.split(' - ')[0].trim() : reg.trim();
    }
    if (!cidadeFinal) {
      cidadeFinal = 'Não informada';
    }

    const result = await query(
      `UPDATE moravo.usuarios
       SET nome = $1, email = $2, whatsapp = $3, cidade = $4, creci = $5, regiao_atuacao = $6, updated_at = NOW()
       WHERE id = $7
       RETURNING id, nome, email, whatsapp, cidade, perfil, creci, regiao_atuacao AS regiao, foto_perfil`,
      [
        (nome || u.nome).trim(),
        (email || u.email).trim().toLowerCase(),
        whatsapp != null ? whatsapp.trim() : u.whatsapp,
        cidadeFinal,
        creci != null ? creci.trim() : u.creci,
        regiao != null ? regiao.trim() : u.regiao_atuacao,
        req.user.id
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Usuário não encontrado.' });
    }

    return res.json({ ok: true, user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ ok: false, error: 'Este e-mail já está em uso.' });
    }
    console.error('[usuarios/me] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro ao atualizar dados do perfil.' });
  }
});

// ---- POST /api/usuarios/me/foto — upload de foto de perfil
router.post('/me/foto', requireAuth, upload.single('foto'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ ok: false, error: 'Por favor, envie um arquivo de imagem.' });
    }

    const publicUrl = '/uploads/perfis/' + path.basename(req.file.path);

    // Remove a foto de perfil antiga
    const userRes = await query('SELECT foto_perfil FROM moravo.usuarios WHERE id = $1', [req.user.id]);
    if (userRes.rowCount > 0 && userRes.rows[0].foto_perfil) {
      const oldUrl = userRes.rows[0].foto_perfil;
      if (oldUrl.startsWith('/uploads/perfis/')) {
        const oldPath = path.join(__dirname, '..', 'uploads', 'perfis', path.basename(oldUrl));
        if (fs.existsSync(oldPath)) {
          try {
            fs.unlinkSync(oldPath);
          } catch (e) {
            console.warn('[usuarios/me/foto] falha ao remover arquivo antigo:', e.message);
          }
        }
      }
    }

    await query('UPDATE moravo.usuarios SET foto_perfil = $1, updated_at = NOW() WHERE id = $2', [publicUrl, req.user.id]);

    return res.json({ ok: true, foto_perfil: publicUrl });
  } catch (err) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ ok: false, error: 'A foto do perfil deve ter no máximo 5MB.' });
    }
    console.error('[usuarios/me/foto] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro no upload da foto de perfil.' });
  }
});

module.exports = router;
