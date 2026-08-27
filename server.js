// =========================================================================
// Moravo Backend — entry point
// Sobe o Express, registra as rotas e conecta no Postgres.
// =========================================================================
require('dotenv').config();

const express = require('express');
const cors    = require('cors');

const { pool, query, mode: dbMode } = require('./db');
const cadastroRouter  = require('./routes/cadastro');
const usuariosRouter  = require('./routes/usuarios');
const authRouter      = require('./routes/auth');
const imoveisRouter   = require('./routes/imoveis');
const interessesRouter = require('./routes/interesses');
const propostasRouter  = require('./routes/propostas');
const cidadesRouter   = require('./routes/cidades');
const fotosRouter     = require('./routes/fotos');
const favoritosRouter = require('./routes/favoritos');
const notificacoesRouter = require('./routes/notificacoes');
const path            = require('path');
const fs              = require('fs');
const siteConfig      = require('./lib/site-config');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

// ---- Middlewares
// Limite alto porque o POST /api/imoveis aceita fotos em data URL dentro do JSON.
// (Há também endpoints multipart separados em /api/imoveis/:id/fotos e /documentos
//  que recebem FormData e usam os limites padrão do multer/busboy — esses não
//  passam por aqui.)
app.use(express.json({
  limit: '50mb',
  // O corpo cru só é guardado no webhook: é dele que sai a assinatura
  // X-Hub-Signature-256 que a Meta manda. Nas outras rotas seria peso à toa.
  verify: (req, res, buf) => {
    if (String(req.originalUrl || '').startsWith('/webhooks/whatsapp')) req.rawBody = buf;
  },
}));

// Desabilita cache para todas as requisições de API
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// CORS: aceita lista separada por vírgula ou '*' pra liberar geral
const corsOrigin = (process.env.CORS_ORIGIN || '*').trim();
app.use(cors({
  origin: corsOrigin === '*' ? true : corsOrigin.split(',').map(s => s.trim()),
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
}));

// Loga cada requisição em dev
if ((process.env.NODE_ENV || 'development') !== 'production') {
  app.use((req, _res, next) => {
    console.log(`[req] ${req.method} ${req.url}`);
    next();
  });
}

// ---- Health check
app.get('/api/health', async (_req, res) => {
  try {
    const r = await query('SELECT NOW() AS now, version()');
    return res.json({
      ok: true,
      db: 'up',
      mode: dbMode,
      now: r.rows[0].now,
      pg_version: r.rows[0].version,
    });
  } catch (err) {
    return res.status(503).json({ ok: false, db: 'down', error: err.message });
  }
});

// ---- GET /api/geocode?q=...
app.get('/api/geocode', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ ok: false, error: 'Passe o parâmetro q.' });

  try {
    // 1. Tenta ArcGIS (muito preciso para números e CEPs no Brasil)
    const arcgisUrl = 'https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates' +
      '?f=json&outFields=Addr_type,Match_addr,StAddr,City&maxLocations=5&singleLine=' + encodeURIComponent(q);
    
    const arcgisRes = await fetch(arcgisUrl);
    if (arcgisRes.ok) {
      const data = await arcgisRes.json();
      if (data.candidates && data.candidates.length > 0) {
        const results = data.candidates.map(c => ({
          lat: String(c.location.y),
          lon: String(c.location.x),
          display_name: c.address,
          addresstype: c.attributes.Addr_type === 'PointAddress' ? 'house' : 'road',
          class: 'place',
          importance: c.score / 100
        }));
        return res.json({ ok: true, results });
      }
    }

    // 2. Fallback para Nominatim
    const response = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=5&q=' + encodeURIComponent(q), {
      headers: {
        'User-Agent': 'MoravoSite/1.0 (contact@moravo.com.br)',
        'Accept-Language': 'pt-BR'
      }
    });
    if (!response.ok) throw new Error('Nominatim HTTP error ' + response.status);
    const data = await response.json();
    return res.json({ ok: true, results: data });
  } catch (err) {
    console.error('[geocode] erro:', err.message);
    return res.status(500).json({ ok: false, error: 'Erro ao consultar geolocalização.' });
  }
});

const documentosRouter  = require('./routes/documentos');
const adminRouter       = require('./routes/admin');

// ---- Rotas
app.use('/api/cadastro',   cadastroRouter);
app.use('/api/usuarios',   usuariosRouter);
app.use('/api/auth',       authRouter);
app.use('/api/imoveis',    imoveisRouter);
app.use('/api/interesses', interessesRouter);
app.use('/api/propostas',  propostasRouter);
app.use('/api/cidades',    cidadesRouter);
app.use('/api/imoveis/:id/fotos', fotosRouter);
app.use('/api/imoveis/:id/documentos', documentosRouter);
app.use('/api/admin',      adminRouter);
app.use('/api/favoritos',  favoritosRouter);
app.use('/api/notificacoes', notificacoesRouter);
app.use('/api/avaliacoes',   require('./routes/avaliacoes'));
// Público de propósito: quem chama é a Meta. A autenticidade vem do
// verify token no handshake e da assinatura do corpo, não de JWT.
app.use('/webhooks/whatsapp', require('./routes/webhook-whatsapp'));

// =========================================================================
// Página de entrada no grupo de WhatsApp
// =========================================================================
// Aceita os dois formatos, porque o botão do template pode mandar qualquer
// um dos dois dependendo de como a URL dinâmica foi cadastrada na Meta:
//
//   /linkgrupo/<codigo>                          (sufixo no caminho)
//   /linkgrupo/?id=<codigo|interesse>&corretor=  (query string)
//
// O id é resolvido primeiro no banco, para pegar o título do imóvel e o
// convite atual. Se não achar, cai no código do convite direto, para o
// link continuar funcionando mesmo com o banco fora do ar.
// =========================================================================
const paginaGrupo = require('./lib/pagina-grupo');

// Resolve o que veio na URL. Ordem de preferência:
//   1. token nominal (o caminho normal, emitido por convite)
//   2. id do interesse (uso interno)
//   3. código do convite (compatibilidade com links antigos)
async function resolverGrupo(valor, ip) {
  if (!valor) return null;

  // 1. Token nominal: identifica a pessoa e registra a abertura
  try {
    const r = await query(
      `SELECT c.id, c.papel, c.revogado,
              i.grupo_whatsapp_link AS link,
              im.titulo, im.id AS imovel_id,
              u.nome AS pessoa
         FROM moravo.convites_grupo c
         JOIN moravo.interesses i ON i.id = c.interesse_id
         JOIN moravo.imoveis   im ON im.id = i.imovel_id
         JOIN moravo.usuarios   u ON u.id = c.usuario_id
        WHERE c.token = $1`,
      [valor]
    );
    if (r.rowCount) {
      const c = r.rows[0];
      if (c.revogado) return { revogado: true };
      await query(
        `UPDATE moravo.convites_grupo
            SET aberturas = aberturas + 1, aberto_em = NOW(), ultimo_ip = $2
          WHERE id = $1`,
        [c.id, ip || null]
      ).catch(function () {});
      return c;
    }
  } catch (err) {
    console.warn('[linkgrupo] falha ao consultar token:', err.message);
  }

  // Só token vale. Não existe atalho por id do interesse nem por código do
  // grupo: os dois seriam enumeráveis, e foi exatamente esse o risco levantado.
  // Nenhum link antigo ficou órfão porque o envio nunca chegou a funcionar.
  return null;
}

async function entregarPaginaGrupo(req, res, valor) {
  const chave = String(valor || '').trim();
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(chave)) {
    return res.status(400).type('html').send(paginaGrupo.paginaErro('Este link de convite não é válido.'));
  }

  const achado = await resolverGrupo(chave, req.ip);

  if (achado && achado.revogado) {
    return res.status(410).type('html').send(
      paginaGrupo.paginaErro('Este convite foi cancelado. Entre no painel para ver a negociação.'));
  }

  // O destino vem sempre do banco. Valor desconhecido não vira link nenhum:
  // sem isso, qualquer pessoa usaria o nosso domínio para dar aparência de
  // Moravo a um convite de grupo qualquer.
  const destino = paginaGrupo.destinoSeguro(achado && achado.link);

  if (!destino) {
    return res.status(404).type('html').send(
      paginaGrupo.paginaErro('Este convite não existe ou o grupo foi refeito.'));
  }

  // Nome e imóvel vêm do banco, nunca da URL: assim não dá para forjar a página
  // nem descobrir de quem é o convite mexendo nos parâmetros.
  const nome = achado.pessoa || '';
  const papel = achado.papel || '';
  const imovel = achado.titulo
    ? achado.titulo + (achado.imovel_id ? ' (imóvel ' + achado.imovel_id + ')' : '')
    : '';

  console.log('[linkgrupo] ' + (achado && achado.papel ? achado.papel : 'convite') +
              (nome ? ' ' + nome : '') + ' abriu o grupo');
  return res.type('html').send(paginaGrupo.render({
    destino: destino,
    nome: String(nome).slice(0, 60),
    imovel: String(imovel).slice(0, 120),
    papel: papel,
  }));
}

app.get('/linkgrupo', (req, res) => entregarPaginaGrupo(req, res, req.query.t || req.query.id));
app.get('/linkgrupo/:codigo', (req, res) => entregarPaginaGrupo(req, res, req.params.codigo));

// =========================================================================
// Página pública do imóvel: /imovel/<slug>/?id=<codigo>
// =========================================================================
// O slug existe para o Google e para a pessoa que lê o link; quem identifica
// o imóvel é sempre o código na query. Assim o preço pode mudar, o slug muda
// junto, e nenhum link já enviado deixa de funcionar.
//
// A página em si é a mesma detalhes.html. O que muda é que aqui o servidor
// preenche título, descrição, canonical e Open Graph com os dados reais do
// imóvel: sem isso o Google indexa a casca vazia, porque o conteúdo só
// aparece depois que o JavaScript busca a API.
const codigoImovel = require('./lib/codigo-imovel');

async function buscarImovelPublico(identificador) {
  const bruto = String(identificador || '');
  const ehId = /^\d+$/.test(bruto);
  if (!ehId && !codigoImovel.pareceCodigo(bruto)) return null;
  const r = await query(
    `SELECT id, codigo, titulo, tipo, preco, cidade, uf, bairro, quartos, banheiros,
            vagas, area_m2, descricao, fotos, status
       FROM moravo.imoveis
      WHERE ` + (ehId ? 'id = $1' : 'codigo = $1'),
    [ehId ? parseInt(bruto, 10) : bruto]
  );
  return r.rows[0] || null;
}

function escaparAttr(txt) {
  return String(txt == null ? '' : txt)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function metaDoImovel(im, urlCanonica) {
  const dinheiro = Number(im.preco || 0)
    .toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
  const local = [im.bairro, im.cidade, im.uf].filter(Boolean).join(', ');
  const titulo = `${im.titulo || 'Imóvel'} em ${im.cidade || 'Brasil'} por ${dinheiro} | Moravo`;

  const partes = [];
  if (im.quartos)   partes.push(im.quartos + (im.quartos > 1 ? ' quartos' : ' quarto'));
  if (im.banheiros) partes.push(im.banheiros + (im.banheiros > 1 ? ' banheiros' : ' banheiro'));
  if (im.vagas)     partes.push(im.vagas + (im.vagas > 1 ? ' vagas' : ' vaga'));
  if (im.area_m2)   partes.push(Math.round(im.area_m2) + ' m²');

  const descricao = (String(im.descricao || '').trim() ||
    `${(im.tipo || 'Imóvel')} à venda em ${local || 'Brasil'} por ${dinheiro}` +
    (partes.length ? '. ' + partes.join(', ') + '.' : '.') +
    ' Anuncie e negocie direto na Moravo.').slice(0, 300);

  let foto = '';
  try {
    const fotos = typeof im.fotos === 'string' ? JSON.parse(im.fotos) : (im.fotos || []);
    if (Array.isArray(fotos) && fotos[0]) {
      foto = String(fotos[0]).startsWith('http') ? fotos[0] : 'https://moravo.com.br/' + String(fotos[0]).replace(/^\/+/, '');
    }
  } catch (e) { /* imóvel sem foto não impede a página */ }

  const tags = [
    `<title>${escaparAttr(titulo)}</title>`,
    `<meta name="description" content="${escaparAttr(descricao)}" />`,
    `<link rel="canonical" href="${escaparAttr(urlCanonica)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:title" content="${escaparAttr(titulo)}" />`,
    `<meta property="og:description" content="${escaparAttr(descricao)}" />`,
    `<meta property="og:url" content="${escaparAttr(urlCanonica)}" />`,
    `<meta name="twitter:card" content="${foto ? 'summary_large_image' : 'summary'}" />`,
  ];
  if (foto) tags.push(`<meta property="og:image" content="${escaparAttr(foto)}" />`);
  // Imóvel vendido ou pausado não deveria disputar posição no Google
  if (im.status !== 'ativo') tags.push('<meta name="robots" content="noindex, follow" />');
  return tags.join('\n  ');
}

// Serve detalhes.html com as meta tags do imóvel no lugar das genéricas
async function servirPaginaImovel(req, res, next, identificador) {
  try {
    const im = await buscarImovelPublico(identificador);
    if (!im) return next();

    const arquivo = path.join(__dirname, 'public', 'detalhes.html');
    if (!fs.existsSync(arquivo)) return next();
    let html = fs.readFileSync(arquivo, 'utf8');

    const urlCanonica = 'https://moravo.com.br' + codigoImovel.urlImovel(im);
    // Tira o <title> genérico do arquivo para não ficarem dois
    html = html.replace(/<title>[\s\S]*?<\/title>/i, '');
    html = html.replace('</head>', () => '  ' + metaDoImovel(im, urlCanonica) + '\n</head>');

    const scripts = await siteConfig.getScripts().catch(() => ({}));
    if (scripts && (scripts.head_html || scripts.body_html)) {
      html = siteConfig.injetar(html, scripts);
    }
    res.type('html').send(html);
  } catch (err) {
    console.error('[imovel] falha ao montar a página, seguindo pelo caminho normal:', err.message);
    next();
  }
}

app.get('/imovel/:slug', (req, res, next) => {
  servirPaginaImovel(req, res, next, req.query.id);
});

// URL antiga: manda para a nova com 301, para o Google juntar as duas em uma
// só e para os links que já foram enviados continuarem valendo.
app.get(['/detalhes', '/detalhes.html'], async (req, res, next) => {
  try {
    const im = await buscarImovelPublico(req.query.id);
    if (!im || !im.codigo) return next();
    return res.redirect(301, codigoImovel.urlImovel(im));
  } catch (err) {
    return next();
  }
});

// ---- Foto do grupo, servida do banco (ou do repositório, se não houver)
// Existe para a prévia do painel do admin. É a mesma imagem que todo mundo
// que entra num grupo já vê, então não há o que proteger aqui.
app.get('/img/grupo', async (req, res) => {
  try {
    const foto = await require('./lib/foto-grupo').obterFotoGrupo();
    if (!foto) return res.sendStatus(404);
    res.type(foto.mimetype).set('Cache-Control', 'no-store').send(Buffer.from(foto.base64, 'base64'));
  } catch (err) {
    console.error('[img/grupo] erro:', err.message);
    res.sendStatus(500);
  }
});

// ---- sitemap.xml e robots.txt
// Os cards do site abrem por onclick, não por <a href>, então um buscador não
// tem por onde chegar aos imóveis navegando. O sitemap é o caminho que resta.
app.get('/sitemap.xml', async (req, res) => {
  const base = 'https://moravo.com.br';
  const fixas = ['/', '/busca', '/anuncie', '/cadastro', '/politica-de-privacidade', '/termos-de-uso'];
  try {
    const r = await query(
      `SELECT id, codigo, tipo, preco, cidade, updated_at, created_at
         FROM moravo.imoveis
        WHERE status = 'ativo' AND codigo IS NOT NULL
        ORDER BY id DESC LIMIT 5000`
    );
    const urls = fixas.map((u) => `  <url><loc>${base}${u}</loc></url>`);
    for (const im of r.rows) {
      const quando = im.updated_at || im.created_at;
      urls.push('  <url><loc>' + base + codigoImovel.urlImovel(im) + '</loc>' +
        (quando ? '<lastmod>' + new Date(quando).toISOString().slice(0, 10) + '</lastmod>' : '') +
        '</url>');
    }
    res.type('application/xml').send(
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls.join('\n') + '\n</urlset>\n'
    );
  } catch (err) {
    console.error('[sitemap] erro:', err.message);
    res.status(500).type('text/plain').send('erro ao montar o sitemap');
  }
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    'User-agent: *\n' +
    'Allow: /\n' +
    'Disallow: /admin\n' +
    'Disallow: /dashboard\n' +
    'Disallow: /linkgrupo\n' +
    'Disallow: /webhooks\n\n' +
    'Sitemap: https://moravo.com.br/sitemap.xml\n'
  );
});

// ---- Injeção dos scripts de terceiros (Tag Manager e afins)
// Precisa vir ANTES do express.static: intercepta só as páginas HTML, insere o
// que o admin configurou e devolve. Qualquer outro arquivo segue o caminho normal.
const PUBLIC_DIR = path.join(__dirname, 'public');

app.get('*', async (req, res, next) => {
  try {
    if (req.path.startsWith('/uploads') || req.path.startsWith('/api')) return next();

    // Resolve a URL para um arquivo .html dentro de public/ (inclui URL limpa)
    let relativo = req.path === '/' ? 'index.html' : decodeURIComponent(req.path).replace(/^\/+/, '');
    if (!path.extname(relativo)) relativo += '.html';
    if (path.extname(relativo).toLowerCase() !== '.html') return next();

    const arquivo = path.join(PUBLIC_DIR, relativo);
    if (!arquivo.startsWith(PUBLIC_DIR + path.sep)) return next(); // barra path traversal
    if (!fs.existsSync(arquivo)) return next();

    // O painel do admin fica de fora: não faz sentido rastrear uso interno
    if (relativo === 'admin.html') return next();

    const scripts = await siteConfig.getScripts();
    if (!scripts.head_html && !scripts.body_html) return next();

    const html = siteConfig.injetar(fs.readFileSync(arquivo, 'utf8'), scripts);
    res.type('html').send(html);
  } catch (err) {
    console.error('[scripts] falha ao injetar, servindo a página original:', err.message);
    next();
  }
});

// Servir o front-end estático (HTML, CSS, JS, img, etc.) com suporte a URLs Limpas
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Servir as fotos como arquivos estáticos
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ---- 404
app.use((_req, res) => res.status(404).json({ ok: false, error: 'Rota não encontrada.' }));

// ---- Erros globais
app.use((err, _req, res, _next) => {
  console.error('[express] erro não tratado:', err);
  res.status(500).json({ ok: false, error: 'Erro interno do servidor.' });
});

// ---- Sobe o servidor
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`[moravo] API escutando em http://0.0.0.0:${PORT}`);
  console.log(`[moravo] Health: http://0.0.0.0:${PORT}/api/health`);
  
  if (dbMode !== 'json-stub') {
    // -----------------------------------------------------------------------
    // Migrações de boot.
    // Cada uma roda isolada: se uma falhar, registra o erro e as demais seguem.
    // (Antes era um try/catch único e a primeira falha abortava todo o resto,
    //  em silêncio. Foi assim que o conflito da matrícula escondeu 7 migrações.)
    // -----------------------------------------------------------------------
    const falhas = [];
    async function migrar(nome, sql) {
      try {
        return await query(sql);
      } catch (err) {
        falhas.push(nome);
        console.error(`[moravo][migração: ${nome}] falhou: ${err.message}`);
        return null;
      }
    }

    await migrar('imoveis.interesses_compradores',
      'ALTER TABLE moravo.imoveis ADD COLUMN IF NOT EXISTS interesses_compradores INT DEFAULT 0;');

    await migrar('usuarios.foto_perfil',
      'ALTER TABLE moravo.usuarios ADD COLUMN IF NOT EXISTS foto_perfil TEXT;');

    // Colunas do grupo de WhatsApp (Waha) na tabela interesses
    await migrar('interesses.grupo_whatsapp', `
      ALTER TABLE moravo.interesses
        ADD COLUMN IF NOT EXISTS grupo_whatsapp_id         TEXT,
        ADD COLUMN IF NOT EXISTS grupo_whatsapp_link       TEXT,
        ADD COLUMN IF NOT EXISTS grupo_whatsapp_created_at TIMESTAMPTZ;
    `);

    await migrar('interesses.idx_grupo_whatsapp', `
      CREATE INDEX IF NOT EXISTS idx_interesses_grupo_whatsapp_id
        ON moravo.interesses (grupo_whatsapp_id)
        WHERE grupo_whatsapp_id IS NOT NULL;
    `);

    await migrar('tabela interesses_compradores', `
      CREATE TABLE IF NOT EXISTS moravo.interesses_compradores (
        id BIGSERIAL PRIMARY KEY,
        imovel_id BIGINT NOT NULL REFERENCES moravo.imoveis(id) ON DELETE CASCADE,
        comprador_id BIGINT NOT NULL REFERENCES moravo.usuarios(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uk_interesse_comprador_unico UNIQUE (imovel_id, comprador_id)
      );
    `);

    await migrar('tabela notificacoes', `
      CREATE TABLE IF NOT EXISTS moravo.notificacoes (
        id BIGSERIAL PRIMARY KEY,
        usuario_id BIGINT NOT NULL REFERENCES moravo.usuarios(id) ON DELETE CASCADE,
        tipo TEXT NOT NULL,
        imovel_id BIGINT REFERENCES moravo.imoveis(id) ON DELETE CASCADE,
        interesse_id BIGINT REFERENCES moravo.interesses(id) ON DELETE SET NULL,
        remetente_id BIGINT REFERENCES moravo.usuarios(id) ON DELETE SET NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        lida BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await migrar('notificacoes.indice', `
      CREATE INDEX IF NOT EXISTS idx_notif_usuario_lida
        ON moravo.notificacoes (usuario_id, lida, created_at DESC);
    `);

    // Dados legais/administrativos do imóvel (passo 2 do cadastro).
    // matricula fica NULLABLE de propósito: no banco, "sem matrícula" é NULL.
    // A constraint imoveis_matricula_chk proíbe string vazia, então nada aqui
    // pode gravar '' — nem como default, nem normalizando registros antigos.
    await migrar('imoveis.dados_legais', `
      ALTER TABLE moravo.imoveis
        ADD COLUMN IF NOT EXISTS matricula             TEXT,
        ADD COLUMN IF NOT EXISTS escritura_texto       TEXT,
        ADD COLUMN IF NOT EXISTS escritura_arquivo_url TEXT,
        ADD COLUMN IF NOT EXISTS condominio            BOOLEAN     NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS valor_condominio      NUMERIC(14, 2);
    `);

    // Normaliza perfis legados (ex.: 'comprador') antes de ampliar o CHECK
    await migrar('usuarios.normaliza_perfis', `
      UPDATE moravo.usuarios
      SET perfil = 'proprietario'
      WHERE perfil IS NOT NULL
        AND perfil NOT IN ('proprietario', 'corretor', 'admin');
    `);
    await migrar('usuarios.perfil_check_drop',
      'ALTER TABLE moravo.usuarios DROP CONSTRAINT IF EXISTS usuarios_perfil_check;');
    await migrar('usuarios.perfil_check_add', `
      ALTER TABLE moravo.usuarios
        ADD CONSTRAINT usuarios_perfil_check
        CHECK (perfil IN ('proprietario', 'corretor', 'admin'));
    `);

    // Dados de aprovação de imóveis
    await migrar('imoveis.status_aprovacao', `
      ALTER TABLE moravo.imoveis
        ADD COLUMN IF NOT EXISTS status_aprovacao  TEXT NOT NULL DEFAULT 'pendente'
          CHECK (status_aprovacao IN ('pendente', 'aprovado', 'reprovado')),
        ADD COLUMN IF NOT EXISTS aprovado_por       BIGINT REFERENCES moravo.usuarios(id),
        ADD COLUMN IF NOT EXISTS aprovado_em        TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS reprovado_motivo  TEXT,
        ADD COLUMN IF NOT EXISTS reprovado_em      TIMESTAMPTZ;
    `);
    await migrar('imoveis.idx_status_aprovacao', `
      CREATE INDEX IF NOT EXISTS idx_imoveis_status_aprovacao
        ON moravo.imoveis (status_aprovacao, created_at DESC);
    `);

    // Auditoria de logins do admin
    await migrar('tabela admin_login_logs', `
      CREATE TABLE IF NOT EXISTS moravo.admin_login_logs (
        id          BIGSERIAL PRIMARY KEY,
        usuario_id  BIGINT REFERENCES moravo.usuarios(id) ON DELETE SET NULL,
        email       TEXT NOT NULL,
        sucesso     BOOLEAN NOT NULL,
        ip          INET,
        user_agent  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await migrar('admin_login_logs.indice', `
      CREATE INDEX IF NOT EXISTS idx_admin_login_logs_created
        ON moravo.admin_login_logs (created_at DESC);
    `);

    // Tentativas de criação do grupo, com a etapa em que parou. Sem isso o erro
    // só existia no log do servidor: invisível no painel e impossível de repetir.
    await migrar('tabela grupo_tentativas', `
      CREATE TABLE IF NOT EXISTS moravo.grupo_tentativas (
        id            BIGSERIAL PRIMARY KEY,
        interesse_id  BIGINT NOT NULL REFERENCES moravo.interesses(id) ON DELETE CASCADE,
        etapa         TEXT NOT NULL,
        status        TEXT NOT NULL CHECK (status IN ('erro', 'ok')),
        erro          TEXT,
        detalhe       JSONB NOT NULL DEFAULT '{}'::jsonb,
        tentativas    INT NOT NULL DEFAULT 1,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uk_tentativa_por_interesse UNIQUE (interesse_id)
      );
    `);
    await migrar('grupo_tentativas.indice', `
      CREATE INDEX IF NOT EXISTS idx_grupo_tentativas_status
        ON moravo.grupo_tentativas (status, atualizado_em DESC);
    `);

    // Convites nominais para o grupo. Cada destinatário recebe um token
    // aleatório e próprio, em vez do código do convite do WhatsApp. Assim o
    // link não é adivinhável, sabemos quem abriu e dá para revogar um sem
    // afetar o outro.
    await migrar('tabela convites_grupo', `
      CREATE TABLE IF NOT EXISTS moravo.convites_grupo (
        id           BIGSERIAL PRIMARY KEY,
        token        TEXT NOT NULL UNIQUE,
        interesse_id BIGINT NOT NULL REFERENCES moravo.interesses(id) ON DELETE CASCADE,
        usuario_id   BIGINT NOT NULL REFERENCES moravo.usuarios(id)   ON DELETE CASCADE,
        papel        TEXT NOT NULL CHECK (papel IN ('proprietario','corretor')),
        revogado     BOOLEAN NOT NULL DEFAULT false,
        aberturas    INT NOT NULL DEFAULT 0,
        aberto_em    TIMESTAMPTZ,
        ultimo_ip    INET,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uk_convite_por_pessoa UNIQUE (interesse_id, usuario_id)
      );
    `);
    await migrar('convites_grupo.indice', `
      CREATE INDEX IF NOT EXISTS idx_convites_grupo_token ON moravo.convites_grupo (token);
    `);

    // Propostas de compra. É a proposta que dispara o grupo de WhatsApp:
    // antes dela o corretor trabalha o imóvel sem acionar o proprietário.
    await migrar('tabela propostas', `
      CREATE TABLE IF NOT EXISTS moravo.propostas (
        id              BIGSERIAL PRIMARY KEY,
        imovel_id       BIGINT NOT NULL REFERENCES moravo.imoveis(id)   ON DELETE CASCADE,
        corretor_id     BIGINT NOT NULL REFERENCES moravo.usuarios(id)  ON DELETE CASCADE,
        interesse_id    BIGINT REFERENCES moravo.interesses(id)         ON DELETE SET NULL,
        valor           NUMERIC(14,2) NOT NULL CHECK (valor >= 0),
        forma_pagamento TEXT NOT NULL DEFAULT 'a_combinar'
                        CHECK (forma_pagamento IN ('a_vista','financiado','permuta','a_combinar')),
        entrada         NUMERIC(14,2),
        comprador_nome  TEXT,
        observacoes     TEXT,
        validade        DATE,
        status          TEXT NOT NULL DEFAULT 'enviada'
                        CHECK (status IN ('enviada','aceita','recusada','cancelada')),
        grupo_criado    BOOLEAN NOT NULL DEFAULT false,
        resposta_motivo TEXT,
        respondido_em   TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await migrar('propostas.indices', `
      CREATE INDEX IF NOT EXISTS idx_propostas_imovel   ON moravo.propostas (imovel_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_propostas_corretor ON moravo.propostas (corretor_id, created_at DESC);
    `);

    // Carteira do corretor: candidaturas antigas em 'pendente' passam a valer
    // como imóvel em carteira, já que o aceite do proprietário deixou de existir.
    await migrar('interesses.pendente_vira_carteira', `
      UPDATE moravo.interesses SET status = 'aceito' WHERE status = 'pendente';
    `);

    // Scripts de terceiros (Tag Manager, pixels) injetados nas páginas públicas.
    // Linha única (id = 1), editada em /admin -> Configurações.
    await migrar('tabela config_site', `
      CREATE TABLE IF NOT EXISTS moravo.config_site (
        id             SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        head_html      TEXT,
        body_html      TEXT,
        atualizado_por BIGINT REFERENCES moravo.usuarios(id) ON DELETE SET NULL,
        atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await migrar('config_site.linha_inicial', `
      INSERT INTO moravo.config_site (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
    `);

    // Configuração da WhatsApp Cloud API (preenchida pelo painel do admin).
    // Linha única (id = 1). O token é gravado cifrado, nunca em texto puro.
    await migrar('tabela config_whatsapp', `
      CREATE TABLE IF NOT EXISTS moravo.config_whatsapp (
        id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        phone_number_id TEXT,
        waba_id         TEXT,
        api_version     TEXT NOT NULL DEFAULT 'v23.0',
        token_cifrado   TEXT,
        template_nome   TEXT NOT NULL DEFAULT 'convite_grupo_proprietario',
        template_idioma TEXT NOT NULL DEFAULT 'pt_BR',
        ativo           BOOLEAN NOT NULL DEFAULT false,
        atualizado_por  BIGINT REFERENCES moravo.usuarios(id) ON DELETE SET NULL,
        atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await migrar('config_whatsapp.linha_inicial', `
      INSERT INTO moravo.config_whatsapp (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
    `);

    // Conexão do Waha configurável pelo painel. Antes só existia em variável de
    // ambiente, com padrão embutido no código: quem esquecesse WAHA_SESSION no
    // .env ficava usando outra sessão sem nunca ser avisado.
    await migrar('config_whatsapp.waha', `
      ALTER TABLE moravo.config_whatsapp
        ADD COLUMN IF NOT EXISTS waha_url       TEXT,
        ADD COLUMN IF NOT EXISTS waha_sessao    TEXT,
        ADD COLUMN IF NOT EXISTS waha_atendente TEXT,
        ADD COLUMN IF NOT EXISTS waha_extras    TEXT,
        ADD COLUMN IF NOT EXISTS template_corretor TEXT,
        ADD COLUMN IF NOT EXISTS waha_api_key_cifrada TEXT;
    `);

    // Log de envios do convite pelo WhatsApp (alimenta a tela de erros do admin)
    await migrar('tabela whatsapp_envios', `
      CREATE TABLE IF NOT EXISTS moravo.whatsapp_envios (
        id              BIGSERIAL PRIMARY KEY,
        interesse_id    BIGINT REFERENCES moravo.interesses(id) ON DELETE SET NULL,
        destinatario_id BIGINT REFERENCES moravo.usuarios(id)   ON DELETE SET NULL,
        papel           TEXT,
        telefone        TEXT,
        template        TEXT,
        codigo_convite  TEXT,
        status          TEXT NOT NULL CHECK (status IN ('enviado', 'falhou')),
        wamid           TEXT,
        erro            TEXT,
        tentativas      INT NOT NULL DEFAULT 1,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await migrar('whatsapp_envios.indices', `
      CREATE INDEX IF NOT EXISTS idx_whatsapp_envios_status
        ON moravo.whatsapp_envios (status, created_at DESC);
    `);

    // Status de ENTREGA, que é coisa diferente de status de envio: 'enviado'
    // só diz que a Meta aceitou a chamada. Quem conta se chegou é o webhook.
    await migrar('whatsapp_envios.entrega', `
      ALTER TABLE moravo.whatsapp_envios
        ADD COLUMN IF NOT EXISTS entrega      TEXT,
        ADD COLUMN IF NOT EXISTS entrega_erro TEXT,
        ADD COLUMN IF NOT EXISTS entrega_em   TIMESTAMPTZ;
    `);
    await migrar('whatsapp_envios.idx_wamid', `
      CREATE INDEX IF NOT EXISTS idx_whatsapp_envios_wamid
        ON moravo.whatsapp_envios (wamid);
    `);
    await migrar('config_whatsapp.foto_grupo', `
      ALTER TABLE moravo.config_whatsapp
        ADD COLUMN IF NOT EXISTS foto_grupo      TEXT,
        ADD COLUMN IF NOT EXISTS foto_grupo_mime TEXT,
        ADD COLUMN IF NOT EXISTS foto_grupo_em   TIMESTAMPTZ;
    `);
    await migrar('config_whatsapp.webhook', `
      ALTER TABLE moravo.config_whatsapp
        ADD COLUMN IF NOT EXISTS webhook_token      TEXT,
        ADD COLUMN IF NOT EXISTS app_secret_cifrado TEXT;
    `);
    // Token do handshake: gerado sozinho para não depender de o admin inventar um
    try {
      const semToken = await query(
        `SELECT id FROM moravo.config_whatsapp WHERE id = 1 AND coalesce(webhook_token, '') = ''`
      );
      if (semToken.rowCount) {
        await query(
          `UPDATE moravo.config_whatsapp SET webhook_token = $1 WHERE id = 1`,
          [require('crypto').randomBytes(16).toString('hex')]
        );
      }
    } catch (err) {
      console.warn('[migração] webhook_token:', err.message);
    }

    // Código público do imóvel: aleatório, para o id sequencial parar de ser
    // a identificação que circula em link e em nome de grupo.
    await migrar('imoveis.codigo', `
      ALTER TABLE moravo.imoveis ADD COLUMN IF NOT EXISTS codigo TEXT;
    `);
    await migrar('imoveis.codigo_unico', `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_imoveis_codigo
        ON moravo.imoveis (codigo) WHERE codigo IS NOT NULL;
    `);
    // Preenche quem ficou sem código. Um de cada vez porque o código é
    // sorteado: colisão é improvável, mas tem que ser tratada, não ignorada.
    try {
      const { gerarCodigo } = require('./lib/codigo-imovel');
      const semCodigo = await query(
        `SELECT id FROM moravo.imoveis WHERE codigo IS NULL ORDER BY id`
      );
      for (const linha of semCodigo.rows) {
        for (let tentativa = 0; tentativa < 5; tentativa++) {
          try {
            await query(`UPDATE moravo.imoveis SET codigo = $1 WHERE id = $2`,
                        [gerarCodigo(), linha.id]);
            break;
          } catch (err) {
            if (tentativa === 4) console.warn('[migração] código do imóvel ' + linha.id + ':', err.message);
          }
        }
      }
      if (semCodigo.rowCount) console.log('[moravo] código gerado para ' + semCodigo.rowCount + ' imóvel(is).');
    } catch (err) {
      console.warn('[migração] backfill de código:', err.message);
    }

    // Estado do usuário. Só o imóvel tinha UF; o corretor tinha "região de
    // atuação" em texto livre, que não dá para cruzar com nada.
    await migrar('usuarios.uf', `
      ALTER TABLE moravo.usuarios ADD COLUMN IF NOT EXISTS uf TEXT;
    `);
    await migrar('usuarios.creci_verificado', `
      ALTER TABLE moravo.usuarios
        ADD COLUMN IF NOT EXISTS creci_verificado     BOOLEAN NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS creci_verificado_em  TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS creci_verificado_por BIGINT REFERENCES moravo.usuarios(id) ON DELETE SET NULL;
    `);
    await migrar('usuarios.idx_uf_cidade', `
      CREATE INDEX IF NOT EXISTS idx_usuarios_uf_cidade
        ON moravo.usuarios (perfil, uf, cidade);
    `);

    // Preenche a UF de quem já estava cadastrado, para a faixa "mesma cidade
    // e mesmo estado" não nascer vazia. Só onde dá para deduzir com certeza:
    // corretor pela região de atuação ("Joinville - SC"), proprietário pelo
    // estado dos imóveis dele. Quem não se encaixa fica NULL e cai nas faixas
    // seguintes, que é o comportamento correto para dado que não se sabe.
    await migrar('usuarios.uf backfill', `
      UPDATE moravo.usuarios u
         SET uf = upper(substring(u.regiao_atuacao from '([A-Za-z]{2})\\s*$'))
       WHERE u.uf IS NULL
         AND u.perfil = 'corretor'
         AND upper(substring(u.regiao_atuacao from '([A-Za-z]{2})\\s*$')) IN (
           'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA',
           'PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO');
    `);
    await migrar('usuarios.uf backfill dono', `
      UPDATE moravo.usuarios u
         SET uf = d.uf
        FROM (
          SELECT dono_id, uf, row_number() OVER (PARTITION BY dono_id ORDER BY count(*) DESC) AS pos
            FROM moravo.imoveis WHERE uf IS NOT NULL GROUP BY dono_id, uf
        ) d
       WHERE d.dono_id = u.id AND d.pos = 1 AND u.uf IS NULL;
    `);

    // O atendimento do comprador: quem quer comprar, qual imóvel, qual
    // corretor está atendendo e qual o grupo. É o par do 'interesses' (que é
    // a carteira do corretor), só que do outro lado da mesa.
    await migrar('interesses_compradores.atendimento', `
      ALTER TABLE moravo.interesses_compradores
        ADD COLUMN IF NOT EXISTS corretor_id          BIGINT REFERENCES moravo.usuarios(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS status               TEXT NOT NULL DEFAULT 'aguardando_corretor',
        ADD COLUMN IF NOT EXISTS grupo_whatsapp_id    TEXT,
        ADD COLUMN IF NOT EXISTS grupo_whatsapp_link  TEXT,
        ADD COLUMN IF NOT EXISTS atribuido_em         TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS entrou_em            TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS rodada               INT NOT NULL DEFAULT 0;
    `);
    await migrar('interesses_compradores.idx_status', `
      CREATE INDEX IF NOT EXISTS idx_interesses_compradores_status
        ON moravo.interesses_compradores (status, atribuido_em);
    `);

    // Histórico de cada oferta feita a um corretor. Não muda nada hoje: existe
    // para que o ranking, quando chegar, tenha meses de comportamento real em
    // vez de começar do zero. Isso não dá para reconstruir depois.
    await migrar('tabela ofertas_corretor', `
      CREATE TABLE IF NOT EXISTS moravo.ofertas_corretor (
        id             BIGSERIAL PRIMARY KEY,
        atendimento_id BIGINT NOT NULL REFERENCES moravo.interesses_compradores(id) ON DELETE CASCADE,
        corretor_id    BIGINT NOT NULL REFERENCES moravo.usuarios(id) ON DELETE CASCADE,
        imovel_id      BIGINT REFERENCES moravo.imoveis(id) ON DELETE SET NULL,
        rodada         INT NOT NULL DEFAULT 1,
        criterio       TEXT,
        desfecho       TEXT NOT NULL DEFAULT 'aberta'
                       CHECK (desfecho IN ('aberta','entrou','expirou','recusou')),
        ofertada_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        respondida_em  TIMESTAMPTZ,
        minutos_uteis  INT
      );
    `);
    await migrar('ofertas_corretor.indices', `
      CREATE INDEX IF NOT EXISTS idx_ofertas_corretor_corretor
        ON moravo.ofertas_corretor (corretor_id, desfecho);
      CREATE INDEX IF NOT EXISTS idx_ofertas_corretor_abertas
        ON moravo.ofertas_corretor (desfecho, ofertada_em) WHERE desfecho = 'aberta';
    `);

    // Nota de 1 a 5 que o proprietário dá ao corretor. Uma por par, editável.
    await migrar('tabela avaliacoes_corretor', `
      CREATE TABLE IF NOT EXISTS moravo.avaliacoes_corretor (
        id            BIGSERIAL PRIMARY KEY,
        corretor_id   BIGINT NOT NULL REFERENCES moravo.usuarios(id) ON DELETE CASCADE,
        autor_id      BIGINT NOT NULL REFERENCES moravo.usuarios(id) ON DELETE CASCADE,
        imovel_id     BIGINT REFERENCES moravo.imoveis(id) ON DELETE SET NULL,
        nota          INT NOT NULL CHECK (nota BETWEEN 1 AND 5),
        comentario    TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uk_avaliacao_por_imovel UNIQUE (corretor_id, autor_id, imovel_id)
      );
    `);
    await migrar('avaliacoes_corretor.idx', `
      CREATE INDEX IF NOT EXISTS idx_avaliacoes_corretor
        ON moravo.avaliacoes_corretor (corretor_id);
    `);

    // Ronda que repassa o lead do comprador quando o corretor não entra no
    // grupo dentro de 1 hora útil. Cinco minutos é folga suficiente para um
    // prazo de uma hora e mantém o banco quieto.
    try {
      const atendimento = require('./lib/atendimento');
      setInterval(() => {
        atendimento.repassarVencidos().catch((err) =>
          console.error('[atendimento] ronda falhou:', err.message));
      }, 5 * 60 * 1000).unref();
      console.log('[moravo] ronda de repasse de atendimento a cada 5 min.');
    } catch (err) {
      console.warn('[moravo] ronda de atendimento não iniciada:', err.message);
    }

    // Seed: usuário mestre admin (idempotente - só cria se não existir)
    try {
      const adminExists = await query(
        `SELECT id FROM moravo.usuarios WHERE email = $1`,
        ['admin@moravo.local']
      );
      if (adminExists.rowCount === 0) {
        const bcrypt = require('bcrypt');
        const adminHash = await bcrypt.hash('admin1234', 10);
        await query(
          `INSERT INTO moravo.usuarios
             (nome, email, whatsapp, cidade, perfil, senha_hash)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          ['admin', 'admin@moravo.local', '00000000000', 'Moravo HQ', 'admin', adminHash]
        );
        console.log('[moravo] Usuário mestre admin/admin1234 criado.');
      } else {
        console.log('[moravo] Usuário mestre admin já existe.');
      }
    } catch (err) {
      falhas.push('seed do admin');
      console.error('[moravo][migração: seed do admin] falhou:', err.message);
    }

    // Limpeza de links wa.me antigos (não funcionam para grupos)
    const limpeza = await migrar('limpeza wa.me', `
      UPDATE moravo.interesses
      SET grupo_whatsapp_link = NULL
      WHERE grupo_whatsapp_link LIKE 'https://wa.me/%'
    `);
    if (limpeza) {
      console.log('[moravo] ' + limpeza.rowCount + ' link(s) wa.me antigo(s) limpo(s).');
    }

    if (falhas.length === 0) {
      console.log('[moravo] Banco: todas as migrações verificadas com sucesso.');
    } else {
      console.warn(`[moravo] Banco: ${falhas.length} migração(ões) falharam: ${falhas.join(', ')}`);
    }
  }
});
