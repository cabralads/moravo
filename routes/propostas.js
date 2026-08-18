// =========================================================================
// /api/propostas — proposta de compra enviada pelo corretor ao proprietário
// =========================================================================
// É a proposta que move a negociação: ao ser enviada, o grupo de WhatsApp
// é criado (ou reaproveitado) e o proprietário é notificado. Antes disso o
// corretor trabalha o imóvel sozinho, sem incomodar ninguém.
// =========================================================================
const express = require('express');
const router  = express.Router();
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { criarNotificacao } = require('../lib/notifications');
const { garantirGrupo } = require('../lib/grupo');

const FORMAS = ['a_vista', 'financiado', 'permuta', 'a_combinar'];

function moeda(v) {
  return Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

// ---- POST /api/propostas — só corretor, e só de imóvel que está na carteira dele
router.post('/', requireAuth, requireRole('corretor'), async (req, res) => {
  try {
    const b = req.body || {};
    const imovelId = parseInt(b.imovel_id, 10);
    if (!Number.isFinite(imovelId)) {
      return res.status(400).json({ ok: false, error: 'Informe o imóvel.' });
    }

    const valor = Number(b.valor);
    if (!Number.isFinite(valor) || valor <= 0) {
      return res.status(400).json({ ok: false, error: 'Informe um valor válido para a proposta.' });
    }

    const forma = (b.forma_pagamento || 'a_combinar').toLowerCase();
    if (FORMAS.indexOf(forma) === -1) {
      return res.status(400).json({ ok: false, error: 'Forma de pagamento inválida.' });
    }

    const entrada = (b.entrada != null && b.entrada !== '') ? Number(b.entrada) : null;
    if (entrada != null && (!Number.isFinite(entrada) || entrada < 0)) {
      return res.status(400).json({ ok: false, error: 'Valor de entrada inválido.' });
    }

    // O imóvel precisa estar na carteira do corretor
    const carteira = await query(
      `SELECT i.id AS interesse_id, im.dono_id, im.titulo, im.status
         FROM moravo.interesses i
         JOIN moravo.imoveis im ON im.id = i.imovel_id
        WHERE i.imovel_id = $1 AND i.corretor_id = $2 AND i.status = 'aceito'`,
      [imovelId, req.user.id]
    );
    if (carteira.rowCount === 0) {
      return res.status(403).json({
        ok: false,
        error: 'Adicione o imóvel à sua carteira antes de enviar uma proposta.',
      });
    }
    const ctx = carteira.rows[0];
    if (ctx.status === 'vendido') {
      return res.status(400).json({ ok: false, error: 'Este imóvel já foi vendido.' });
    }

    const inserida = await query(
      `INSERT INTO moravo.propostas
         (imovel_id, corretor_id, interesse_id, valor, forma_pagamento, entrada,
          comprador_nome, observacoes, validade)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, created_at`,
      [
        imovelId, req.user.id, ctx.interesse_id, valor, forma, entrada,
        (b.comprador_nome || '').trim() || null,
        (b.observacoes || '').trim() || null,
        b.validade || null,
      ]
    );
    const proposta = inserida.rows[0];

    // Notifica o proprietário. É a proposta que merece a atenção dele.
    try {
      const corretor = await query('SELECT nome, creci FROM moravo.usuarios WHERE id = $1', [req.user.id]);
      await criarNotificacao({
        usuario_id: ctx.dono_id,
        tipo: 'proposta_recebida',
        imovel_id: imovelId,
        interesse_id: ctx.interesse_id,
        remetente_id: req.user.id,
        payload: {
          proposta_id: proposta.id,
          imovel_titulo: ctx.titulo,
          corretor_nome: corretor.rows[0] ? corretor.rows[0].nome : null,
          valor: valor,
        },
      });
    } catch (e) {
      console.warn('[propostas POST] falha ao notificar proprietário:', e.message);
    }

    // Agora sim: cria o grupo e convida as duas partes.
    // Se o WhatsApp falhar, a proposta continua registrada.
    let grupo = null;
    try {
      grupo = await garantirGrupo(ctx.interesse_id);
      await query('UPDATE moravo.propostas SET grupo_criado = true WHERE id = $1', [proposta.id]);
    } catch (e) {
      console.error('[propostas POST] falha ao criar grupo:', e.message);
    }

    return res.status(201).json({
      ok: true,
      id: proposta.id,
      created_at: proposta.created_at,
      grupo: grupo,
      resumo: `${moeda(valor)} · ${forma.replace('_', ' ')}`,
    });
  } catch (err) {
    console.error('[propostas POST] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- GET /api/propostas
// corretor -> as que ele enviou | proprietário -> as que recebeu
router.get('/', requireAuth, async (req, res) => {
  try {
    const imovelId = parseInt(req.query.imovel_id, 10);
    const filtroImovel = Number.isFinite(imovelId) ? ' AND p.imovel_id = $2' : '';
    const params = Number.isFinite(imovelId) ? [req.user.id, imovelId] : [req.user.id];

    const base = `
      SELECT p.*, im.titulo AS imovel_titulo, im.cidade AS imovel_cidade,
             im.bairro AS imovel_bairro, im.preco AS imovel_preco, im.fotos AS imovel_fotos,
             c.nome AS corretor_nome, c.creci AS corretor_creci, c.whatsapp AS corretor_whatsapp,
             d.nome AS dono_nome,
             i.grupo_whatsapp_link
        FROM moravo.propostas p
        JOIN moravo.imoveis  im ON im.id = p.imovel_id
        JOIN moravo.usuarios  c ON c.id  = p.corretor_id
        JOIN moravo.usuarios  d ON d.id  = im.dono_id
        LEFT JOIN moravo.interesses i ON i.id = p.interesse_id`;

    const where = req.user.perfil === 'corretor'
      ? 'WHERE p.corretor_id = $1'
      : 'WHERE im.dono_id = $1';

    const r = await query(`${base} ${where}${filtroImovel} ORDER BY p.created_at DESC LIMIT 200`, params);
    return res.json({ ok: true, total: r.rowCount, propostas: r.rows });
  } catch (err) {
    console.error('[propostas GET] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- PATCH /api/propostas/:id  { status: 'aceita'|'recusada', motivo }
// Só o dono do imóvel responde.
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'ID inválido.' });

    const novo = (req.body && req.body.status || '').toLowerCase();
    if (['aceita', 'recusada'].indexOf(novo) === -1) {
      return res.status(400).json({ ok: false, error: 'Status inválido. Use aceita ou recusada.' });
    }

    const r = await query(
      `SELECT p.id, p.corretor_id, p.imovel_id, p.valor, p.status,
              im.dono_id, im.titulo
         FROM moravo.propostas p
         JOIN moravo.imoveis im ON im.id = p.imovel_id
        WHERE p.id = $1`,
      [id]
    );
    if (r.rowCount === 0) return res.status(404).json({ ok: false, error: 'Proposta não encontrada.' });
    const p = r.rows[0];

    if (p.dono_id !== req.user.id) {
      return res.status(403).json({ ok: false, error: 'Só o proprietário do imóvel responde a proposta.' });
    }
    if (p.status !== 'enviada') {
      return res.status(400).json({ ok: false, error: 'Esta proposta já foi respondida.' });
    }

    const motivo = (req.body && req.body.motivo || '').trim() || null;
    await query(
      `UPDATE moravo.propostas
          SET status = $1, resposta_motivo = $2, respondido_em = NOW()
        WHERE id = $3`,
      [novo, motivo, id]
    );

    try {
      await criarNotificacao({
        usuario_id: p.corretor_id,
        tipo: novo === 'aceita' ? 'proposta_aceita' : 'proposta_recusada',
        imovel_id: p.imovel_id,
        remetente_id: req.user.id,
        payload: { proposta_id: p.id, imovel_titulo: p.titulo, valor: p.valor, motivo: motivo },
      });
    } catch (e) {
      console.warn('[propostas PATCH] falha ao notificar corretor:', e.message);
    }

    return res.json({ ok: true, status: novo });
  } catch (err) {
    console.error('[propostas PATCH] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- DELETE /api/propostas/:id — corretor cancela a própria proposta
router.delete('/:id', requireAuth, requireRole('corretor'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'ID inválido.' });

    const r = await query('SELECT corretor_id, status FROM moravo.propostas WHERE id = $1', [id]);
    if (r.rowCount === 0) return res.status(404).json({ ok: false, error: 'Proposta não encontrada.' });
    if (r.rows[0].corretor_id !== req.user.id) {
      return res.status(403).json({ ok: false, error: 'Você só cancela suas próprias propostas.' });
    }
    if (r.rows[0].status !== 'enviada') {
      return res.status(400).json({ ok: false, error: 'Só dá para cancelar proposta ainda não respondida.' });
    }

    await query(`UPDATE moravo.propostas SET status = 'cancelada' WHERE id = $1`, [id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[propostas DELETE] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

module.exports = router;
