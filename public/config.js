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
  // Com barra na frente: a partir de /imovel/<slug>/ um caminho relativo
  // viraria /imovel/<slug>/detalhes, que não existe.
  var url = (ext ? 'detalhes' + ext : '/detalhes') + '?id=' + id;
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
  // Imagem estática do front. A barra na frente é obrigatória: a página do
  // imóvel vive em /imovel/<slug>/, e um caminho relativo procuraria o arquivo
  // dentro dessa pasta, que não existe.
  if (f.indexOf('/') === 0) return f;
  if (f.indexOf('img/') === 0) return '/' + f;
  return window.MORAVO_API + '/' + f;
};


