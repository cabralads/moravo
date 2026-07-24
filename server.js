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
// Limite alto porque o POST /api/imoveis aceita fotos em data URL dentro do JSON.
// (Há também endpoints multipart separados em /api/imoveis/:id/fotos e /documentos
//  que recebem FormData e usam os limites padrão do multer/busboy — esses não
//  passam por aqui.)
app.use(express.json({ limit: '50mb' }));

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
app.use('/api/cidades',    cidadesRouter);
app.use('/api/imoveis/:id/fotos', fotosRouter);
app.use('/api/imoveis/:id/documentos', documentosRouter);
app.use('/api/admin',      adminRouter);
app.use('/api/favoritos',  favoritosRouter);
app.use('/api/notificacoes', notificacoesRouter);

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
    try {
      await query('ALTER TABLE moravo.imoveis ADD COLUMN IF NOT EXISTS interesses_compradores INT DEFAULT 0;');
      await query('ALTER TABLE moravo.usuarios ADD COLUMN IF NOT EXISTS foto_perfil TEXT;');
      // Migração: colunas do grupo de WhatsApp (Waha) na tabela interesses
      await query(`
        ALTER TABLE moravo.interesses
          ADD COLUMN IF NOT EXISTS grupo_whatsapp_id         TEXT,
          ADD COLUMN IF NOT EXISTS grupo_whatsapp_link       TEXT,
          ADD COLUMN IF NOT EXISTS grupo_whatsapp_created_at TIMESTAMPTZ;
      `);
      await query(`
        CREATE INDEX IF NOT EXISTS idx_interesses_grupo_whatsapp_id
          ON moravo.interesses (grupo_whatsapp_id)
          WHERE grupo_whatsapp_id IS NOT NULL;
      `);
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
      // Migração: dados legais/administrativos do imóvel (passo 2 do cadastro)
      await query(`
        ALTER TABLE moravo.imoveis
          ADD COLUMN IF NOT EXISTS matricula             TEXT        NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS escritura_texto       TEXT,
          ADD COLUMN IF NOT EXISTS escritura_arquivo_url TEXT,
          ADD COLUMN IF NOT EXISTS condominio            BOOLEAN     NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS valor_condominio      NUMERIC(14, 2);
      `);
      await query(`UPDATE moravo.imoveis SET matricula = '' WHERE matricula IS NULL;`);

      // Migração: ampliar CHECK constraint do perfil para incluir 'admin'.
      // Antes, normalizar perfis legados (ex.: 'comprador') para 'proprietario'
      // para não violar o novo CHECK.
      await query(`
        UPDATE moravo.usuarios
        SET perfil = 'proprietario'
        WHERE perfil IS NOT NULL
          AND perfil NOT IN ('proprietario', 'corretor', 'admin');
      `);
      await query(`ALTER TABLE moravo.usuarios DROP CONSTRAINT IF EXISTS usuarios_perfil_check;`);
      await query(`
        ALTER TABLE moravo.usuarios
          ADD CONSTRAINT usuarios_perfil_check
          CHECK (perfil IN ('proprietario', 'corretor', 'admin'));
      `);

      // Migração: dados de aprovação de imóveis (status_aprovacao, aprovado_*, reprovado_*)
      await query(`
        ALTER TABLE moravo.imoveis
          ADD COLUMN IF NOT EXISTS status_aprovacao  TEXT NOT NULL DEFAULT 'pendente'
            CHECK (status_aprovacao IN ('pendente', 'aprovado', 'reprovado')),
          ADD COLUMN IF NOT EXISTS aprovado_por       BIGINT REFERENCES moravo.usuarios(id),
          ADD COLUMN IF NOT EXISTS aprovado_em        TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS reprovado_motivo  TEXT,
          ADD COLUMN IF NOT EXISTS reprovado_em      TIMESTAMPTZ;
      `);
      await query(`
        CREATE INDEX IF NOT EXISTS idx_imoveis_status_aprovacao
          ON moravo.imoveis (status_aprovacao, created_at DESC);
      `);

      // Migração: tabela de auditoria de logins do admin
      await query(`
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
      await query(`
        CREATE INDEX IF NOT EXISTS idx_admin_login_logs_created
          ON moravo.admin_login_logs (created_at DESC);
      `);

      // Seed: usuário mestre admin (idempotente — só cria se não existir)
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

      console.log('[moravo] Banco: tabelas/colunas verificadas/criadas (interesses_compradores, notificacoes, grupo_whatsapp_*, foto_perfil, matricula, escritura_*, condominio, admin_login_logs, status_aprovacao).');
      console.log('[moravo] Limpando links wa.me antigos do banco...');
      await query(`
        UPDATE moravo.interesses
        SET grupo_whatsapp_link = NULL
        WHERE grupo_whatsapp_link LIKE 'https://wa.me/%'
      `).then((r) => {
        console.log('[moravo] ' + r.rowCount + ' link(s) wa.me antigo(s) limpo(s).');
      }).catch((err) => {
        console.warn('[moravo] falha ao limpar links wa.me:', err.message);
      });
    } catch (err) {
      console.error('[moravo] Erro ao atualizar banco:', err.message);
    }
  }
});
