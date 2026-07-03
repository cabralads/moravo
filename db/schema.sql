-- =========================================================================
-- Moravo — Schema inicial do banco de usuários
-- Banco: Postgres 14 (container 1785a42610ec, senha 0agHjY031Iq3nFDu)
-- =========================================================================

-- Cria um schema dedicado pra isolar do public (boa prática)
CREATE SCHEMA IF NOT EXISTS moravo;
CREATE EXTENSION IF NOT EXISTS citext;
SET search_path TO moravo, public;

-- ----------------------------------------------------------------------------
-- Tabela principal: usuarios
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS moravo.usuarios (
    id              BIGSERIAL PRIMARY KEY,

    -- Identidade
    nome            TEXT        NOT NULL CHECK (char_length(nome) BETWEEN 2 AND 120),
    email           CITEXT      NOT NULL UNIQUE,           -- extensões: citext (case-insensitive)
    whatsapp        TEXT        NOT NULL,                  -- armazenado com DDD + número (só dígitos)
    cidade          TEXT        NOT NULL,

    -- Perfil: o que a pessoa vai fazer na plataforma
    -- 'proprietario' = usuário normal (pode anunciar imóvel e favoritar)
    -- 'corretor'     = perfil profissional (CRECI + região obrigatórios)
    perfil          TEXT        NOT NULL
                    CHECK (perfil IN ('proprietario', 'corretor')),

    -- Campos exclusivos de PROPRIETÁRIO
    tipo_imovel     TEXT        CHECK (
                        tipo_imovel IS NULL
                        OR tipo_imovel IN ('casa', 'apartamento', 'terreno', 'comercial', 'chacara', 'sitio')
                    ),
    preco_estimado  NUMERIC(14, 2) CHECK (preco_estimado IS NULL OR preco_estimado >= 0),

    -- Campos exclusivos de CORRETOR
    creci           TEXT        CHECK (creci ~ '^[0-9]+-?[A-Z]?$'),   -- ex: 12345-F
    regiao_atuacao  TEXT,

    -- Senha (hash bcrypt) — usada pra login
    senha_hash      TEXT,

    -- Metadados
    ip_cadastro     INET,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Regras de consistência: cada perfil tem seus próprios campos obrigatórios
    CONSTRAINT corretor_precisa_creci
        CHECK (perfil <> 'corretor' OR (creci IS NOT NULL AND char_length(creci) > 0)),
    CONSTRAINT corretor_precisa_regiao
        CHECK (perfil <> 'corretor' OR (regiao_atuacao IS NOT NULL AND char_length(regiao_atuacao) > 0))
);

-- Extension enabled at the top of the file

-- Índices
CREATE INDEX IF NOT EXISTS idx_usuarios_perfil        ON moravo.usuarios (perfil);
CREATE INDEX IF NOT EXISTS idx_usuarios_cidade        ON moravo.usuarios (cidade);
CREATE INDEX IF NOT EXISTS idx_usuarios_created_at    ON moravo.usuarios (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usuarios_creci         ON moravo.usuarios (creci)
    WHERE creci IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usuarios_whatsapp      ON moravo.usuarios (whatsapp);

-- Trigger: atualiza updated_at automaticamente
CREATE OR REPLACE FUNCTION moravo.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_usuarios_touch_updated_at ON moravo.usuarios;
CREATE TRIGGER trg_usuarios_touch_updated_at
    BEFORE UPDATE ON moravo.usuarios
    FOR EACH ROW
    EXECUTE FUNCTION moravo.touch_updated_at();


-- ----------------------------------------------------------------------------
-- Tabela: imoveis (anunciados pelos proprietários/corretores)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS moravo.imoveis (
    id          BIGSERIAL PRIMARY KEY,
    dono_id     BIGINT      NOT NULL REFERENCES moravo.usuarios(id) ON DELETE CASCADE,

    titulo      TEXT        NOT NULL CHECK (char_length(titulo) BETWEEN 3 AND 200),
    tipo        TEXT        NOT NULL
                CHECK (tipo IN ('casa', 'apartamento', 'terreno', 'comercial', 'chacara', 'sitio')),
    preco       NUMERIC(14, 2) NOT NULL CHECK (preco >= 0),

    -- Endereço completo (tudo obrigatório, exceto complemento)
    uf          TEXT        NOT NULL CHECK (uf ~ '^[A-Z]{2}$'),
    cep         TEXT        NOT NULL CHECK (cep ~ '^\d{5}-?\d{3}$'),
    rua         TEXT        NOT NULL CHECK (char_length(rua) BETWEEN 3 AND 200),
    numero      TEXT        NOT NULL CHECK (char_length(numero) BETWEEN 1 AND 20),
    complemento TEXT        CHECK (complemento IS NULL OR char_length(complemento) <= 100),
    bairro      TEXT        NOT NULL CHECK (char_length(bairro) BETWEEN 2 AND 100),
    cidade      TEXT        NOT NULL,

    area_m2     NUMERIC(10, 2) CHECK (area_m2 IS NULL OR area_m2 > 0),
    quartos     INTEGER     CHECK (quartos IS NULL OR quartos >= 0),
    banheiros   INTEGER     CHECK (banheiros IS NULL OR banheiros >= 0),
    vagas       INTEGER     CHECK (vagas IS NULL OR vagas >= 0),

    descricao   TEXT,
    fotos       JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- array de URLs
    status      TEXT        NOT NULL DEFAULT 'ativo'
                CHECK (status IN ('ativo', 'vendido', 'pausado')),
    lat         NUMERIC(10, 8),
    lng         NUMERIC(11, 8),

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Não permite cadastrar o mesmo endereço duas vezes (tratando complemento NULL ou vazio de forma igual)
CREATE UNIQUE INDEX IF NOT EXISTS idx_imoveis_endereco_unique 
ON moravo.imoveis (uf, cep, rua, numero, COALESCE(complemento, ''));

CREATE INDEX IF NOT EXISTS idx_imoveis_dono_id    ON moravo.imoveis (dono_id);
CREATE INDEX IF NOT EXISTS idx_imoveis_tipo       ON moravo.imoveis (tipo);
CREATE INDEX IF NOT EXISTS idx_imoveis_cidade     ON moravo.imoveis (cidade);
CREATE INDEX IF NOT EXISTS idx_imoveis_uf         ON moravo.imoveis (uf);
CREATE INDEX IF NOT EXISTS idx_imoveis_status     ON moravo.imoveis (status);
CREATE INDEX IF NOT EXISTS idx_imoveis_created_at ON moravo.imoveis (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_imoveis_preco      ON moravo.imoveis (preco);

DROP TRIGGER IF EXISTS trg_imoveis_touch_updated_at ON moravo.imoveis;
CREATE TRIGGER trg_imoveis_touch_updated_at
    BEFORE UPDATE ON moravo.imoveis
    FOR EACH ROW
    EXECUTE FUNCTION moravo.touch_updated_at();


-- ----------------------------------------------------------------------------
-- Tabela: interesses (corretor demonstra interesse em imóvel)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS moravo.interesses (
    id           BIGSERIAL PRIMARY KEY,
    imovel_id    BIGINT      NOT NULL REFERENCES moravo.imoveis(id) ON DELETE CASCADE,
    corretor_id  BIGINT      NOT NULL REFERENCES moravo.usuarios(id) ON DELETE CASCADE,

    mensagem     TEXT,
    status       TEXT        NOT NULL DEFAULT 'pendente'
                 CHECK (status IN ('pendente', 'aceito', 'recusado')),

    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Um corretor não pode demonstrar interesse 2x no mesmo imóvel
    CONSTRAINT uk_interesse_unico UNIQUE (imovel_id, corretor_id)
);

CREATE INDEX IF NOT EXISTS idx_interesses_imovel_id   ON moravo.interesses (imovel_id);
CREATE INDEX IF NOT EXISTS idx_interesses_corretor_id ON moravo.interesses (corretor_id);
CREATE INDEX IF NOT EXISTS idx_interesses_status      ON moravo.interesses (status);

DROP TRIGGER IF EXISTS trg_interesses_touch_updated_at ON moravo.interesses;
CREATE TRIGGER trg_interesses_touch_updated_at
    BEFORE UPDATE ON moravo.interesses
    FOR EACH ROW
    EXECUTE FUNCTION moravo.touch_updated_at();


-- ----------------------------------------------------------------------------
-- Tabela: interesses_compradores (comprador demonstra interesse em imóvel)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS moravo.interesses_compradores (
    id           BIGSERIAL PRIMARY KEY,
    imovel_id    BIGINT      NOT NULL REFERENCES moravo.imoveis(id) ON DELETE CASCADE,
    comprador_id BIGINT      NOT NULL REFERENCES moravo.usuarios(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Um comprador não pode demonstrar interesse 2x no mesmo imóvel
    CONSTRAINT uk_interesse_comprador_unico UNIQUE (imovel_id, comprador_id)
);

CREATE INDEX IF NOT EXISTS idx_interesses_compradores_imovel_id    ON moravo.interesses_compradores (imovel_id);
CREATE INDEX IF NOT EXISTS idx_interesses_compradores_comprador_id ON moravo.interesses_compradores (comprador_id);
CREATE INDEX IF NOT EXISTS idx_interesses_compradores_created_at   ON moravo.interesses_compradores (created_at DESC);


-- ----------------------------------------------------------------------------
-- Tabela: favoritos (usuário marca imóvel como favorito)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS moravo.favoritos (
    id          BIGSERIAL PRIMARY KEY,
    usuario_id  BIGINT      NOT NULL REFERENCES moravo.usuarios(id) ON DELETE CASCADE,
    imovel_id   BIGINT      NOT NULL REFERENCES moravo.imoveis(id)  ON DELETE CASCADE,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Um usuário não pode favoritar o mesmo imóvel duas vezes
    CONSTRAINT uk_favorito_unico UNIQUE (usuario_id, imovel_id)
);

CREATE INDEX IF NOT EXISTS idx_favoritos_usuario_id ON moravo.favoritos (usuario_id);
CREATE INDEX IF NOT EXISTS idx_favoritos_imovel_id  ON moravo.favoritos (imovel_id);


-- ----------------------------------------------------------------------------
-- Dados de exemplo pra testar
-- ----------------------------------------------------------------------------
INSERT INTO moravo.usuarios
    (nome, email, whatsapp, cidade, perfil, tipo_imovel, preco_estimado, creci, regiao_atuacao)
VALUES
    ('Marina Couto',   'marina.couto@exemplo.com',   '47999990001', 'Balneário Camboriú', 'corretor',     NULL, NULL,        '12345-F', 'Litoral Norte SC'),
    ('Rafael Praça',   'rafael.praca@exemplo.com',   '47999990002', 'Joinville',          'corretor',     NULL, NULL,        '22345-F', 'Norte de SC'),
    ('Letícia Forte',  'leticia.forte@exemplo.com',  '41999990003', 'Curitiba',           'corretor',     NULL, NULL,        '32345-F', 'Curitiba e região'),
    ('Diego Alves',    'diego.alves@exemplo.com',    '47999990006', 'Itajaí',             'proprietario', 'casa',        1950000.00, NULL, NULL),
    ('Carla Nunes',    'carla.nunes@exemplo.com',    '11999990005', 'São Paulo',          'proprietario', 'apartamento', 1480000.00, NULL, NULL)
ON CONFLICT (email) DO NOTHING;

-- Migração: usuários antigos com perfil 'comprador' passam a ser 'proprietario'
UPDATE moravo.usuarios SET perfil = 'proprietario' WHERE perfil = 'comprador';


-- ----------------------------------------------------------------------------
-- Views úteis
-- ----------------------------------------------------------------------------

-- Resumo por perfil
CREATE OR REPLACE VIEW moravo.v_usuarios_por_perfil AS
SELECT perfil, COUNT(*) AS total
FROM moravo.usuarios
GROUP BY perfil
ORDER BY perfil;

-- Imóveis anunciados com nome do dono (placeholder)
CREATE OR REPLACE VIEW moravo.v_imoveis_anunciados AS
SELECT  u.id,
        u.nome      AS proprietario,
        u.whatsapp,
        u.cidade,
        u.tipo_imovel,
        u.preco_estimado,
        u.created_at AS anuncio_em
FROM    moravo.usuarios u
WHERE   u.perfil = 'proprietario';

-- Imóveis cadastrados (visão completa com dono)
CREATE OR REPLACE VIEW moravo.v_imoveis_com_dono AS
SELECT  im.*,
        u.nome        AS dono_nome,
        u.whatsapp    AS dono_whatsapp,
        u.email       AS dono_email
FROM    moravo.imoveis im
JOIN    moravo.usuarios u ON u.id = im.dono_id;

-- Interesses com dados do corretor e do imóvel (pra dashboard do dono)
CREATE OR REPLACE VIEW moravo.v_interesses_completo AS
SELECT  i.*,
        im.titulo  AS imovel_titulo,
        im.cidade  AS imovel_cidade,
        im.tipo    AS imovel_tipo,
        im.dono_id AS imovel_dono_id,
        c.nome     AS corretor_nome,
        c.whatsapp AS corretor_whatsapp,
        c.email    AS corretor_email,
        c.creci    AS corretor_creci
FROM    moravo.interesses i
JOIN    moravo.imoveis   im ON im.id = i.imovel_id
JOIN    moravo.usuarios   c ON c.id = i.corretor_id;


-- =========================================================================
-- Como conectar
-- =========================================================================
-- psql "postgresql://postgres:0agHjY031Iq3nFDu@localhost:5432/postgres" -f schema.sql
-- (mapeie a porta 5432 do container 1785a42610ec pra uma porta local antes, ex: -p 5432:5432)
-- =========================================================================
