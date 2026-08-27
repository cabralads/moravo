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
const { criarGrupo, montarLinkGrupo, extrairIdGrupo, gerarInviteGrupo, definirFotoGrupo, renomearGrupo, config: configWaha } = require('./waha');
const wa = require('./whatsapp');
const { nomeGrupo, nomeGrupoComprador } = require('./codigo-imovel');

// ---- Registro da tentativa de criar o grupo.
// Guarda a etapa em que parou, para o painel mostrar o que aconteceu e para
// dar para repetir depois. Uma linha por interesse: a última tentativa manda.
async function registrarTentativa(interesseId, etapa, status, erro, detalhe) {
  try {
    await query(
      `INSERT INTO moravo.grupo_tentativas (interesse_id, etapa, status, erro, detalhe)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (interesse_id) DO UPDATE
         SET etapa = EXCLUDED.etapa,
             status = EXCLUDED.status,
             erro = EXCLUDED.erro,
             detalhe = EXCLUDED.detalhe,
             tentativas = moravo.grupo_tentativas.tentativas + 1,
             atualizado_em = NOW()`,
      [interesseId, etapa, status, erro ? String(erro).slice(0, 600) : null,
       JSON.stringify(detalhe || {})]
    );
  } catch (err) {
    console.error('[grupo] falha ao registrar a tentativa:', err.message);
  }
}

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

// ---- Quem recebe o quê, em um lugar só
// Cada lado tem template próprio e ordem de variável própria. Isto ficava
// dentro do envio, e o reenvio do painel tinha a sua própria versão que mandava
// sem variável nenhuma. Uma função só, para não voltarem a divergir.
async function montarDestinatarios(interesse, config) {
  // Identificação do imóvel: título mais o código público, o mesmo que nomeia
  // o grupo. Antes ia o id do banco, que é sequencial e não bate com nada do
  // que a pessoa vê. Sem código (registro antigo), cai no id.
  const marca = interesse.imovel_codigo || interesse.imovel_id;
  const imovel = (interesse.imovel_titulo || 'seu imóvel') + (marca ? ' (' + marca + ')' : '');
  const primeiro = (n) => String(n || '').trim().split(/\s+/)[0] || 'Olá';

  return [
    {
      id: interesse.dono_id, papel: 'proprietario',
      telefone: interesse.dono_whatsapp, nome: interesse.dono_nome,
      template: (config && config.template_nome) || 'convite_grupo_proprietario',
      variaveis: [primeiro(interesse.dono_nome), interesse.corretor_nome || 'o corretor', imovel],
    },
    {
      id: interesse.corretor_id, papel: 'corretor',
      telefone: interesse.corretor_whatsapp, nome: interesse.corretor_nome,
      // Sem template próprio do corretor não existe reserva possível: usar o do
      // proprietário entrega o texto errado, dizendo ao corretor que "o corretor
      // começou a trabalhar o seu imóvel". Melhor não enviar e registrar o motivo.
      template: (config && config.template_corretor) || '',
      variaveis: [primeiro(interesse.corretor_nome), imovel, interesse.dono_nome || 'o proprietário'],
    },
  ];
}

// ---- Envia o convite para as duas partes e registra cada tentativa
async function enviarConvites(interesse, grupoLink) {
  const codigo = wa.extrairCodigoConvite(grupoLink);
  const config = await wa.getConfig().catch(() => null);
  const destinatarios = await montarDestinatarios(interesse, config);

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

    if (!d.template) {
      const erro = 'Template do ' + d.papel + ' não configurado em /admin. Mensagem não enviada ' +
                   'para não usar o texto do outro destinatário.';
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
  // A etapa é atualizada conforme o fluxo avança: se algo estourar, ela diz
  // exatamente onde parou, e é o que o painel mostra.
  let etapa = 'buscando o interesse';
  try {
  const r = await query(
    `SELECT i.id, i.imovel_id, i.corretor_id,
            i.grupo_whatsapp_id, i.grupo_whatsapp_link,
            im.titulo AS imovel_titulo, im.id AS imovel_id, im.dono_id,
            im.tipo AS imovel_tipo, im.codigo AS imovel_codigo,
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

  etapa = 'conferindo os telefones';
  if (!it.dono_whatsapp || !it.corretor_whatsapp) {
    throw new Error('WhatsApp do proprietário ou do corretor não está cadastrado.');
  }

  // Já existe grupo com link de convite válido: reaproveita e reenvia o convite
  const linkAtual = it.grupo_whatsapp_link;
  if (linkAtual && !linkAtual.startsWith('https://wa.me/')) {
    etapa = 'reenviando o convite do grupo existente';
    const envios = await enviarConvites(it, linkAtual);
    await registrarTentativa(interesseId, 'concluído', 'ok', null, { reaproveitou: true });
    return { grupo_id: it.grupo_whatsapp_id, grupo_link: linkAtual, ja_existia: true, envios };
  }

  // Atendente e números extras vêm da configuração do painel, com o .env como
  // reserva. Ler process.env aqui direto ignorava tudo que o admin preencheu.
  etapa = 'lendo a configuração do Waha';
  const cfgWaha = await configWaha();
  const atendente = cfgWaha.atendente;
  if (!atendente) {
    throw new Error('Atendente principal não configurado. Preencha em /admin, na Conexão do Waha.');
  }

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
  const internos = cfgWaha.extras;

  etapa = 'criando o grupo no Waha';
  const resultado = await criarGrupo({
    // Tipo + código, que é o que identifica o imóvel para quem está no grupo
    // sem expor o id sequencial nem depender de um título que muda.
    nome: nomeGrupo({ tipo: it.imovel_tipo, codigo: it.imovel_codigo }),
    descricao: `Negociação do imóvel "${it.imovel_titulo}". Proprietário: ${it.dono_nome}. Corretor: ${it.corretor_nome}.`,
    participantes: [atendente].concat(internos),
  });

  etapa = 'obtendo o link do convite';
  const grupoId = extrairIdGrupo(resultado);

  // Foto do grupo: quem recebe o convite vê o avatar antes de entrar, e sem
  // isso o grupo chega com o boneco genérico do WhatsApp. É enfeite, então
  // falhar aqui não pode interromper a criação: só registra e segue.
  if (grupoId) {
    try {
      await definirFotoGrupo(grupoId);
      console.log('[grupo] foto do grupo definida');
    } catch (err) {
      console.warn('[grupo] não foi possível definir a foto do grupo:', err.message);
    }
  }
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

  etapa = 'enviando os convites';
  const envios = await enviarConvites(it, grupoLink);

  await registrarTentativa(interesseId, 'concluído', 'ok', null,
    { grupo_id: grupoId, envios_ok: envios.filter((e) => e.ok).length });
  return { grupo_id: grupoId, grupo_link: grupoLink, ja_existia: false, envios };
  } catch (err) {
    await registrarTentativa(interesseId, etapa, 'erro', err.message, {});
    throw err;
  }
}

// =========================================================================
// Grupo do comprador
// =========================================================================
// Nasce já com o corretor definido, e o nome dele vai no assunto do grupo:
// o comprador pode ter mais de uma negociação aberta, e "Casa mc7GvdX" duas
// vezes na lista do WhatsApp não diz qual é qual.
//
// Se o corretor não entrar no prazo, o atendimento passa para outro e o grupo
// é RENOMEADO: ficar com o nome de quem não apareceu é pior que não ter nome.
// =========================================================================

async function dadosAtendimento(atendimentoId) {
  const r = await query(
    `SELECT ic.id, ic.imovel_id, ic.comprador_id, ic.corretor_id,
            ic.grupo_whatsapp_id, ic.grupo_whatsapp_link,
            im.titulo AS imovel_titulo, im.tipo AS imovel_tipo, im.codigo AS imovel_codigo,
            u_comp.nome AS comprador_nome, u_comp.whatsapp AS comprador_whatsapp,
            u_corr.nome AS corretor_nome, u_corr.whatsapp AS corretor_whatsapp
       FROM moravo.interesses_compradores ic
       JOIN moravo.imoveis  im     ON im.id = ic.imovel_id
       JOIN moravo.usuarios u_comp ON u_comp.id = ic.comprador_id
       LEFT JOIN moravo.usuarios u_corr ON u_corr.id = ic.corretor_id
      WHERE ic.id = $1`,
    [atendimentoId]
  );
  if (r.rowCount === 0) throw new Error('Atendimento não encontrado.');
  return r.rows[0];
}

// Token nominal, igual ao do outro grupo, mas amarrado ao atendimento
async function emitirTokenAtendimento(atendimentoId, usuarioId, papel) {
  const existente = await query(
    `SELECT token FROM moravo.convites_grupo
      WHERE atendimento_id = $1 AND usuario_id = $2 AND revogado = false`,
    [atendimentoId, usuarioId]
  );
  if (existente.rowCount) return existente.rows[0].token;

  const token = crypto.randomBytes(16).toString('hex');
  await query(
    `INSERT INTO moravo.convites_grupo (token, atendimento_id, usuario_id, papel)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (atendimento_id, usuario_id) DO UPDATE
       SET token = EXCLUDED.token, revogado = false`,
    [token, atendimentoId, usuarioId, papel]
  );
  return token;
}

// A mesma regra dos outros convites: sem template próprio, a pessoa não
// recebe nada e o motivo fica registrado. Usar o texto do outro lado
// entregaria a frase invertida.
async function montarDestinatariosComprador(at, config) {
  const imovel = (at.imovel_titulo || 'o imóvel') +
                 (at.imovel_codigo ? ' (' + at.imovel_codigo + ')' : '');
  const primeiro = (n) => String(n || '').trim().split(/\s+/)[0] || 'Olá';
  const prazo = '1 hora (em horário comercial)';

  const lista = [{
    id: at.comprador_id, papel: 'comprador',
    telefone: at.comprador_whatsapp, nome: at.comprador_nome,
    template: (config && config.template_comprador) || '',
    variaveis: [primeiro(at.comprador_nome), imovel, at.corretor_nome || 'um corretor da Moravo'],
  }];

  if (at.corretor_id) {
    lista.push({
      id: at.corretor_id, papel: 'corretor',
      telefone: at.corretor_whatsapp, nome: at.corretor_nome,
      template: (config && config.template_corretor_atendimento) || '',
      variaveis: [primeiro(at.corretor_nome), at.comprador_nome || 'um comprador', imovel, prazo],
    });
  }
  return lista;
}

async function enviarConvitesAtendimento(at, grupoLink) {
  const config = await wa.getConfig().catch(() => null);
  const destinatarios = await montarDestinatariosComprador(at, config);
  const resultados = [];

  for (const d of destinatarios) {
    const base = { destinatario_id: d.id, papel: d.papel, telefone: d.telefone,
                   template: d.template || null, codigo_convite: null };
    if (!d.telefone) {
      await wa.registrarEnvio(Object.assign({}, base,
        { status: 'falhou', erro: 'Sem WhatsApp cadastrado.' }));
      resultados.push({ papel: d.papel, ok: false, erro: 'Sem WhatsApp cadastrado.' });
      continue;
    }
    if (!d.template) {
      const erro = 'Template do ' + d.papel + ' (atendimento) não configurado em /admin. ' +
                   'Mensagem não enviada para não usar o texto de outro destinatário.';
      await wa.registrarEnvio(Object.assign({}, base, { status: 'falhou', erro: erro }));
      resultados.push({ papel: d.papel, ok: false, erro: erro });
      continue;
    }

    const token = await emitirTokenAtendimento(at.id, d.id, d.papel);
    try {
      const envio = await wa.enviarTemplateConvite({
        telefone: d.telefone, codigoConvite: token,
        variaveis: d.variaveis, template: d.template,
      });
      await wa.registrarEnvio(Object.assign({}, base,
        { codigo_convite: token, status: 'enviado', wamid: envio.wamid }));
      resultados.push({ papel: d.papel, ok: true, wamid: envio.wamid });
    } catch (err) {
      await wa.registrarEnvio(Object.assign({}, base,
        { codigo_convite: token, status: 'falhou', erro: String(err.message).slice(0, 500) }));
      resultados.push({ papel: d.papel, ok: false, erro: err.message });
    }
  }
  return resultados;
}

async function garantirGrupoComprador(atendimentoId) {
  const at = await dadosAtendimento(atendimentoId);

  // Grupo já existe: só reaproveita e reenvia o convite de quem faltar
  if (at.grupo_whatsapp_link && !at.grupo_whatsapp_link.startsWith('https://wa.me/')) {
    const envios = await enviarConvitesAtendimento(at, at.grupo_whatsapp_link);
    return { grupo_id: at.grupo_whatsapp_id, grupo_link: at.grupo_whatsapp_link,
             ja_existia: true, envios };
  }

  const cfgWaha = await configWaha();
  if (!cfgWaha.atendente) throw new Error('Atendente principal não configurado em /admin.');

  const resultado = await criarGrupo({
    nome: nomeGrupoComprador({ tipo: at.imovel_tipo, codigo: at.imovel_codigo }, at.corretor_nome),
    descricao: `Atendimento de compra do imóvel "${at.imovel_titulo}". ` +
               `Comprador: ${at.comprador_nome}.` +
               (at.corretor_nome ? ` Corretor: ${at.corretor_nome}.` : ''),
    participantes: [cfgWaha.atendente].concat(cfgWaha.extras),
  });

  const grupoId = extrairIdGrupo(resultado);
  if (grupoId) {
    try { await definirFotoGrupo(grupoId); }
    catch (err) { console.warn('[grupo-comprador] foto:', err.message); }
  }

  let grupoLink = montarLinkGrupo(resultado);
  if (!grupoLink || grupoLink.startsWith('https://wa.me/')) {
    const invite = await gerarInviteGrupo(grupoId).catch(() => '');
    if (invite) grupoLink = invite;
  }

  await query(
    `UPDATE moravo.interesses_compradores
        SET grupo_whatsapp_id = $1, grupo_whatsapp_link = $2
      WHERE id = $3`,
    [grupoId, grupoLink, at.id]
  );

  at.grupo_whatsapp_id = grupoId;
  at.grupo_whatsapp_link = grupoLink;
  const envios = await enviarConvitesAtendimento(at, grupoLink);
  return { grupo_id: grupoId, grupo_link: grupoLink, ja_existia: false, envios };
}

// ---- Troca o corretor de um grupo que já existe
// Renomeia, revoga o convite de quem perdeu a vez (o link dele não pode mais
// abrir o grupo) e manda o convite para o novo.
async function trocarCorretorDoGrupo(atendimentoId, corretorAnteriorId) {
  const at = await dadosAtendimento(atendimentoId);
  if (!at.grupo_whatsapp_id) return { trocou: false, motivo: 'Grupo ainda não existe.' };

  if (corretorAnteriorId) {
    await query(
      `UPDATE moravo.convites_grupo SET revogado = true
        WHERE atendimento_id = $1 AND usuario_id = $2`,
      [atendimentoId, corretorAnteriorId]
    );
  }

  try {
    await renomearGrupo(at.grupo_whatsapp_id,
      nomeGrupoComprador({ tipo: at.imovel_tipo, codigo: at.imovel_codigo }, at.corretor_nome));
  } catch (err) {
    // Nome errado é feio, não é impeditivo: o convite do novo corretor
    // continua valendo e é ele que faz o atendimento andar.
    console.warn('[grupo-comprador] não renomeou:', err.message);
  }

  const envios = await enviarConvitesAtendimento(at, at.grupo_whatsapp_link);
  return { trocou: true, envios };
}

// ---- Reenvio de UM convite, a partir da linha de whatsapp_envios
// O painel tinha a sua própria versão disto, que mandava sem variável nenhuma
// e ainda punha o código do grupo no lugar do token. O link saía apontando
// para um /linkgrupo que não resolve, porque só token resolve.
async function reenviarConvite(envioId) {
  const e = await query(
    `SELECT id, interesse_id, papel FROM moravo.whatsapp_envios WHERE id = $1`,
    [envioId]
  );
  if (e.rowCount === 0) throw new Error('Envio não encontrado.');
  const envio = e.rows[0];
  if (!envio.interesse_id) {
    throw new Error('Este registro não está ligado a uma negociação. Use "Enviar teste".');
  }

  const r = await query(
    `SELECT i.id, i.imovel_id, i.corretor_id, i.grupo_whatsapp_link,
            im.titulo AS imovel_titulo, im.dono_id,
            im.tipo AS imovel_tipo, im.codigo AS imovel_codigo,
            u_dono.nome AS dono_nome, u_dono.whatsapp AS dono_whatsapp,
            u_corr.nome AS corretor_nome, u_corr.whatsapp AS corretor_whatsapp
       FROM moravo.interesses i
       JOIN moravo.imoveis   im     ON im.id = i.imovel_id
       JOIN moravo.usuarios  u_dono ON u_dono.id = im.dono_id
       JOIN moravo.usuarios  u_corr ON u_corr.id = i.corretor_id
      WHERE i.id = $1`,
    [envio.interesse_id]
  );
  if (r.rowCount === 0) throw new Error('Negociação não encontrada.');
  const it = r.rows[0];
  if (!it.grupo_whatsapp_link) throw new Error('A negociação ainda não tem grupo criado.');

  const config = await wa.getConfig().catch(() => null);
  const dests = await montarDestinatarios(it, config);
  const d = dests.find((x) => x.papel === envio.papel);
  if (!d) throw new Error('Papel desconhecido neste envio: ' + envio.papel);
  if (!d.template) {
    throw new Error('Template do ' + d.papel + ' não configurado em /admin.');
  }
  if (!d.telefone) throw new Error('O ' + d.papel + ' não tem WhatsApp cadastrado.');

  // O que vai no link é o token da pessoa, o mesmo do primeiro envio
  const token = await emitirToken(it.id, d.id, d.papel);
  const resposta = await wa.enviarTemplateConvite({
    telefone: d.telefone, codigoConvite: token,
    variaveis: d.variaveis, template: d.template,
  });

  await query(
    `UPDATE moravo.whatsapp_envios
        SET status = 'enviado', wamid = $1, erro = NULL, template = $2,
            entrega = NULL, entrega_erro = NULL, entrega_em = NULL,
            tentativas = tentativas + 1, created_at = NOW()
      WHERE id = $3`,
    [resposta.wamid, d.template, envioId]
  );
  return { wamid: resposta.wamid, papel: d.papel, telefone: d.telefone };
}

module.exports = {
  garantirGrupo, enviarConvites, montarDestinatarios,
  garantirGrupoComprador, trocarCorretorDoGrupo, montarDestinatariosComprador,
  reenviarConvite, emitirToken, registrarTentativa,
};
