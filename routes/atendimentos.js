// =========================================================================
// /api/atendimentos — o comprador que caiu para o corretor
// =========================================================================
// Do outro lado está o proprietário do imóvel, que não participa deste grupo:
// aqui é comprador + corretor + atendente. Ver "Atendimento do comprador" no
// CLAUDE.md para o porquê de ser um corretor só.
// =========================================================================
const express = require('express');
const router = express.Router();
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const horario = require('../lib/horario-comercial');
const { PRAZO_MINUTOS } = require('../lib/atendimento');

// ---- GET /api/atendimentos/meus — o que está na mão deste corretor
router.get('/meus', requireAuth, requireRole('corretor'), async (req, res) => {
  try {
    const r = await query(
      `SELECT ic.id, ic.status, ic.atribuido_em, ic.entrou_em, ic.rodada,
              ic.grupo_whatsapp_link,
              im.id AS imovel_id, im.codigo AS imovel_codigo, im.titulo AS imovel_titulo,
              im.tipo AS imovel_tipo, im.preco, im.cidade, im.uf, im.bairro,
              u.nome AS comprador_nome,
              cg.token AS meu_token
         FROM moravo.interesses_compradores ic
         JOIN moravo.imoveis  im ON im.id = ic.imovel_id
         JOIN moravo.usuarios  u ON u.id  = ic.comprador_id
         LEFT JOIN moravo.convites_grupo cg
                ON cg.atendimento_id = ic.id
               AND cg.usuario_id = ic.corretor_id
               AND cg.revogado = false
        WHERE ic.corretor_id = $1
          AND ic.status IN ('aguardando_corretor', 'com_corretor')
        ORDER BY ic.atribuido_em DESC NULLS LAST
        LIMIT 100`,
      [req.user.id]
    );

    // O prazo é contado em minutos úteis, então "faltam 40 minutos" pode
    // significar segunda de manhã se agora for sábado à noite. Quem sabe
    // disso é o servidor; a tela só mostra.
    const atendimentos = r.rows.map((a) => {
      const usados = a.atribuido_em
        ? horario.minutosUteisEntre(new Date(a.atribuido_em), new Date())
        : 0;
      const restam = Math.max(0, PRAZO_MINUTOS - usados);
      return Object.assign({}, a, {
        aguardando: a.status === 'aguardando_corretor',
        minutos_restantes: a.entrou_em ? null : restam,
        expediente_aberto: horario.dentroDoExpediente(new Date()),
        link_grupo: a.meu_token ? '/linkgrupo/' + a.meu_token : null,
        meu_token: undefined,
      });
    });

    return res.json({ ok: true, total: atendimentos.length, atendimentos });
  } catch (err) {
    console.error('[atendimentos GET meus] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

module.exports = router;
