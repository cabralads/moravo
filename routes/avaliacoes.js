// =========================================================================
// /api/avaliacoes — nota de 1 a 5 que o proprietário dá ao corretor
// =========================================================================
// É o começo do ranking: hoje aparece como estrelas no painel, e amanhã
// ordena a fila de quem recebe comprador (lib/atendimento.js já lê a média).
//
// Só avalia quem trabalhou com você: a nota precisa vir de quem viu o serviço,
// senão ela vira opinião de quem nunca trocou uma palavra com o corretor.
// =========================================================================
const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');

// ---- POST /api/avaliacoes — cria ou atualiza a nota
router.post('/', requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const corretorId = parseInt(b.corretor_id, 10);
    const imovelId   = parseInt(b.imovel_id, 10);
    const nota       = parseInt(b.nota, 10);
    const comentario = (b.comentario || '').trim().slice(0, 1000) || null;

    if (!Number.isFinite(corretorId)) return res.status(400).json({ ok: false, error: 'Corretor inválido.' });
    if (!Number.isFinite(imovelId))   return res.status(400).json({ ok: false, error: 'Imóvel inválido.' });
    if (!(nota >= 1 && nota <= 5))    return res.status(400).json({ ok: false, error: 'A nota vai de 1 a 5.' });
    if (corretorId === req.user.id)   return res.status(400).json({ ok: false, error: 'Você não pode avaliar a si mesmo.' });

    // Duas condições, e as duas importam: o imóvel tem que ser seu, e o
    // corretor tem que ter trabalhado nele.
    const vinculo = await query(
      `SELECT 1
         FROM moravo.imoveis im
         JOIN moravo.interesses i ON i.imovel_id = im.id AND i.corretor_id = $1
        WHERE im.id = $2 AND im.dono_id = $3
        LIMIT 1`,
      [corretorId, imovelId, req.user.id]
    );
    if (vinculo.rowCount === 0) {
      return res.status(403).json({
        ok: false,
        error: 'Você só avalia corretores que trabalharam um imóvel seu.',
      });
    }

    const r = await query(
      `INSERT INTO moravo.avaliacoes_corretor (corretor_id, autor_id, imovel_id, nota, comentario)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (corretor_id, autor_id, imovel_id)
       DO UPDATE SET nota = EXCLUDED.nota, comentario = EXCLUDED.comentario, updated_at = NOW()
       RETURNING id, nota, comentario, updated_at`,
      [corretorId, req.user.id, imovelId, nota, comentario]
    );
    return res.json({ ok: true, avaliacao: r.rows[0] });
  } catch (err) {
    console.error('[avaliacoes POST] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- GET /api/avaliacoes/corretor/:id — média pública do corretor
router.get('/corretor/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'Corretor inválido.' });

    const r = await query(
      `SELECT ROUND(AVG(nota)::numeric, 2) AS media, COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE nota = 5)::int AS n5,
              COUNT(*) FILTER (WHERE nota = 4)::int AS n4,
              COUNT(*) FILTER (WHERE nota = 3)::int AS n3,
              COUNT(*) FILTER (WHERE nota = 2)::int AS n2,
              COUNT(*) FILTER (WHERE nota = 1)::int AS n1
         FROM moravo.avaliacoes_corretor WHERE corretor_id = $1`,
      [id]
    );
    // Comentário sai com o primeiro nome apenas: a nota é pública, quem deu
    // não precisa ser.
    const comentarios = await query(
      `SELECT a.nota, a.comentario, a.updated_at,
              split_part(u.nome, ' ', 1) AS autor
         FROM moravo.avaliacoes_corretor a
         JOIN moravo.usuarios u ON u.id = a.autor_id
        WHERE a.corretor_id = $1 AND COALESCE(a.comentario, '') <> ''
        ORDER BY a.updated_at DESC LIMIT 20`,
      [id]
    );
    return res.json({ ok: true, resumo: r.rows[0], comentarios: comentarios.rows });
  } catch (err) {
    console.error('[avaliacoes GET corretor] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- GET /api/avaliacoes/minhas?imovel_id= — o que EU já avaliei
// Serve para a tela abrir com as estrelas já marcadas em vez de vazias.
router.get('/minhas', requireAuth, async (req, res) => {
  try {
    const imovelId = parseInt(req.query.imovel_id, 10);
    const params = [req.user.id];
    let filtro = '';
    if (Number.isFinite(imovelId)) { params.push(imovelId); filtro = 'AND imovel_id = $2'; }

    const r = await query(
      `SELECT corretor_id, imovel_id, nota, comentario, updated_at
         FROM moravo.avaliacoes_corretor
        WHERE autor_id = $1 ${filtro}`,
      params
    );
    return res.json({ ok: true, avaliacoes: r.rows });
  } catch (err) {
    console.error('[avaliacoes GET minhas] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

module.exports = router;
