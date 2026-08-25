// =========================================================================
// Página de entrada no grupo de WhatsApp
// =========================================================================
// O botão do template leva para cá em vez de mandar direto para o
// chat.whatsapp.com. Passar pelo nosso domínio permite:
//   - confirmar para a pessoa em qual imóvel ela está entrando
//   - trocar o convite sem invalidar o link já enviado
//   - medir quem abriu
//
// Tudo que vem da URL é escapado antes de entrar no HTML: o nome do
// corretor chega por query string e seria um vetor de XSS.
// =========================================================================

function escapar(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Só aceita destino no WhatsApp: evita virar redirecionador aberto
function destinoSeguro(link) {
  if (!link) return '';
  const m = String(link).match(/^https:\/\/chat\.whatsapp\.com\/([A-Za-z0-9_-]{4,60})$/);
  return m ? m[0] : '';
}

function render({ destino, nome, imovel, papel }) {
  const saudacao = nome ? 'Tudo certo, ' + escapar(nome) + '!' : 'Tudo certo!';
  const sobre = imovel
    ? 'Este é o grupo da negociação do imóvel <strong>' + escapar(imovel) + '</strong>.'
    : 'Este é o grupo da sua negociação na Moravo.';
  const comQuem = papel === 'corretor'
    ? 'Você, o proprietário e um atendente da Moravo estão nele.'
    : 'Você, o corretor e um atendente da Moravo estão nele.';

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex, nofollow" />
<title>Moravo | Entrar no grupo</title>
<meta http-equiv="refresh" content="4; url=${escapar(destino)}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@700;800&family=Inter:wght@400;500;600&family=Quicksand:wght@600&display=swap" rel="stylesheet" />
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',system-ui,sans-serif;background:#FBF8F5;color:#1a1613;
     min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;line-height:1.6}
.cartao{background:#fff;border:1px solid #e8ded3;border-radius:22px;padding:clamp(28px,5vw,44px);
        max-width:460px;width:100%;text-align:center;box-shadow:0 18px 50px rgba(0,0,0,.07)}
.marca{display:inline-flex;align-items:center;gap:9px;margin-bottom:26px}
.marca span{font-family:'Quicksand',sans-serif;font-weight:600;font-size:1.3rem;text-transform:lowercase}
h1{font-family:'Plus Jakarta Sans',sans-serif;font-size:1.5rem;font-weight:800;margin-bottom:12px;letter-spacing:-.02em}
p{color:#6f665f;font-size:1rem;margin-bottom:10px}
p.sobre{color:#1a1613}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;background:#25d366;color:#fff;
     font-weight:700;font-size:1.05rem;padding:17px 28px;border-radius:12px;text-decoration:none;margin:26px 0 14px}
.btn:hover{background:#1fb855}
.aviso{font-size:.87rem;color:#9b938c}
.barra{height:3px;background:#efe7de;border-radius:3px;overflow:hidden;margin-top:20px}
.barra i{display:block;height:100%;width:0;background:#FF6A00;animation:enche 4s linear forwards}
@keyframes enche{to{width:100%}}
@media(prefers-reduced-motion:reduce){.barra i{animation:none;width:100%}}
</style>
</head>
<body>
<main class="cartao">
  <div class="marca">
    <svg viewBox="0 0 100 100" fill="none" stroke="#F4793C" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" style="width:22px;height:22px" aria-label="moravo">
      <path d="M22 85 L22 50 Q22 43 27.5 39 L47 22.5 Q50 20 53 22.5 L72.5 39 Q78 43 78 50 L78 85"/>
    </svg>
    <span>moravo</span>
  </div>

  <h1>${saudacao}</h1>
  <p class="sobre">${sobre}</p>
  <p>${comQuem}</p>

  <a class="btn" href="${escapar(destino)}" id="ir">
    <svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm5.5 14.1c-.2.6-1.2 1.2-1.7 1.2-.5.1-1 .1-1.6-.1-.4-.1-.9-.3-1.5-.6-2.7-1.2-4.4-3.9-4.5-4.1-.1-.2-1.1-1.4-1.1-2.7 0-1.3.7-1.9.9-2.2.2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 2c.1.2.1.3 0 .5l-.3.4-.3.4c-.1.1-.2.3 0 .5.1.2.6 1 1.3 1.7.9.8 1.6 1 1.8 1.2.2.1.4.1.5-.1l.7-.8c.2-.2.3-.2.5-.1l2 .9c.2.1.4.2.4.3.1.1.1.6-.1 1.2z"/></svg>
    Entrar no grupo
  </a>

  <p class="aviso">Você será levado ao WhatsApp em alguns segundos.<br />Se nada acontecer, toque no botão acima.</p>
  <div class="barra"><i></i></div>
</main>

<script>
  setTimeout(function () { window.location.replace(document.getElementById('ir').href); }, 3800);
</script>
</body>
</html>`;
}

function paginaErro(mensagem) {
  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="noindex, nofollow" />
<title>Moravo | Link indisponível</title>
<style>
body{font-family:system-ui,sans-serif;background:#FBF8F5;color:#1a1613;min-height:100vh;
     display:flex;align-items:center;justify-content:center;padding:24px;margin:0;line-height:1.6}
.c{background:#fff;border:1px solid #e8ded3;border-radius:22px;padding:40px;max-width:440px;text-align:center}
h1{font-size:1.35rem;margin:0 0 12px}
p{color:#6f665f;margin:0 0 22px}
a{color:#E05300;font-weight:600}
</style></head>
<body><main class="c">
  <h1>Link indisponível</h1>
  <p>${escapar(mensagem)}</p>
  <p>Entre no site e abra suas mensagens para achar o grupo, ou fale com a gente em
     <a href="mailto:contato@moravo.com.br">contato@moravo.com.br</a>.</p>
  <a href="https://moravo.com.br/dashboard">Ir para o meu painel</a>
</main></body></html>`;
}

module.exports = { render, paginaErro, destinoSeguro, escapar };
