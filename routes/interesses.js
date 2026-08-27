// =========================================================================
// /api/interesses — match entre corretores e imóveis
// =========================================================================
const express = require('express');
const router  = express.Router();
const { query } = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { criarNotificacao } = require('../lib/notifications');
const wa = require('../lib/whatsapp');
const { garantirGrupo } = require('../lib/grupo');

const STATUS_VALIDOS = ['pendente', 'aceito', 'recusado'];

// ---- POST /api/interesses — corretor demonstra interesse em um imóvel
// O ID do imóvel vem na URL, não no body: POST /api/interesses/imovel/:imovelId
router.post('/imovel/:imovelId', requireAuth, requireRole('corretor'), async (req, res) => {
  try {
    const imovelId = parseInt(req.params.imovelId, 10);
    if (!Number.isFinite(imovelId)) {
      return res.status(400).json({ ok: false, error: 'ID de imóvel inválido.' });
    }

    // Confere que o imóvel existe e tá ativo
    const imovelCheck = await query('SELECT id, dono_id, status FROM moravo.imoveis WHERE id = $1', [imovelId]);
    if (imovelCheck.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Imóvel não encontrado.' });
    }
    if (imovelCheck.rows[0].status === 'vendido') {
      return res.status(400).json({ ok: false, error: 'Imóvel já foi vendido.' });
    }
    // Corretor não pode se candidatar ao próprio imóvel
    if (imovelCheck.rows[0].dono_id === req.user.id) {
      return res.status(400).json({ ok: false, error: 'Você é o dono deste imóvel.' });
    }


    // Não permite interesse duplicado do mesmo corretor no mesmo imóvel
    const dup = await query(
      'SELECT id FROM moravo.interesses WHERE imovel_id = $1 AND corretor_id = $2',
      [imovelId, req.user.id]
    );
    if (dup.rowCount > 0) {
      return res.status(409).json({ ok: false, error: 'Você já demonstrou interesse neste imóvel.' });
    }

    const mensagem = (req.body && req.body.mensagem || '').trim() || null;

    // Entra direto na carteira do corretor: não existe mais espera por aceite.
    // O proprietário só é acionado quando chega uma proposta de verdade.
    const result = await query(
      `INSERT INTO moravo.interesses (imovel_id, corretor_id, mensagem, status)
       VALUES ($1, $2, $3, 'aceito')
       RETURNING id, created_at`,
      [imovelId, req.user.id, mensagem]
    );

    // Notifica o dono do imóvel sobre o novo interesse do corretor
    try {
      // Busca o título do imóvel para colocar no payload da notificação
      const imovelTituloRow = await query('SELECT titulo FROM moravo.imoveis WHERE id = $1', [imovelId]);
      const imovelTitulo = imovelTituloRow.rows[0] ? imovelTituloRow.rows[0].titulo : null;
      // Busca o nome do corretor (remetente) para a notificação
      const corretorNomeRow = await query('SELECT nome FROM moravo.usuarios WHERE id = $1', [req.user.id]);
      const corretorNome = corretorNomeRow.rows[0] ? corretorNomeRow.rows[0].nome : null;
      await criarNotificacao({
        usuario_id: imovelCheck.rows[0].dono_id,
        tipo: 'corretor_trabalhando',
        imovel_id: imovelId,
        interesse_id: result.rows[0].id,
        remetente_id: req.user.id,
        payload: {
          imovel_titulo: imovelTitulo,
          corretor_nome: corretorNome,
        },
      });
    } catch (notifErr) {
      console.warn('[interesses POST] falha ao notificar dono:', notifErr.message);
    }

    // O grupo nasce aqui: o corretor precisa falar com o dono para trabalhar o
    // imóvel (visita, chaves, detalhes). Esperar a proposta seria pedir que ele
    // vendesse às cegas. Falha no WhatsApp não desfaz a entrada na carteira.
    let grupo = null;
    try {
      grupo = await garantirGrupo(result.rows[0].id);
    } catch (grupoErr) {
      console.error('[interesses POST] falha ao criar o grupo:', grupoErr.message);
    }

    return res.status(201).json({
      ok: true,
      id: result.rows[0].id,
      created_at: result.rows[0].created_at,
      grupo: grupo,
    });
  } catch (err) {
    if (err.code === '23503') {
      return res.status(400).json({ ok: false, error: 'Imóvel ou corretor não existe.' });
    }
    console.error('[interesses POST] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- GET /api/interesses
// Query params:
//   imovel_id=X   -> corretores interessados no imóvel X (só dono do imóvel)
//   corretor_id=X -> interesses do corretor X (só o próprio corretor)
//   sem param     -> depende do perfil: corretor vê os próprios, proprietario vê os dos seus imóveis
router.get('/', requireAuth, async (req, res) => {
  try {
    const imovelId   = parseInt(req.query.imovel_id,   10);
    const corretorId = parseInt(req.query.corretor_id, 10);
    const limit      = Math.min(parseInt(req.query.limit, 10) || 100, 500);

    // Permissões
    if (Number.isFinite(imovelId)) {
      // Só o dono do imóvel pode ver
      const imovelCheck = await query('SELECT dono_id FROM moravo.imoveis WHERE id = $1', [imovelId]);
      if (imovelCheck.rowCount === 0) return res.status(404).json({ ok: false, error: 'Imóvel não encontrado.' });
      if (imovelCheck.rows[0].dono_id != req.user.id) {
        return res.status(403).json({ ok: false, error: 'Só o dono do imóvel pode ver os interessados.' });
      }
      const r = await query(
        `SELECT i.*, u.nome AS corretor_nome, u.whatsapp AS corretor_whatsapp,
                u.email AS corretor_email, u.creci, u.regiao_atuacao,
                i.grupo_whatsapp_id AS grupo_whatsapp_id,
                i.grupo_whatsapp_link AS grupo_whatsapp_link,
                i.grupo_whatsapp_created_at AS grupo_whatsapp_created_at
         FROM moravo.interesses i
         JOIN moravo.usuarios u ON u.id = i.corretor_id
         WHERE i.imovel_id = $1
         ORDER BY i.created_at DESC`,
        [imovelId]
      );
      return res.json({ ok: true, total: r.rowCount, interesses: r.rows });
    }

    if (Number.isFinite(corretorId)) {
      // Só o próprio corretor
      if (corretorId != req.user.id) {
        return res.status(403).json({ ok: false, error: 'Você só pode ver seus próprios interesses.' });
      }
      const r = await query(
        `SELECT i.*,
                im.titulo AS imovel_titulo,
                im.cidade AS imovel_cidade,
                im.tipo AS imovel_tipo,
                im.fotos AS imovel_fotos,
                im.bairro AS imovel_bairro,
                im.quartos AS imovel_quartos,
                im.banheiros AS imovel_banheiros,
                im.area_m2 AS imovel_area_m2,
                im.vagas AS imovel_vagas,
                im.preco AS imovel_preco,
                im.status AS imovel_status,
                im.interesses_compradores AS imovel_interesses_compradores,
                i.grupo_whatsapp_id AS grupo_whatsapp_id,
                i.grupo_whatsapp_link AS grupo_whatsapp_link,
                i.grupo_whatsapp_created_at AS grupo_whatsapp_created_at
         FROM moravo.interesses i
         JOIN moravo.imoveis im ON im.id = i.imovel_id
         WHERE i.corretor_id = $1
         ORDER BY i.created_at DESC`,
        [corretorId]
      );
      return res.json({ ok: true, total: r.rowCount, interesses: r.rows });
    }

    // Sem filtro: comportamento depende do perfil
    if (req.user.perfil === 'corretor') {
      const r = await query(
        `-- 1. Interessados nos imóveis que este corretor atua (como intermediador)
         SELECT
           ic.id, ic.imovel_id, ic.created_at, 'comprador_rep' AS type,
           im.titulo AS imovel_titulo, im.cidade AS imovel_cidade, im.tipo AS imovel_tipo, im.fotos AS imovel_fotos,
           'comprador' AS other_role,
           u_comp.nome AS other_name, u_comp.whatsapp AS other_whatsapp, u_comp.email AS other_email,
           '' AS other_creci,
           u_comp.foto_perfil AS other_foto_perfil,
           u_corr.foto_perfil AS corretor_foto_perfil,
           'aceito' AS status,
           NULL AS mensagem,
           -- campos legados para retrocompatibilidade
           u_comp.nome AS comprador_nome, u_comp.whatsapp AS comprador_whatsapp, u_comp.email AS comprador_email,
           u_corr.nome AS corretor_nome, u_corr.whatsapp AS corretor_whatsapp, u_corr.email AS corretor_email,
           u_corr.creci,
           NULL::TEXT AS grupo_whatsapp_id,
           NULL::TEXT AS grupo_whatsapp_link,
           NULL::TIMESTAMPTZ AS grupo_whatsapp_created_at
         FROM moravo.interesses_compradores ic
         JOIN moravo.imoveis im ON im.id = ic.imovel_id
         JOIN moravo.usuarios u_comp ON u_comp.id = ic.comprador_id
         JOIN moravo.interesses i ON i.imovel_id = im.id AND i.status = 'aceito'
         JOIN moravo.usuarios u_corr ON u_corr.id = i.corretor_id
         WHERE i.corretor_id = $1

         UNION ALL

         -- 2. Interesses de intermediação com proprietários (todas as propostas)
         SELECT
           i.id, i.imovel_id, i.created_at, 'broker_rep' AS type,
           im.titulo AS imovel_titulo, im.cidade AS imovel_cidade, im.tipo AS imovel_tipo, im.fotos AS imovel_fotos,
           'proprietario' AS other_role,
           u_owner.nome AS other_name, u_owner.whatsapp AS other_whatsapp, u_owner.email AS other_email,
           '' AS other_creci,
           u_owner.foto_perfil AS other_foto_perfil,
           u_corr.foto_perfil AS corretor_foto_perfil,
           i.status,
           i.mensagem,
           -- campos legados para retrocompatibilidade
           u_owner.nome AS comprador_nome, u_owner.whatsapp AS comprador_whatsapp, u_owner.email AS comprador_email,
           u_corr.nome AS corretor_nome, u_corr.whatsapp AS corretor_whatsapp, u_corr.email AS corretor_email,
           u_corr.creci,
           i.grupo_whatsapp_id AS grupo_whatsapp_id,
           i.grupo_whatsapp_link AS grupo_whatsapp_link,
           i.grupo_whatsapp_created_at AS grupo_whatsapp_created_at
         FROM moravo.interesses i
         JOIN moravo.imoveis im ON im.id = i.imovel_id
         JOIN moravo.usuarios u_owner ON u_owner.id = im.dono_id
         JOIN moravo.usuarios u_corr ON u_corr.id = i.corretor_id
         WHERE i.corretor_id = $1

         ORDER BY created_at DESC`,
        [req.user.id]
      );
      return res.json({ ok: true, total: r.rowCount, interesses: r.rows });
    }

    if (req.user.perfil === 'proprietario' || req.user.perfil === 'comprador') {
      const r = await query(
        `-- 1. Minhas demonstrações de interesse como comprador
         SELECT
           ic.id, ic.imovel_id, ic.created_at, 'comprador_sent' AS type,
           im.titulo AS imovel_titulo, im.cidade AS imovel_cidade, im.tipo AS imovel_tipo, im.fotos AS imovel_fotos,
           CASE WHEN u_corr.id IS NOT NULL THEN 'corretor' ELSE 'proprietario' END AS other_role,
           COALESCE(u_corr.nome, u_owner.nome) AS other_name,
           COALESCE(u_corr.whatsapp, u_owner.whatsapp) AS other_whatsapp,
           COALESCE(u_corr.email, u_owner.email) AS other_email,
           COALESCE(u_corr.creci, '') AS other_creci,
           COALESCE(u_corr.foto_perfil, u_owner.foto_perfil) AS other_foto_perfil,
           COALESCE(u_corr.foto_perfil, u_owner.foto_perfil) AS corretor_foto_perfil,
           'aceito' AS status,
           NULL AS mensagem,
           -- campos legados para retrocompatibilidade
           u_comp.nome AS comprador_nome, u_comp.whatsapp AS comprador_whatsapp, u_comp.email AS comprador_email,
           COALESCE(u_corr.nome, u_owner.nome) AS corretor_nome,
           COALESCE(u_corr.whatsapp, u_owner.whatsapp) AS corretor_whatsapp,
           COALESCE(u_corr.email, u_owner.email) AS corretor_email,
           COALESCE(u_corr.creci, '') AS creci,
           NULL::TEXT AS grupo_whatsapp_id,
           NULL::TEXT AS grupo_whatsapp_link,
           NULL::TIMESTAMPTZ AS grupo_whatsapp_created_at
         FROM moravo.interesses_compradores ic
         JOIN moravo.imoveis im ON im.id = ic.imovel_id
         JOIN moravo.usuarios u_owner ON u_owner.id = im.dono_id
         JOIN moravo.usuarios u_comp ON u_comp.id = ic.comprador_id
         LEFT JOIN moravo.interesses i ON i.imovel_id = im.id AND i.status = 'aceito'
         LEFT JOIN moravo.usuarios u_corr ON u_corr.id = i.corretor_id
         WHERE ic.comprador_id = $1

         UNION ALL

         -- 2. Interesses de compradores direto nos meus imóveis (quando NÃO tem corretor associado)
         SELECT
           ic.id, ic.imovel_id, ic.created_at, 'comprador_received' AS type,
           im.titulo AS imovel_titulo, im.cidade AS imovel_cidade, im.tipo AS imovel_tipo, im.fotos AS imovel_fotos,
           'comprador' AS other_role,
           u_comp.nome AS other_name, u_comp.whatsapp AS other_whatsapp, u_comp.email AS other_email,
           '' AS other_creci,
           u_comp.foto_perfil AS other_foto_perfil,
           u_owner.foto_perfil AS corretor_foto_perfil,
           'aceito' AS status,
           NULL AS mensagem,
           -- campos legados para retrocompatibilidade
           u_comp.nome AS comprador_nome, u_comp.whatsapp AS comprador_whatsapp, u_comp.email AS comprador_email,
           u_owner.nome AS corretor_nome, u_owner.whatsapp AS corretor_whatsapp, u_owner.email AS corretor_email,
           '' AS creci,
           NULL::TEXT AS grupo_whatsapp_id,
           NULL::TEXT AS grupo_whatsapp_link,
           NULL::TIMESTAMPTZ AS grupo_whatsapp_created_at
         FROM moravo.interesses_compradores ic
         JOIN moravo.imoveis im ON im.id = ic.imovel_id
         JOIN moravo.usuarios u_owner ON u_owner.id = im.dono_id
         JOIN moravo.usuarios u_comp ON u_comp.id = ic.comprador_id
         WHERE im.dono_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM moravo.interesses i WHERE i.imovel_id = im.id AND i.status = 'aceito'
           )

         UNION ALL

         -- 3. Interesses de intermediação com corretores (todas as propostas)
         SELECT
           i.id, i.imovel_id, i.created_at, 'broker_rep' AS type,
           im.titulo AS imovel_titulo, im.cidade AS imovel_cidade, im.tipo AS imovel_tipo, im.fotos AS imovel_fotos,
           'corretor' AS other_role,
           u_corr.nome AS other_name, u_corr.whatsapp AS other_whatsapp, u_corr.email AS other_email,
           u_corr.creci AS other_creci,
           u_corr.foto_perfil AS other_foto_perfil,
           u_corr.foto_perfil AS corretor_foto_perfil,
           i.status,
           i.mensagem,
           -- campos legados para retrocompatibilidade
           u_owner.nome AS comprador_nome, u_owner.whatsapp AS comprador_whatsapp, u_owner.email AS comprador_email,
           u_corr.nome AS corretor_nome, u_corr.whatsapp AS corretor_whatsapp, u_corr.email AS corretor_email,
           u_corr.creci AS creci,
           i.grupo_whatsapp_id AS grupo_whatsapp_id,
           i.grupo_whatsapp_link AS grupo_whatsapp_link,
           i.grupo_whatsapp_created_at AS grupo_whatsapp_created_at
         FROM moravo.interesses i
         JOIN moravo.imoveis im ON im.id = i.imovel_id
         JOIN moravo.usuarios u_owner ON u_owner.id = im.dono_id
         JOIN moravo.usuarios u_corr ON u_corr.id = i.corretor_id
         WHERE im.dono_id = $1

         ORDER BY created_at DESC`,
        [req.user.id]
      );
      return res.json({ ok: true, total: r.rowCount, interesses: r.rows });
    }

    // Para outros perfis (como compradores legados ou novos perfis sem interesses de corretagem)
    return res.json({ ok: true, total: 0, interesses: [] });
  } catch (err) {
    console.error('[interesses GET] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- POST /api/interesses/aceitar-todos — dono do imóvel aceita todas as candidaturas pendentes
router.post('/aceitar-todos', requireAuth, requireRole('proprietario'), async (req, res) => {
  try {
    // 1. Busca todas as candidaturas pendentes de corretores nos imóveis deste dono
    const pendentes = await query(
      `SELECT i.id, i.corretor_id, i.imovel_id, im.titulo AS imovel_titulo
       FROM moravo.interesses i
       JOIN moravo.imoveis im ON im.id = i.imovel_id
       WHERE im.dono_id = $1 AND i.status = 'pendente'`,
      [req.user.id]
    );

    if (pendentes.rowCount === 0) {
      return res.json({ ok: true, message: 'Nenhuma candidatura pendente encontrada.', count: 0 });
    }

    // 2. Atualiza todas as candidaturas para 'aceito'
    await query(
      `UPDATE moravo.interesses i
       SET status = 'aceito'
       FROM moravo.imoveis im
       WHERE i.imovel_id = im.id AND im.dono_id = $1 AND i.status = 'pendente'`,
      [req.user.id]
    );

    // 3. Cria as notificações para cada um dos corretores aceitos
    for (const p of pendentes.rows) {
      try {
        await criarNotificacao({
          usuario_id: p.corretor_id,
          tipo: 'corretor_escolhido',
          imovel_id: p.imovel_id,
          interesse_id: p.id,
          remetente_id: req.user.id,
          payload: {
            imovel_titulo: p.imovel_titulo,
          },
        });
      } catch (notifErr) {
        console.warn('[interesses aceitar-todos] falha ao notificar corretor:', p.corretor_id, notifErr.message);
      }
    }

    return res.json({ ok: true, message: `${pendentes.rowCount} proposta(s) aceita(s) com sucesso.`, count: pendentes.rowCount });
  } catch (err) {
    console.error('[interesses aceitar-todos] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- PATCH /api/interesses/:id — dono do imóvel muda status (aceita/recusa)
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'ID inválido.' });

    const novoStatus = (req.body && req.body.status || '').toLowerCase();
    if (STATUS_VALIDOS.indexOf(novoStatus) === -1) {
      return res.status(400).json({ ok: false, error: 'Status inválido.' });
    }

    // Verifica permissão: precisa ser dono do imóvel do interesse
    // E traz dados do interesse + imovel pra montar as notificações
    const check = await query(
      `SELECT i.id, i.imovel_id, i.corretor_id, i.status AS status_atual,
              im.titulo AS imovel_titulo, im.dono_id
       FROM moravo.interesses i
       JOIN moravo.imoveis im ON im.id = i.imovel_id
       WHERE i.id = $1`,
      [id]
    );
    if (check.rowCount === 0) return res.status(404).json({ ok: false, error: 'Interesse não encontrado.' });
    if (check.rows[0].dono_id !== req.user.id) {
      return res.status(403).json({ ok: false, error: 'Só o dono do imóvel pode mudar o status.' });
    }

    const imovelId = check.rows[0].imovel_id;
    const corretorId = check.rows[0].corretor_id;
    const imovelTitulo = check.rows[0].imovel_titulo;

    const r = await query(
      `UPDATE moravo.interesses SET status = $1 WHERE id = $2 RETURNING *`,
      [novoStatus, id]
    );
    const updated = r.rows[0];

    // ---- Efeitos colaterais: notificações
    if (novoStatus === 'aceito') {
      // Notifica o corretor que foi aceito
      await criarNotificacao({
        usuario_id: corretorId,
        tipo: 'corretor_escolhido',
        imovel_id: imovelId,
        interesse_id: id,
        remetente_id: req.user.id,
        payload: {
          imovel_titulo: imovelTitulo,
        },
      });
    } else if (novoStatus === 'recusado') {
      // Notifica o corretor que foi recusado (caso de recusa manual do dono)
      await criarNotificacao({
        usuario_id: corretorId,
        tipo: 'corretor_recusado',
        imovel_id: imovelId,
        interesse_id: id,
        remetente_id: req.user.id,
        payload: {
          imovel_titulo: imovelTitulo,
          motivo: 'recusa_manual',
        },
      });
    }
    // Para status='pendente' (reverter aceitação) não há efeito colateral além do UPDATE

    return res.json({ ok: true, interesse: updated });
  } catch (err) {
    console.error('[interesses PATCH] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- DELETE /api/interesses/:id — corretor deixa de representar / cancela interesse
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: 'ID inválido.' });

    // Busca o interesse + dados do imóvel + dono para a notificação
    const check = await query(
      `SELECT i.id, i.corretor_id, i.imovel_id, i.status, im.dono_id, im.titulo AS imovel_titulo
         FROM moravo.interesses i
         JOIN moravo.imoveis im ON im.id = i.imovel_id
        WHERE i.id = $1`,
      [id]
    );
    if (check.rowCount === 0) return res.status(404).json({ ok: false, error: 'Interesse não encontrado.' });
    if (check.rows[0].corretor_id !== req.user.id) {
      return res.status(403).json({ ok: false, error: 'Você só pode remover seu próprio interesse/representação.' });
    }

    const imovelId = check.rows[0].imovel_id;
    const donoId = check.rows[0].dono_id;
    const imovelTitulo = check.rows[0].imovel_titulo;
    const statusAnterior = check.rows[0].status;

    await query('DELETE FROM moravo.interesses WHERE id = $1', [id]);
    console.log('[interesses DELETE] removido id=' + id + ' corretor=' + req.user.id + ' statusAnterior=' + statusAnterior);

    // Se o corretor estava representando (status='aceito'), notifica o dono da renúncia
    if (statusAnterior === 'aceito' && donoId) {
      try {
        const corretorRow = await query('SELECT nome FROM moravo.usuarios WHERE id = $1', [req.user.id]);
        const corretorNome = corretorRow.rows[0] ? corretorRow.rows[0].nome : null;
        await criarNotificacao({
          usuario_id: donoId,
          tipo: 'corretor_renunciou',
          imovel_id: imovelId,
          remetente_id: req.user.id,
          payload: {
            imovel_titulo: imovelTitulo,
            corretor_nome: corretorNome,
          },
        });
      } catch (notifErr) {
        console.warn('[interesses DELETE] falha ao notificar dono:', notifErr.message);
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[interesses DELETE] erro:', err);
    return res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
  }
});

// ---- POST /api/interesses/:id/criar-grupo-whatsapp
// Cria (ou recupera) um grupo de WhatsApp no Waha com:
//   - Proprietário (vendedor)
//   - Corretor
//   - Atendente principal (número fixo configurado no .env)
//
// Pode ser chamado tanto pelo corretor do interesse quanto pelo dono do imóvel.
// Só funciona se o status for 'aceito'. Se o grupo já existe, retorna o link (idempotente).
router.post('/:id/criar-grupo-whatsapp', requireAuth, async (req, res) => {
  const interesseId = parseInt(req.params.id, 10);
  if (!Number.isFinite(interesseId)) {
    return res.status(400).json({ ok: false, error: 'ID de interesse inválido.' });
  }

  try {
    // Permissão: só o corretor do interesse ou o dono do imóvel
    const dono = await query(
      `SELECT i.corretor_id, im.dono_id
         FROM moravo.interesses i
         JOIN moravo.imoveis im ON im.id = i.imovel_id
        WHERE i.id = $1`,
      [interesseId]
    );
    if (dono.rowCount === 0) {
      return res.status(404).json({ ok: false, error: 'Interesse não encontrado.' });
    }
    const linha = dono.rows[0];
    if (linha.corretor_id !== req.user.id && linha.dono_id !== req.user.id) {
      return res.status(403).json({ ok: false, error: 'Você não tem permissão para este interesse.' });
    }

    // Toda a criação vive em lib/grupo.js. Esta rota tinha uma cópia da lógica
    // que lia process.env direto e por isso ignorava a configuração do painel.
    const grupo = await garantirGrupo(interesseId);
    return res.json({
      ok: true,
      grupo_link: grupo.grupo_link,
      grupo_id: grupo.grupo_id,
      ja_existia: grupo.ja_existia,
      envios: grupo.envios,
    });
  } catch (err) {
    console.error('[criar-grupo-whatsapp] erro:', err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }
});

module.exports = router;
