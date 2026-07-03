// =========================================================================
// /api/favoritos — imóvel favoritado pelo usuário
// =========================================================================
const express = require('express');
const router  = express.Router();
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

// ---- GET /api/favoritos — lista imóveis favoritados pelo usuário logado
router.get('/', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const r = await query(
      `SELECT f.id AS favorito_id, f.created_at AS favoritado_em,
              im.*, u.nome AS dono_nome
       FROM moravo.favoritos f
       JOIN moravo.imoveis im ON im.id = f.imovel_id
       JOIN moravo.usuarios u ON u.id = im.dono_id
       WHERE f.usuario_id = $1
       ORDER BY f.created_at DESC
       LIMIT $2`,
      [req.user.id, limit]
    );
    return res.json({ ok: true, total: r.rowCount, imoveis: r.rows });
  } catch (err) {
    console.error('[favoritos GET] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- GET /api/favoritos/ids — só os IDs dos imóveis favoritos do usuário logado
//      (usado pelo front pra pintar os corações cheios na home / busca)
router.get('/ids', requireAuth, async (req, res) => {
  try {
    const r = await query(
      'SELECT imovel_id FROM moravo.favoritos WHERE usuario_id = $1',
      [req.user.id]
    );
    const ids = r.rows.map(row => row.imovel_id);
    return res.json({ ok: true, ids });
  } catch (err) {
    console.error('[favoritos GET /ids] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- POST /api/favoritos  body: { imovel_id: <number> }
//      Adiciona o imóvel aos favoritos do usuário logado (idempotente)
router.post('/', requireAuth, async (req, res) => {
  try {
    const imovelId = parseInt((req.body || {}).imovel_id, 10);
    if (!Number.isFinite(imovelId)) {
      return res.status(400).json({ ok: false, error: 'imovel_id inválido.' });
    }

    // Confere que o imóvel existe
    const imovelCheck = await query('SELECT id, status FROM moravo.imoveis WHERE id = $1', [imovelId]);
    if (imovelCheck.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Imóvel não encontrado.' });
    }

    // Insere; se já existir, ON CONFLICT não faz nada
    const result = await query(
      `INSERT INTO moravo.favoritos (usuario_id, imovel_id)
       VALUES ($1, $2)
       ON CONFLICT (usuario_id, imovel_id) DO NOTHING
       RETURNING id, created_at`,
      [req.user.id, imovelId]
    );

    if (result.rowCount === 0) {
      // Já era favorito
      return res.json({ ok: true, alreadyFavorite: true });
    }
    return res.status(201).json({ ok: true, id: result.rows[0].id, created_at: result.rows[0].created_at });
  } catch (err) {
    if (err.code === '23503') {
      return res.status(400).json({ ok: false, error: 'Imóvel não encontrado.' });
    }
    console.error('[favoritos POST] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- DELETE /api/favoritos/:imovelId — remove dos favoritos
router.delete('/:imovelId', requireAuth, async (req, res) => {
  try {
    const imovelId = parseInt(req.params.imovelId, 10);
    if (!Number.isFinite(imovelId)) {
      return res.status(400).json({ ok: false, error: 'ID de imóvel inválido.' });
    }

    const result = await query(
      'DELETE FROM moravo.favoritos WHERE usuario_id = $1 AND imovel_id = $2 RETURNING id',
      [req.user.id, imovelId]
    );
    if (result.rowCount === 0) {
      return res.json({ ok: true, removed: 0 });
    }
    return res.json({ ok: true, removed: result.rowCount });
  } catch (err) {
    console.error('[favoritos DELETE] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

module.exports = router;
