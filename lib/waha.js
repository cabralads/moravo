// =========================================================================
// Integração com a API do Waha (WhatsApp)
// =========================================================================
// Waha API base: https://wpp.atendentex.com.br
// Sessão: AtendenteX_Waha
// Headers: X-API-Key

const { query } = require('../db');
const { decifrar } = require('./cripto');

// A conexão do Waha é editável em /admin -> Config. WhatsApp e fica em
// moravo.config_whatsapp. O .env continua valendo como reserva, para o sistema
// seguir funcionando se ninguém tiver preenchido o painel ainda.
const PADRAO = {
  url: 'https://wpp.atendentex.com.br',
  sessao: 'AtendenteX_Waha',
};

const CACHE_MS = 30000;
let cacheCfg = { valor: null, em: 0 };

async function config(opcoes) {
  const semCache = opcoes && opcoes.semCache;
  const agora = Date.now();
  if (!semCache && cacheCfg.valor && agora - cacheCfg.em < CACHE_MS) return cacheCfg.valor;

  let linha = {};
  try {
    const r = await query(
      `SELECT waha_url, waha_sessao, waha_atendente, waha_extras, waha_api_key_cifrada
         FROM moravo.config_whatsapp WHERE id = 1`
    );
    linha = r.rows[0] || {};
  } catch (err) {
    console.warn('[waha] não consegui ler a configuração do banco:', err.message);
  }

  const limpo = (v) => (v == null ? '' : String(v).trim());
  const valor = {
    url: (limpo(linha.waha_url) || process.env.WAHA_URL || PADRAO.url)
           .replace(/\/+$/, '').replace(/\/api$/, ''),
    sessao: limpo(linha.waha_sessao) || process.env.WAHA_SESSION || PADRAO.sessao,
    apiKey: (decifrar(linha.waha_api_key_cifrada) || process.env.WAHA_API_KEY || '').trim(),
    atendente: (limpo(linha.waha_atendente) || process.env.WAHA_ATENDENTE_PRINCIPAL || '').replace(/\D/g, ''),
    extras: (limpo(linha.waha_extras) || process.env.WAHA_PARTICIPANTES_EXTRA || '')
              .split(',').map((n) => n.replace(/\D/g, '')).filter(Boolean),
    // de onde cada valor veio, para o diagnóstico do painel
    origem: {
      url: limpo(linha.waha_url) ? 'painel' : (process.env.WAHA_URL ? '.env' : 'padrão do código'),
      sessao: limpo(linha.waha_sessao) ? 'painel' : (process.env.WAHA_SESSION ? '.env' : 'padrão do código'),
      atendente: limpo(linha.waha_atendente) ? 'painel' : (process.env.WAHA_ATENDENTE_PRINCIPAL ? '.env' : 'não definido'),
      apiKey: linha.waha_api_key_cifrada ? 'painel' : (process.env.WAHA_API_KEY ? '.env' : 'não definida'),
    },
  };
  cacheCfg = { valor, em: agora };
  return valor;
}

function limparCache() { cacheCfg = { valor: null, em: 0 }; }

// ---- Normaliza número de WhatsApp para JID do WhatsApp (55DDXXXXXXXXX@c.us)
function formatarNumero(numero) {
  if (!numero) return null;
  const digitos = String(numero).replace(/\D/g, '');
  if (!digitos) return null;
  const comDDI = digitos.startsWith('55') ? digitos : '55' + digitos;
  return `${comDDI}@c.us`;
}

// ---- Normaliza número puro (sem o @c.us) para comparação/validação
function extrairDigitos(numero) {
  if (!numero) return '';
  return String(numero).replace(/\D/g, '');
}

// ============================================================================
// CRIA GRUPO
// POST /api/{session}/groups
// ============================================================================
async function criarGrupo({ nome, participantes, descricao }) {
  const cfg = await config();
  if (!cfg.apiKey) {
    throw new Error('WAHA_API_KEY não configurada no servidor.');
  }

  const participantsJids = participantes.map(formatarNumero).filter(Boolean);

  // Um participante basta: no modelo atual o grupo nasce só com o atendente da
  // Moravo, e as partes entram pelo convite. A regra antiga de dois vinha de
  // quando proprietário e corretor eram adicionados à força, e passou a
  // bloquear toda criação de grupo.
  if (participantsJids.length < 1) {
    throw new Error('Informe ao menos o número do atendente para criar o grupo.');
  }

  const body = {
    name: nome,
    participants: participantsJids.map((jid) => ({ id: jid })),
  };
  if (descricao) {
    body.description = descricao;
  }

  const url = `${cfg.url}/api/${cfg.sessao}/groups`;
  console.log(`[waha] POST ${url} (${participantsJids.length} participantes, sessão ${cfg.sessao})`);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': cfg.apiKey },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    console.error('[waha] erro na resposta:', response.status, text);
    throw new Error(`Waha retornou ${response.status}: ${text.slice(0, 200)}`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    console.error('[waha] resposta não é JSON:', text.slice(0, 200));
    throw new Error('Resposta inválida do Waha (não é JSON).');
  }

  console.log('[waha] grupo criado:', JSON.stringify(data).slice(0, 500));
  return data;
}

// ============================================================================
// ENVIA MENSAGEM DE TEXTO
// Tenta vários endpoints comuns do Waha para envio de mensagens.
// ============================================================================
async function enviarMensagem(chatId, texto, session) {
  const cfg = await config();
  if (!cfg.apiKey) throw new Error('WAHA_API_KEY não configurada no servidor.');
  if (!chatId || !texto) throw new Error('chatId e texto são obrigatórios.');
  session = session || cfg.sessao;
  const WAHA_URL = cfg.url;
  const WAHA_API_KEY = cfg.apiKey;

  // Candidatos: tenta os paths mais comuns de envio de mensagem
  const candidatos = [
    // Waha v0.4+ — POST /chats/{chatId}/messages
    {
      method: 'POST',
      url: `${WAHA_URL}/api/${session}/chats/${encodeURIComponent(chatId)}/messages`,
      body: { text: texto },
    },
    // Waha v0.3 — POST /sendMessages
    {
      method: 'POST',
      url: `${WAHA_URL}/api/${session}/sendMessages`,
      body: { chatId, text: texto },
    },
    // Waha legado — POST /sendText
    {
      method: 'POST',
      url: `${WAHA_URL}/api/${session}/sendText`,
      body: { chatId, text: texto },
    },
    // Variante com session no body
    {
      method: 'POST',
      url: `${WAHA_URL}/api/${session}/chats/${encodeURIComponent(chatId)}/messages`,
      body: { session, chatId, text: texto },
    },
  ];

  for (const cand of candidatos) {
    try {
      console.log(`[waha] POST ${cand.url}`);
      const response = await fetch(cand.url, {
        method: cand.method,
        headers: { 'Content-Type': 'application/json', 'X-API-Key': WAHA_API_KEY },
        body: JSON.stringify(cand.body),
      });

      const text = await response.text();
      if (response.ok) {
        console.log(`[waha] mensagem enviada com sucesso via ${cand.url.split('/api/')[1]}`);
        return JSON.parse(text);
      } else {
        console.log(`[waha] ${cand.url} -> ${response.status}: ${text.slice(0, 120)}`);
      }
    } catch (err) {
      console.log(`[waha] erro em ${cand.url}: ${err.message}`);
    }
  }

  throw new Error('Nenhum endpoint de envio de mensagem funcionou.');
}

// ============================================================================
// GERA INVITE CODE (link de convite do grupo)
// Tenta vários endpoints comuns do Waha para gerar link de convite.
// ============================================================================
async function gerarInviteGrupo(grupoJid) {
  const cfg = await config();
  if (!cfg.apiKey) throw new Error('WAHA_API_KEY não configurada no servidor.');
  if (!grupoJid) throw new Error('JID do grupo é obrigatório.');
  const WAHA_URL = cfg.url;
  const WAHA_SESSION = cfg.sessao;
  const WAHA_API_KEY = cfg.apiKey;

  // Endpoints candidatos para gerar invite.
  // A ordem importa só pelo log: a versão do Waha em wpp.atendentex.com.br
  // responde no GET /groups/{jid}/invite-code, então ele vem primeiro. Os
  // outros ficam como reserva para outra versão, mas antes eram tentados na
  // frente e enchiam o log de 404 em toda criação de grupo.
  const candidatos = [
    ['GET', `${WAHA_URL}/api/${WAHA_SESSION}/groups/${encodeURIComponent(grupoJid)}/invite-code`, null],
    ['POST', `${WAHA_URL}/api/${WAHA_SESSION}/groups/${encodeURIComponent(grupoJid)}/invite-code`, {}],
    ['POST', `${WAHA_URL}/api/${WAHA_SESSION}/chats/${encodeURIComponent(grupoJid)}/invite-code`, {}],
    ['GET', `${WAHA_URL}/api/${WAHA_SESSION}/chats/${encodeURIComponent(grupoJid)}/invite-code`, null],
    // Variante com body { chatId }
    ['POST', `${WAHA_URL}/api/${WAHA_SESSION}/chats/${encodeURIComponent(grupoJid)}/invite-code`, { chatId: grupoJid }],
    // Waha antigo — POST /inviteLinkGenerate
    ['POST', `${WAHA_URL}/api/${WAHA_SESSION}/inviteLinkGenerate`, { groupJid: grupoJid }],
    // Variante com query param
    ['GET', `${WAHA_URL}/api/${WAHA_SESSION}/chats/${encodeURIComponent(grupoJid)}/invite`, null],
    ['POST', `${WAHA_URL}/api/${WAHA_SESSION}/chats/${encodeURIComponent(grupoJid)}/invite`, {}],
  ];

  for (const [metodo, url, bodyData] of candidatos) {
    try {
      console.log(`[waha] tentando ${metodo} ${url}`);
      const fetchOpts = {
        method: metodo,
        headers: { 'Content-Type': 'application/json', 'X-API-Key': WAHA_API_KEY },
      };
      if (bodyData !== null) {
        fetchOpts.body = JSON.stringify(bodyData);
      }

      const response = await fetch(url, fetchOpts);
      const text = await response.text();

      console.log(`[waha] ${metodo} ${url} -> ${response.status}`);
      console.log(`[waha] resposta completa (${text.length} chars):`, text);

      if (!response.ok) {
        continue;
      }

      // Caso 1: resposta é texto puro (URL direta)
      const trimmed = text.trim();
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        console.log(`[waha] ✅ invite direto como texto:`, trimmed);
        return trimmed;
      }
      if (trimmed.startsWith('chat.whatsapp.com/')) {
        const url2 = `https://${trimmed}`;
        console.log(`[waha] ✅ invite direto (sem protocolo):`, url2);
        return url2;
      }

      // Caso 2: resposta é JSON (ou array JSON)
      let data;
      try { data = JSON.parse(text); } catch { continue; }

      console.log(`[waha] ${metodo} ${url} -> 200 OK. Tipo:`, Array.isArray(data) ? 'array' : 'objeto');

      // Caso 2a: É array JSON — pega o primeiro elemento
      if (Array.isArray(data) && data.length > 0) {
        const item = data[0];
        if (typeof item === 'string' && item.startsWith('http')) return item;
        if (typeof item === 'object' && item !== null) {
          // Pega o primeiro campo string que pareça URL ou code
          for (const key of Object.keys(item)) {
            const val = item[key];
            if (typeof val === 'string') {
              if (val.startsWith('http')) return val;
              if (val.length > 10 && /^[A-Za-z0-9]+$/.test(val)) {
                return `https://chat.whatsapp.com/${val}`;
              }
            }
          }
        }
      }

      // Tenta extrair code de qualquer campo conhecido
      const code = extrairInviteCode(data);
      if (code) {
        console.log(`[waha] ✅ invite code extraído:`, code);
        if (code.startsWith('http')) return code;
        return `https://chat.whatsapp.com/${code}`;
      }

      console.log(`[waha] ${metodo} ${url} -> 200 mas sem code detectável`);
    } catch (err) {
      console.log(`[waha] erro em ${metodo} ${url}: ${err.message}`);
    }
  }

  return '';
}

// Extrai invite code de qualquer estrutura de resposta do Waha
function extrairInviteCode(data) {
  if (!data || typeof data !== 'object') return '';

  // 1. Campos diretos
  const campos = [
    'inviteCode', 'invite_code', 'invitecode',
    'code', 'link', 'url', 'invite', 'inviteUrl', 'inviteUrl',
    'inviteLink', 'shortLink', 'short_url',
    'LinkInvite', 'groupInviteLink',
    'data', 'result', 'payload', 'value',
  ];

  for (const campo of campos) {
    const val = data[campo];
    if (typeof val === 'string' && val.length > 0) return val;
    if (typeof val === 'object' && val !== null) {
      // Tenta campos aninhados
      for (const sub of ['code', 'link', 'url', 'inviteCode', 'invite_code']) {
        if (typeof val[sub] === 'string' && val[sub].length > 0) return val[sub];
      }
    }
  }

  return '';
}

// ============================================================================
// EXTRAI ID DO GRUPO (JID) da resposta do Waha
// ============================================================================
function extrairIdGrupo(data) {
  if (!data) return '';
  return (
    data.JID ||
    data.jid ||
    data.chatId ||
    data.id ||
    data.groupId ||
    data.groupJid ||
    data.groupJID ||
    ''
  );
}

// ============================================================================
// MONTA LINK DO GRUPO
// Se não vier invite code, tenta montar um link wa.me (último recurso)
// ============================================================================
function montarLinkGrupo(data, jidFallback) {
  const invite = extrairInviteCode(data);
  if (invite) return invite;

  const jid = extrairIdGrupo(data) || jidFallback;
  if (!jid) return '';

  // wa.me com JID numérico — funciona pra abrir chat mas não entra em grupo diretamente
  const jidNumber = jid.replace(/@.*$/, '');
  return `https://wa.me/${jidNumber}`;
}

// ============================================================================
// DIAGNÓSTICO
// Mostra o que o servidor está de fato usando e o estado das sessões no Waha.
// Existe porque a sessão vem de variável de ambiente com padrão embutido: sem
// WAHA_SESSION no .env, o código cai em "AtendenteX_Waha" sem avisar ninguém.
// ============================================================================
async function diagnostico() {
  const cfg = await config({ semCache: true });
  const base = {
    url: cfg.url,
    sessao_em_uso: cfg.sessao,
    origem_sessao: cfg.origem.sessao,
    origem_url: cfg.origem.url,
    origem_atendente: cfg.origem.atendente,
    api_key_definida: !!cfg.apiKey,
    origem_api_key: cfg.origem.apiKey,
    api_key_final: cfg.apiKey ? '...' + cfg.apiKey.slice(-4) : '',
    atendente_principal: cfg.atendente,
    participantes_extra: cfg.extras.join(', '),
    sessoes: [],
    sessao_existe: false,
    sessao_status: null,
    erro: null,
  };

  if (!cfg.apiKey) {
    base.erro = 'WAHA_API_KEY não está definida no servidor.';
    return base;
  }

  try {
    const resp = await fetch(`${cfg.url}/api/sessions`, { headers: { 'X-API-Key': cfg.apiKey } });
    const texto = await resp.text();
    if (!resp.ok) {
      base.erro = `Waha retornou ${resp.status}: ${texto.slice(0, 160)}`;
      return base;
    }
    let dados;
    try { dados = JSON.parse(texto); } catch (e) { dados = []; }
    base.sessoes = (Array.isArray(dados) ? dados : []).map(function (x) {
      return { nome: x.name || x.session || '?', status: x.status || x.state || '?' };
    });
    const achou = base.sessoes.filter(function (x) { return x.nome === cfg.sessao; })[0];
    base.sessao_existe = !!achou;
    base.sessao_status = achou ? achou.status : null;
  } catch (err) {
    base.erro = 'Não consegui falar com o Waha: ' + err.message;
  }
  return base;
}

module.exports = {
  criarGrupo,
  diagnostico,
  config,
  limparCache,
  enviarMensagem,
  gerarInviteGrupo,
  formatarNumero,
  extrairDigitos,
  extrairInviteCode,
  extrairIdGrupo,
  montarLinkGrupo,
};
