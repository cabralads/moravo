// =========================================================================
// /api/notificacoes — feed de notificações persistidas
// =========================================================================
const express = require('express');
const router  = express.Router();
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

// ---- GET /api/notificacoes
// Query params:
//   lida=false         -> só não lidas
//   limit=100          -> máx 500
// Retorna as notificações do usuário logado com dados de join para
// facilitar a renderização (titulo do imovel, nome do remetente).
router.get('/', requireAuth, async (req, res) => {
  try {
    const onlyUnread = req.query.lida === 'false';
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

    const params = [req.user.id];
    let where = 'n.usuario_id = $1';
    if (onlyUnread) {
      where += ' AND n.lida = false';
    }
    params.push(limit);

    const sql = `
      SELECT n.*,
             im.titulo AS imovel_titulo,
             im.cidade AS imovel_cidade,
             im.fotos AS imovel_fotos,
             u.nome  AS remetente_nome,
             u.whatsapp AS remetente_whatsapp,
             u.email AS remetente_email,
             u.creci AS remetente_creci
      FROM moravo.notificacoes n
      LEFT JOIN moravo.imoveis im ON im.id = n.imovel_id
      LEFT JOIN moravo.usuarios u ON u.id = n.remetente_id
      WHERE ${where}
      ORDER BY n.created_at DESC
      LIMIT $${params.length}
    `;
    const r = await query(sql, params);
    return res.json({ ok: true, total: r.rowCount, notificacoes: r.rows });
  } catch (err) {
    console.error('[notificacoes GET] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- GET /api/notificacoes/nao-lidas/count
router.get('/nao-lidas/count', requireAuth, async (req, res) => {
  try {
    const r = await query(
      'SELECT count(*)::int AS total FROM moravo.notificacoes WHERE usuario_id = $1 AND lida = false',
      [req.user.id]
    );
    return res.json({ ok: true, total: r.rows[0].total });
  } catch (err) {
    console.error('[notificacoes count] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- POST /api/notificacoes/marcar-lidas
// Body: { ids: [1,2,3] }  -> marca as informadas como lidas
// Body: {} ou { all: true } -> marca TODAS do usuário como lidas
router.post('/marcar-lidas', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    if (Array.isArray(body.ids) && body.ids.length > 0) {
      // Garante que só marcamos notificações do próprio usuário
      const r = await query(
        `UPDATE moravo.notificacoes
           SET lida = true
         WHERE usuario_id = $1 AND id = ANY($2::bigint[])`,
        [req.user.id, body.ids]
      );
      return res.json({ ok: true, updated: r.rowCount });
    }
    // Marca todas do usuário
    const r = await query(
      'UPDATE moravo.notificacoes SET lida = true WHERE usuario_id = $1 AND lida = false',
      [req.user.id]
    );
    return res.json({ ok: true, updated: r.rowCount });
  } catch (err) {
    console.error('[notificacoes marcar-lidas] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- DELETE /api/notificacoes/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const notifId = req.params.id;
    const r = await query(
      'DELETE FROM moravo.notificacoes WHERE id = $1 AND usuario_id = $2',
      [notifId, req.user.id]
    );
    return res.json({ ok: true, deleted: r.rowCount });
  } catch (err) {
    console.error('[notificacoes DELETE :id] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- DELETE /api/notificacoes (Apagar todas)
router.delete('/', requireAuth, async (req, res) => {
  try {
    const r = await query(
      'DELETE FROM moravo.notificacoes WHERE usuario_id = $1',
      [req.user.id]
    );
    return res.json({ ok: true, deleted: r.rowCount });
  } catch (err) {
    console.error('[notificacoes DELETE all] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

module.exports = router;
