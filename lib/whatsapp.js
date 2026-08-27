// =========================================================================
// WhatsApp Cloud API (oficial, Meta)
// Usada para ENVIAR o convite do grupo. A criação do grupo continua no Waha.
//
// A configuração (Phone Number ID, WABA ID, versão e token) fica na tabela
// moravo.config_whatsapp, preenchida pelo painel do admin. O token é gravado
// cifrado (AES-256-GCM) e nunca volta para o front-end.
// =========================================================================
const crypto = require('crypto');
const { query } = require('../db');

const GRAPH_HOST = 'https://graph.facebook.com';
const CACHE_MS = 30000; // evita ir ao banco a cada envio

let cache = { valor: null, em: 0 };

// ---- Chave de cifra: CONFIG_SECRET, com JWT_SECRET como reserva
function chaveCifra() {
  const base = process.env.CONFIG_SECRET || process.env.JWT_SECRET;
  if (!base || !base.trim()) {
    throw new Error('CONFIG_SECRET (ou JWT_SECRET) precisa estar definido para guardar o token do WhatsApp.');
  }
  return crypto.scryptSync(base, 'moravo-config-whatsapp', 32);
}

function cifrar(texto) {
  if (!texto) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', chaveCifra(), iv);
  const dados = Buffer.concat([cipher.update(String(texto), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), dados.toString('base64')].join(':');
}

function decifrar(guardado) {
  if (!guardado) return '';
  const partes = String(guardado).split(':');
  if (partes.length !== 3) return '';
  try {
    const [iv, tag, dados] = partes.map((p) => Buffer.from(p, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', chaveCifra(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(dados), decipher.final()]).toString('utf8');
  } catch (err) {
    console.error('[whatsapp] falha ao decifrar o token:', err.message);
    return '';
  }
}

// ---- Normaliza para o formato que a Meta exige: dígitos com DDI, sem '+'
// No banco há números salvos com e sem o 55 na frente.
function normalizarTelefone(numero) {
  const digitos = String(numero || '').replace(/\D/g, '');
  if (!digitos) return '';
  return digitos.startsWith('55') ? digitos : '55' + digitos;
}

// ---- Do link completo do convite, extrai só o código
// O botão de URL do template tem base fixa (https://chat.whatsapp.com/) e
// recebe apenas o sufixo como variável.
function extrairCodigoConvite(link) {
  if (!link) return '';
  const m = String(link).match(/chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9_-]+)/);
  return m ? m[1] : '';
}

// ---- Configuração salva pelo admin (com cache curto)
async function getConfig({ semCache } = {}) {
  const agora = Date.now();
  if (!semCache && cache.valor && agora - cache.em < CACHE_MS) return cache.valor;

  const r = await query(
    `SELECT phone_number_id, waba_id, api_version, token_cifrado,
            template_nome, template_idioma, ativo, atualizado_em
       FROM moravo.config_whatsapp WHERE id = 1`
  );
  const linha = r.rows[0] || {};
  const config = {
    phone_number_id: linha.phone_number_id || '',
    waba_id:         linha.waba_id || '',
    api_version:     linha.api_version || 'v23.0',
    template_nome:   linha.template_nome || 'link_grupo_convite',
    template_corretor: linha.template_corretor || '',
    template_idioma: linha.template_idioma || 'pt_BR',
    ativo:           !!linha.ativo,
    atualizado_em:   linha.atualizado_em || null,
    token:           decifrar(linha.token_cifrado),
  };
  cache = { valor: config, em: agora };
  return config;
}

function limparCache() { cache = { valor: null, em: 0 }; }

// ---- Diz se dá para enviar, e por que não, quando for o caso
async function prontoParaEnviar() {
  const c = await getConfig();
  if (!c.ativo)           return { pronto: false, motivo: 'Envio pelo WhatsApp está desativado no painel.' };
  if (!c.phone_number_id) return { pronto: false, motivo: 'Phone Number ID não configurado.' };
  if (!c.token)           return { pronto: false, motivo: 'Token de acesso não configurado.' };
  return { pronto: true, config: c };
}

// =========================================================================
// Envia o template do convite.
// O template tem UMA variável, no botão de URL, que recebe só o código.
// =========================================================================
async function enviarTemplateConvite({ telefone, codigoConvite, nome, variaveis, template }) {
  const check = await prontoParaEnviar();
  if (!check.pronto) throw new Error(check.motivo);
  const c = check.config;

  const destino = normalizarTelefone(telefone);
  if (!destino) throw new Error('Telefone do destinatário está vazio ou inválido.');
  if (!codigoConvite) throw new Error('Código do convite do grupo está vazio.');

  // O corpo do template pode ter mais de uma variável, e a quantidade tem que
  // bater exatamente com o que foi cadastrado na Meta. Mandar a menos devolve
  // "number of parameters does not match the expected number of params".
  // Quem chama passa a lista pronta; 'nome' continua aceito para o caso de uma
  // variável só, que era o formato antigo.
  const listaVars = Array.isArray(variaveis) && variaveis.length
    ? variaveis
    : [String(nome || '').trim().split(/\s+/)[0] || 'Olá'];

  const url = `${GRAPH_HOST}/${c.api_version}/${c.phone_number_id}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to: destino,
    type: 'template',
    template: {
      name: template || c.template_nome,
      language: { code: c.template_idioma },
      components: [
        {
          type: 'body',
          parameters: listaVars.map(function (v) {
            // a Meta recusa variável vazia ou com quebra de linha
            return { type: 'text', text: String(v == null ? '' : v).replace(/\s+/g, ' ').trim() || '-' };
          }),
        },
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [{ type: 'text', text: codigoConvite }],
        },
      ],
    },
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + c.token },
    body: JSON.stringify(payload),
  });

  const texto = await resp.text();
  let corpo;
  try { corpo = JSON.parse(texto); } catch (e) { corpo = { raw: texto.slice(0, 300) }; }

  if (!resp.ok) {
    const e = corpo.error || {};
    const partes = [e.error_user_msg, e.message].filter(Boolean);
    if (e.code) partes.push('código ' + e.code + (e.error_subcode ? '/' + e.error_subcode : ''));
    if (e.error_data && e.error_data.details) partes.push(e.error_data.details);
    const detalhe = partes.join(' | ') || texto.slice(0, 200);
    const err = new Error(`Meta retornou ${resp.status}: ${detalhe}`);
    err.meta = e;
    throw err;
  }

  const wamid = (corpo.messages && corpo.messages[0] && corpo.messages[0].id) || '';
  return { wamid, destino, resposta: corpo };
}

// ---- Lista os templates cadastrados na WABA, direto da Meta.
// Serve para conferir nome, idioma e status sem sair do painel: o erro
// #132001 quase sempre é nome diferente, idioma diferente ou template
// que ainda não foi aprovado.
async function listarTemplates() {
  const c = await getConfig({ semCache: true });
  if (!c.token)   throw new Error('Token de acesso não configurado.');
  if (!c.waba_id) throw new Error('Informe o WhatsApp Business Account ID (WABA) para listar os templates.');

  const url = `${GRAPH_HOST}/${c.api_version}/${c.waba_id}/message_templates` +
              `?fields=name,language,status,category,components&limit=100`;
  const resp = await fetch(url, { headers: { Authorization: 'Bearer ' + c.token } });
  const texto = await resp.text();
  let corpo;
  try { corpo = JSON.parse(texto); } catch (e) { corpo = {}; }

  if (!resp.ok) {
    const e = corpo.error || {};
    throw new Error(`Meta retornou ${resp.status}: ${e.message || texto.slice(0, 200)}` +
                    (e.code ? ` | código ${e.code}` : ''));
  }

  return (corpo.data || []).map(function (t) {
    const corpoComp = (t.components || []).find(function (x) { return x.type === 'BODY'; });
    const botaoComp = (t.components || []).find(function (x) { return x.type === 'BUTTONS'; });
    const variaveisCorpo = corpoComp && corpoComp.text
      ? (corpoComp.text.match(/\{\{\d+\}\}/g) || []).length : 0;
    const botaoUrl = botaoComp && botaoComp.buttons && botaoComp.buttons[0]
      ? (botaoComp.buttons[0].url || '') : '';
    return {
      nome: t.name,
      idioma: t.language,
      status: t.status,
      categoria: t.category,
      variaveis_corpo: variaveisCorpo,
      botao_url: botaoUrl,
    };
  });
}

// ---- Quantas variáveis o corpo do template espera, segundo a Meta.
// Evita o erro 132000 na tentativa e erro: em vez de adivinhar, perguntamos.
async function contarVariaveisCorpo(nomeTemplate, idioma) {
  try {
    const lista = await listarTemplates();
    const c = await getConfig();
    const alvo = (lista || []).filter(function (t) {
      return t.nome === (nomeTemplate || c.template_nome) &&
             t.idioma === (idioma || c.template_idioma);
    })[0];
    return alvo ? alvo.variaveis_corpo : null;
  } catch (err) {
    return null;
  }
}

// ---- Grava o resultado do envio (sucesso ou falha) para a tela de erros
async function registrarEnvio({ interesse_id, destinatario_id, papel, telefone,
                                template, codigo_convite, status, wamid, erro }) {
  try {
    const r = await query(
      `INSERT INTO moravo.whatsapp_envios
         (interesse_id, destinatario_id, papel, telefone, template,
          codigo_convite, status, wamid, erro)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [interesse_id || null, destinatario_id || null, papel || null,
       normalizarTelefone(telefone), template || null, codigo_convite || null,
       status, wamid || null, erro ? String(erro).slice(0, 500) : null]
    );
    return r.rows[0].id;
  } catch (err) {
    console.error('[whatsapp] falha ao registrar envio:', err.message);
    return null;
  }
}

module.exports = {
  cifrar, decifrar,
  getConfig, limparCache, prontoParaEnviar,
  normalizarTelefone, extrairCodigoConvite,
  enviarTemplateConvite, registrarEnvio, listarTemplates, contarVariaveisCorpo,
};
