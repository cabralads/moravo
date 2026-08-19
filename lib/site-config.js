// =========================================================================
// Configurações do site editáveis pelo admin
// =========================================================================
// Hoje guarda os scripts de terceiros (Google Tag Manager, pixels, etc.)
// que devem entrar em toda página pública. O conteúdo é injetado na hora
// de servir o HTML, então não precisa mexer em arquivo nenhum.
// =========================================================================
const { query } = require('../db');

const CACHE_MS = 30000;
let cache = { valor: null, em: 0 };

async function getScripts(opcoes) {
  const semCache = opcoes && opcoes.semCache;
  const agora = Date.now();
  if (!semCache && cache.valor && agora - cache.em < CACHE_MS) return cache.valor;

  let linha = {};
  try {
    const r = await query(
      `SELECT head_html, body_html, atualizado_em FROM moravo.config_site WHERE id = 1`
    );
    linha = r.rows[0] || {};
  } catch (err) {
    console.warn('[site-config] não consegui ler a configuração:', err.message);
  }

  const valor = {
    head_html: linha.head_html || '',
    body_html: linha.body_html || '',
    atualizado_em: linha.atualizado_em || null,
  };
  cache = { valor: valor, em: agora };
  return valor;
}

function limparCache() { cache = { valor: null, em: 0 }; }

// ---- Insere os scripts no HTML.
// O head vai antes de </head>; o body logo depois da tag <body>, que é onde
// o Tag Manager pede o <noscript>.
// O replace usa função de propósito: string de substituição faria o Node
// interpretar $& e $1 dentro do código colado pelo admin.
function injetar(html, scripts) {
  if (!html || !scripts) return html;

  if (scripts.head_html) {
    if (/<\/head>/i.test(html)) {
      html = html.replace(/<\/head>/i, function (tag) { return scripts.head_html + '\n' + tag; });
    } else {
      html = scripts.head_html + '\n' + html;
    }
  }

  if (scripts.body_html) {
    var abre = html.match(/<body[^>]*>/i);
    if (abre) {
      html = html.replace(abre[0], function (tag) { return tag + '\n' + scripts.body_html; });
    } else if (/<\/body>/i.test(html)) {
      html = html.replace(/<\/body>/i, function (tag) { return scripts.body_html + '\n' + tag; });
    } else {
      html = html + '\n' + scripts.body_html;
    }
  }

  return html;
}

module.exports = { getScripts, limparCache, injetar };
