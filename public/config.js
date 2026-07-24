// =========================================================================
// Moravo — Configuração global da API
// Usa o mesmo domínio em produção (front e back servidos pelo mesmo Node).
// Em dev local com arquivo aberto via file://, cai pro 127.0.0.1:3001.
// =========================================================================

window.MORAVO_API = (window.location.protocol === 'file:')
  ? 'http://127.0.0.1:3001'
  : window.location.origin;

// Função de navegação inteligente para evitar que redirecionamentos de Clean URLs
// do servidor local (como npx serve) limpem a query string (ex: ?id=9).
window.verDetalhes = function(id) {
  var ext = (window.location.protocol === 'file:') ? '.html' : '';
  var url = 'detalhes' + ext + '?id=' + id;
  // Abre a página do imóvel em uma nova aba
  var win = window.open(url, '_blank');
  // Fallback: se o navegador bloqueou o popup, navega na mesma aba
  if (!win) window.location.href = url;
};

window.fotoUrl = function(f) {
  if (!f) return '';
  // Se for URL absoluta ou base64, não mexe
  if (f.indexOf('data:') === 0 || f.indexOf('http') === 0) {
    return f;
  }
  // Se for pasta de uploads do backend, concatena com MORAVO_API
  if (f.indexOf('uploads/') === 0) {
    return window.MORAVO_API + '/' + f;
  }
  if (f.indexOf('/uploads/') === 0) {
    return window.MORAVO_API + f;
  }
  // Se for imagem estática local do frontend, retorna relativo
  if (f.indexOf('/') === 0 || f.indexOf('img/') === 0) {
    return f;
  }
  return window.MORAVO_API + '/' + f;
};


