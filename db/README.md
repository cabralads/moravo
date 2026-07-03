# Moravo — Database Setup (VPS)

Este guia sobe **apenas o banco de dados** na VPS `manager1` (144.126.215.243).
O site (`index.html`, `busca.html`) continua rodando local na sua máquina por enquanto.

---

## Visão geral

```
┌─────────────────────┐         ┌──────────────────────────┐
│ SUA MÁQUINA (Win)   │         │  VPS manager1            │
│                     │         │                          │
│  index.html         │   ???   │  Postgres 14 (Docker)    │
│  busca.html         │ ──────► │  container 1785a42610ec  │
│  (local, sem back)  │   TBD   │  IP interno: 10.0.1.6   │
└─────────────────────┘         └──────────────────────────┘
```

**O `index.html` local NÃO vai falar com o banco hoje** (sem backend, sem porta exposta).
A conexão entre front e banco fica pra quando você decidir:

- Subir um backend Node (que já tá pronto em `backend/`) na VPS, OU
- Expor a porta 5432 do Postgres via `socat` e usar algum proxy no front

Por enquanto, o objetivo é só: **schema criado + dados de exemplo inseridos**.

---

## Passo 1 — Copie o `db/schema.sql` pro manager1

Da sua máquina Windows (PowerShell ou Git Bash):

```bash
# Se tiver SSH configurado (mais comum)
scp db/schema.sql seu-usuario@144.126.215.243:~/schema.sql
```

**Alternativa sem scp** — copia o conteúdo:

```bash
# Windows PowerShell — lê o arquivo
Get-Content db/schema.sql
```

Copie o conteúdo, conecte no manager1 (`ssh seu-usuario@144.126.215.243`) e cole:

```bash
cat > /tmp/schema.sql << 'FIM_DO_ARQUIVO'
[cole aqui com Ctrl+Shift+V]
FIM_DO_ARQUIVO
```

---

## Passo 2 — Aplique o schema (no manager1)

Como o container Postgres **não tem porta exposta** (`HostConfig.PortBindings: {}`),
a forma mais simples é rodar o `psql` **de dentro do próprio container** via `docker exec`:

```bash
# 1. Copia o schema de ~/schema.sql pra dentro do container
docker cp /tmp/schema.sql 1785a42610ec:/tmp/schema.sql

# 2. Roda o psql de dentro do container (sem expor porta nenhuma!)
docker exec 1785a42610ec psql -U postgres -v ON_ERROR_STOP=1 -f /tmp/schema.sql

# 3. Confere que deu certo
docker exec 1785a42610ec psql -U postgres -c "
  SELECT perfil, COUNT(*) AS total
  FROM moravo.usuarios
  GROUP BY perfil
  ORDER BY perfil;
"
```

**Saída esperada:**

```
    perfil     | total
---------------+-------
 comprador     |     1
 corretor      |     3
 proprietario  |     2
(3 rows)
```

Se aparecer isso, **banco pronto** ✅

---

## Passo 3 — (Opcional) Habilite a extensão `citext`

O schema usa `CITEXT` (case-insensitive text) pro e-mail. A primeira linha do
`schema.sql` já tenta criar a extensão:

```sql
CREATE EXTENSION IF NOT EXISTS citext;
```

Se der erro de permissão, rode manualmente como superuser:

```bash
docker exec -u postgres 1785a42610ec psql -U postgres -c "CREATE EXTENSION IF NOT EXISTS citext;"
```

---

## Verificação — queries úteis pra rodar no banco

```bash
# Total de cadastros
docker exec 1785a42610ec psql -U postgres -c "SELECT COUNT(*) FROM moravo.usuarios;"

# Últimos 5 cadastrados
docker exec 1785a42610ec psql -U postgres -c "
  SELECT id, nome, perfil, cidade, created_at
  FROM moravo.usuarios
  ORDER BY created_at DESC
  LIMIT 5;
"

# Corretores com CRECI cadastrado
docker exec 1785a42610ec psql -U postgres -c "
  SELECT nome, creci, regiao_atuacao
  FROM moravo.usuarios
  WHERE perfil = 'corretor'
  ORDER BY nome;
"
```

---

## Próximos passos (quando quiser conectar o front)

### Opção A — Subir o backend Node (recomendado)

O backend já tá pronto em `backend/`. Pra subir:

```bash
# No manager1, em /opt/moravo-backend
cd /opt/moravo-backend
npm install
cp .env.example .env
# editar .env se precisar (a senha 0agHjY031Iq3nFDu já tá nele)
node server.js
```

Depois edita o `index.html` local pra apontar pro IP da VPS:

```js
fetch('http://144.126.215.243:3000/api/cadastro', { ... })
```

### Opção B — Expor a porta 5432 com `socat` (sem backend)

Rápido mas menos seguro:

```bash
CONTAINER_IP=$(docker inspect 1785a42610ec --format '{{.NetworkSettings.IPAddress}}')
nohup socat TCP-LISTEN:5432,fork,reuseaddr TCP:$CONTAINER_IP:5432 > /var/log/socat.log 2>&1 &
```

Aí conecta do `index.html` via algum proxy no navegador (não dá pra conectar
direto do navegador no Postgres por CORS — só com backend no meio).

---

## Estrutura criada

```
moravo-site/
├── index.html              ← site (roda local)
├── busca.html              ← site (roda local)
├── backend/                ← API Node (pronta pra subir, opcional)
│   ├── server.js
│   ├── db.js
│   ├── routes/
│   │   ├── cadastro.js     POST /api/cadastro
│   │   └── usuarios.js     GET  /api/usuarios, /api/usuarios/stats
│   ├── package.json
│   ├── .env.example
│   └── .gitignore
└── db/
    ├── schema.sql          ← já tá na VPS (via scp)
    └── apply.sh            ← script de conveniência (caso a porta 5432 seja exposta no futuro)
```

---

## Troubleshooting

### "Permission denied" no `CREATE EXTENSION citext`

```bash
docker exec -u postgres 1785a42610ec psql -U postgres -c "CREATE EXTENSION citext;"
```

### "psql: command not found" dentro do container

A imagem `postgres:14` vem com `psql` no PATH. Se faltar:

```bash
docker exec 1785a42610ec which psql
docker exec 1785a42610ec ls /usr/lib/postgresql/14/bin/
```

### E-mail duplicado retorna erro?

Constraint `UNIQUE` em `email`. Tudo certo — é pra rejeitar mesmo.

### Quero apagar tudo e recomeçar

```bash
docker exec -u postgres 1785a42610ec psql -U postgres -c "
  DROP SCHEMA IF EXISTS moravo CASCADE;
"
# depois roda o schema.sql de novo
```
