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

    // Configuração da WhatsApp Cloud API (preenchida pelo painel do admin).
    // Linha única (id = 1). O token é gravado cifrado, nunca em texto puro.
    await migrar('tabela config_whatsapp', `
      CREATE TABLE IF NOT EXISTS moravo.config_whatsapp (
        id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        phone_number_id TEXT,
        waba_id         TEXT,
        api_version     TEXT NOT NULL DEFAULT 'v23.0',
        token_cifrado   TEXT,
        template_nome   TEXT NOT NULL DEFAULT 'link_grupo_convite',
        template_idioma TEXT NOT NULL DEFAULT 'pt_BR',
        ativo           BOOLEAN NOT NULL DEFAULT false,
        atualizado_por  BIGINT REFERENCES moravo.usuarios(id) ON DELETE SET NULL,
        atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await migrar('config_whatsapp.linha_inicial', `
      INSERT INTO moravo.config_whatsapp (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
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
