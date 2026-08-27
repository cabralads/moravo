// =========================================================================
// Criação do grupo de WhatsApp da negociação
// =========================================================================
// Antes isso vivia dentro da rota de interesses. Passou para cá porque o
// gatilho mudou: o grupo não nasce mais quando o proprietário aceita o
// corretor, e sim quando existe uma PROPOSTA de verdade na mesa.
//
// Fluxo: o Waha cria o grupo apenas com os números da Moravo e a Cloud API
// oficial envia o convite para proprietário e corretor.
// =========================================================================
const crypto = require('crypto');
const { query } = require('../db');
const { criarNotificacao } = require('./notifications');
const { criarGrupo, montarLinkGrupo, extrairIdGrupo, gerarInviteGrupo } = require('./waha');
const wa = require('./whatsapp');

// ---- Token nominal de convite.
// O que vai no link NÃO é o código do grupo: é um token aleatório amarrado a
// (interesse, pessoa). Isso impede que alguém adivinhe o endereço, permite
// saber quem abriu e revogar um convite sem mexer no outro.
// Idempotente: reemitir para a mesma pessoa devolve o token que já existe.
async function emitirToken(interesseId, usuarioId, papel) {
  const existente = await query(
    `SELECT token FROM moravo.convites_grupo
      WHERE interesse_id = $1 AND usuario_id = $2 AND revogado = false`,
    [interesseId, usuarioId]
  );
  if (existente.rowCount) return existente.rows[0].token;

  const token = crypto.randomBytes(16).toString('hex');
  await query(
    `INSERT INTO moravo.convites_grupo (token, interesse_id, usuario_id, papel)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (interesse_id, usuario_id) DO UPDATE
       SET token = EXCLUDED.token, revogado = false`,
    [token, interesseId, usuarioId, papel]
  );
  return token;
}

// ---- Envia o convite para as duas partes e registra cada tentativa
async function enviarConvites(interesse, grupoLink) {
  const codigo = wa.extrairCodigoConvite(grupoLink);
  const config = await wa.getConfig().catch(() => null);
  const template = (config && config.template_nome) || 'link_grupo_convite';

  // Identificação do imóvel: título mais o número, que é o que o suporte usa
  const imovel = (interesse.imovel_titulo || 'seu imóvel') +
                 (interesse.imovel_id ? ' (imóvel ' + interesse.imovel_id + ')' : '');
  const primeiro = (n) => String(n || '').trim().split(/\s+/)[0] || 'Olá';

  // As variáveis do corpo mudam por destinatário, na ordem do template cadastrado
  const destinatarios = [
    {
      id: interesse.dono_id, papel: 'proprietario',
      telefone: interesse.dono_whatsapp, nome: interesse.dono_nome,
      template: (config && config.template_nome) || template,
      variaveis: [primeiro(interesse.dono_nome), interesse.corretor_nome || 'o corretor', imovel],
    },
    {
      id: interesse.corretor_id, papel: 'corretor',
      telefone: interesse.corretor_whatsapp, nome: interesse.corretor_nome,
      template: (config && config.template_corretor) || (config && config.template_nome) || template,
      variaveis: [primeiro(interesse.corretor_nome), imovel, interesse.dono_nome || 'o proprietário'],
    },
  ];

  const resultados = [];
  for (const d of destinatarios) {
    const base = {
      interesse_id: interesse.id,
      destinatario_id: d.id,
      papel: d.papel,
      telefone: d.telefone,
      template: d.template,
      codigo_convite: codigo,
    };

    if (!codigo) {
      const erro = 'Não foi possível extrair o código do convite a partir do link do grupo.';
      await wa.registrarEnvio(Object.assign({}, base, { status: 'falhou', erro: erro }));
      resultados.push({ papel: d.papel, ok: false, erro: erro });
      continue;
    }

    try {
      // O link enviado carrega o token da pessoa, nunca o código do grupo
      const token = await emitirToken(interesse.id, d.id, d.papel);
      const envio = await wa.enviarTemplateConvite({
        telefone: d.telefone, codigoConvite: token,
        variaveis: d.variaveis, template: d.template,
      });
      await wa.registrarEnvio(Object.assign({}, base, { status: 'enviado', wamid: envio.wamid }));
      resultados.push({ papel: d.papel, ok: true, wamid: envio.wamid });
    } catch (err) {
      await wa.registrarEnvio(Object.assign({}, base, { status: 'falhou', erro: err.message }));
      resultados.push({ papel: d.papel, ok: false, erro: err.message });
      console.error(`[grupo] convite falhou para ${d.papel}: ${err.message}`);
    }
  }

  const falhas = resultados.filter((r) => !r.ok);
  if (falhas.length) {
    try {
      const admins = await query(`SELECT id FROM moravo.usuarios WHERE perfil = 'admin'`);
      for (const a of admins.rows) {
        await criarNotificacao({
          usuario_id: a.id,
          tipo: 'envio_whatsapp_falhou',
          imovel_id: interesse.imovel_id,
          interesse_id: interesse.id,
          payload: {
            imovel_titulo: interesse.imovel_titulo,
            falhas: falhas.map((f) => ({ papel: f.papel, erro: f.erro })),
          },
        });
      }
    } catch (notifErr) {
      console.warn('[grupo] falha ao notificar admins:', notifErr.message);
    }
  }

  return resultados;
}

// ---- Garante que existe grupo para o interesse. Idempotente.
// Devolve { grupo_id, grupo_link, ja_existia, envios }.
async function garantirGrupo(interesseId) {
  const r = await query(
    `SELECT i.id, i.imovel_id, i.corretor_id,
            i.grupo_whatsapp_id, i.grupo_whatsapp_link,
            im.titulo AS imovel_titulo, im.id AS imovel_id, im.dono_id,
            u_dono.nome AS dono_nome, u_dono.whatsapp AS dono_whatsapp,
            u_corr.nome AS corretor_nome, u_corr.whatsapp AS corretor_whatsapp
       FROM moravo.interesses i
       JOIN moravo.imoveis   im     ON im.id = i.imovel_id
       JOIN moravo.usuarios  u_dono ON u_dono.id = im.dono_id
       JOIN moravo.usuarios  u_corr ON u_corr.id = i.corretor_id
      WHERE i.id = $1`,
    [interesseId]
  );
  if (r.rowCount === 0) throw new Error('Interesse não encontrado.');
  const it = r.rows[0];

  if (!it.dono_whatsapp || !it.corretor_whatsapp) {
    throw new Error('WhatsApp do proprietário ou do corretor não está cadastrado.');
  }

  // Já existe grupo com link de convite válido: reaproveita e reenvia o convite
  const linkAtual = it.grupo_whatsapp_link;
  if (linkAtual && !linkAtual.startsWith('https://wa.me/')) {
    const envios = await enviarConvites(it, linkAtual);
    return { grupo_id: it.grupo_whatsapp_id, grupo_link: linkAtual, ja_existia: true, envios };
  }

  const atendente = (process.env.WAHA_ATENDENTE_PRINCIPAL || '').replace(/\D/g, '');
  if (!atendente) throw new Error('WAHA_ATENDENTE_PRINCIPAL não configurado no servidor.');

  // Grupo existente sem link utilizável: tenta só regenerar o convite
  if (it.grupo_whatsapp_id) {
    const invite = await gerarInviteGrupo(it.grupo_whatsapp_id).catch(() => '');
    if (invite && !invite.startsWith('https://wa.me/')) {
      await query(`UPDATE moravo.interesses SET grupo_whatsapp_link = $1 WHERE id = $2`, [invite, it.id]);
      const envios = await enviarConvites(it, invite);
      return { grupo_id: it.grupo_whatsapp_id, grupo_link: invite, ja_existia: true, envios };
    }
  }

  // Cria o grupo. Ninguém é adicionado à força: só os números da Moravo.
  const internos = (process.env.WAHA_PARTICIPANTES_EXTRA || '')
    .split(',').map((n) => n.replace(/\D/g, '')).filter(Boolean);

  const resultado = await criarGrupo({
    nome: `Moravo - ${it.imovel_titulo}`,
    descricao: `Negociação do imóvel "${it.imovel_titulo}". Proprietário: ${it.dono_nome}. Corretor: ${it.corretor_nome}.`,
    participantes: [atendente].concat(internos),
  });

  const grupoId = extrairIdGrupo(resultado);
  let grupoLink = montarLinkGrupo(resultado);
  if (!grupoLink || grupoLink.startsWith('https://wa.me/')) {
    const invite = await gerarInviteGrupo(grupoId).catch(() => '');
    if (invite) grupoLink = invite;
  }

  await query(
    `UPDATE moravo.interesses
        SET grupo_whatsapp_id = $1, grupo_whatsapp_link = $2, grupo_whatsapp_created_at = NOW()
      WHERE id = $3`,
    [grupoId, grupoLink, it.id]
  );

  const envios = await enviarConvites(it, grupoLink);
  return { grupo_id: grupoId, grupo_link: grupoLink, ja_existia: false, envios };
}

module.exports = { garantirGrupo, enviarConvites, emitirToken };
