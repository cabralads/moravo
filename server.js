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
const cidadesRouter   = require('./routes/cidades');
const fotosRouter     = require('./routes/fotos');
const favoritosRouter = require('./routes/favoritos');
const notificacoesRouter = require('./routes/notificacoes');
const path            = require('path');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

// ---- Middlewares
app.use(express.json({ limit: '64kb' }));

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

// ---- Rotas
app.use('/api/cadastro',   cadastroRouter);
app.use('/api/usuarios',   usuariosRouter);
app.use('/api/auth',       authRouter);
app.use('/api/imoveis',    imoveisRouter);
app.use('/api/interesses', interessesRouter);
app.use('/api/cidades',    cidadesRouter);
app.use('/api/imoveis/:id/fotos', fotosRouter);
app.use('/api/favoritos',  favoritosRouter);
app.use('/api/notificacoes', notificacoesRouter);

// Servir o front-end estático (HTML, CSS, JS, img, etc.)
app.use(express.static(path.join(__dirname, 'public')));

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
    try {
      await query('ALTER TABLE moravo.imoveis ADD COLUMN IF NOT EXISTS interesses_compradores INT DEFAULT 0;');
      await query('ALTER TABLE moravo.usuarios ADD COLUMN IF NOT EXISTS foto_perfil TEXT;');
      await query(`
        CREATE TABLE IF NOT EXISTS moravo.interesses_compradores (
          id BIGSERIAL PRIMARY KEY,
          imovel_id BIGINT NOT NULL REFERENCES moravo.imoveis(id) ON DELETE CASCADE,
          comprador_id BIGINT NOT NULL REFERENCES moravo.usuarios(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT uk_interesse_comprador_unico UNIQUE (imovel_id, comprador_id)
        );
      `);
      await query(`
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
      await query(`
        CREATE INDEX IF NOT EXISTS idx_notif_usuario_lida
          ON moravo.notificacoes (usuario_id, lida, created_at DESC);
      `);
      console.log('[moravo] Banco: tabelas interesses_compradores e notificacoes verificadas/criadas.');
    } catch (err) {
      console.error('[moravo] Erro ao atualizar banco:', err.message);
    }
  }
});
