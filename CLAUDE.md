# Moravo — Guia do Projeto

> **Este arquivo é a fonte de verdade do projeto.**
> Toda alteração de comportamento (nova regra, novo perfil, nova rota, mudança de fluxo)
> deve ser refletida aqui **no mesmo commit** da mudança. Ver "Manutenção deste arquivo" no final.

---

## O que é

Plataforma de anúncio e intermediação de imóveis. O proprietário anuncia, corretores se
candidatam a intermediar, o proprietário escolhe um, e a negociação segue num grupo de
WhatsApp criado automaticamente com um atendente da Moravo dentro.

Produção: **moravo.com.br**

---

## Stack e como rodar

- Node 18+ / Express 4 (API + serve o front estático)
- Postgres (schema `moravo`) — hoje apontando para Supabase
- Front: HTML/CSS/JS puro, sem build step, sem framework
- Auth: JWT (`Bearer`), senha com bcrypt

```bash
npm install
cp .env.example .env    # preencher DATABASE_URL e JWT_SECRET
npm run dev             # node --watch server.js
```

As migrações rodam sozinhas no boot, dentro do `app.listen` do `server.js` (idempotentes,
`ADD COLUMN IF NOT EXISTS`). **Não existe ferramenta de migração** — mudança de schema é
adicionar um bloco ali.

---

## Deploy

**`git push` na branch `main` publica direto em produção.** A Hostoo tem integração Git
apontando `main` → `/public_html/moravo`. Não há staging entre o commit e o ar.

→ Testar local antes. Em mudança arriscada, usar branch separada e só mergear depois de revisar.

---

## Mapa de arquivos

```
server.js              entry point, CORS, migrações no boot, seed do admin
db.js                  pool do Postgres (tem fallback json-stub p/ dev sem banco)
db/schema.sql          schema base (as migrações novas vivem no server.js)
middleware/auth.js     requireAuth (valida JWT) + requireRole(...perfis)
lib/jwt.js             sign/verify, fail-fast se faltar JWT_SECRET em produção
lib/notifications.js   criarNotificacao()
lib/waha.js            integração WhatsApp (criar grupo, enviar msg, gerar convite)

routes/
  auth.js          register, login, me
  admin.js         login auditado + fila de aprovação + logs
  imoveis.js       CRUD, feed, status, clique-interesse do comprador
  interesses.js    candidatura do corretor, aceite/recusa, grupo de WhatsApp
  favoritos.js     favoritar/desfavoritar
  notificacoes.js  listar, contar não lidas, marcar lidas, apagar
  usuarios.js      listagem pública, editar perfil, foto de perfil
  documentos.js    upload/remoção da escritura (PDF/imagem, 5MB)
  fotos.js         upload/remoção de fotos do imóvel
  cadastro.js      cadastro legado (sem senha)
  cidades.js       estados / cidades / bairros

public/
  index.html       landing
  cadastro.html    criar conta (escolhe proprietario ou corretor)
  login.html       login normal
  busca.html       busca e filtros
  detalhes.html    página do imóvel + CTA que muda conforme o perfil
  dashboard.html   painel do usuário logado (proprietario e corretor)
  admin.html       painel do admin (login próprio)
  config.js        define window.MORAVO_API
```

---

## Perfis

São **3 valores** no banco: `proprietario`, `corretor`, `admin`.

⚠️ **"Vendedor" = `proprietario`.** Esse mesmo perfil também é o comprador — não existe
perfil `comprador` separado (foi migrado para `proprietario`). No cadastro ele aparece
rotulado como "Usuário".

### ADMIN

Login separado em `/admin.html` → `POST /api/admin/login`, que só aceita `perfil='admin'`
e grava auditoria de toda tentativa (IP + user-agent) em `admin_login_logs`.
Token guardado em `moravo_admin_token`, independente do token normal.

Faz:
- Lista imóveis por `status_aprovacao` (pendente / aprovado / reprovado)
- **Aprova** imóvel (registra quem e quando)
- **Reprova** com motivo obrigatório (mín. 10 caracteres) → notifica o dono (`documento_reprovado`)
- Vê os últimos 100 logins do painel

Não faz (hoje): gerenciar usuários, editar/excluir imóveis, ver negociações, métricas.

Só existe o admin do seed (`admin@moravo.local` / `admin1234`, criado no boot).
Para criar outro, é `UPDATE` no banco na mão.

### VENDEDOR (`proprietario`)

Acumula três papéis:

**Anunciante**
- Cadastra imóvel em 2 passos: dados + endereço, depois matrícula (obrigatória),
  escritura (texto ou arquivo), condomínio e valor
- Sobe fotos, edita e exclui **só os próprios** imóveis
- Alterna status: `ativo` / `pausado` / `vendido`
- Endereço é único (UF+CEP+rua+número+complemento) — não dá pra duplicar

**Quem escolhe o corretor** (o núcleo do negócio)
- Vê os corretores candidatos a cada imóvel
- Aceita ou recusa cada um, ou aceita todos (`POST /api/interesses/aceitar-todos`)
- Ao aceitar → corretor é notificado e libera a criação do grupo de WhatsApp
- Ao marcar como **vendido** → os corretores pendentes são recusados automaticamente e notificados

**Comprador**
- Favorita, busca, e clica em "Falar com um Corretor" → grava em `interesses_compradores`
  e incrementa o contador do imóvel

### CORRETOR

Cadastro exige **CRECI** (formato `12345-F`) e **região de atuação** — validado por
constraint no banco.

- Vê o feed de disponíveis (some o que é dele e o que já se candidatou)
- **"Intermediar este imóvel"** → cria candidatura `pendente` com mensagem opcional.
  Uma por imóvel; não pode ser o dono
- Quando aceito: representa o imóvel, cria o grupo de WhatsApp, vê os compradores
  interessados e **pode marcar como vendido** (mesma permissão do dono)
- Pode renunciar à representação (notifica o dono)
- Caixa de mensagens com abas exclusivas: Todas / Com Vendedor / Com Comprador
- Também pode anunciar imóveis próprios e favoritar

---

## Fluxo principal

```
Vendedor cadastra imóvel (+ matrícula / escritura)
  → Admin aprova ou reprova com motivo
  → Corretores se candidatam a intermediar
  → Vendedor escolhe o corretor
  → Grupo de WhatsApp criado (vendedor + corretor + atendente Moravo)
  → Compradores clicam "Falar com um Corretor"
  → Marcado como vendido → demais corretores recusados automaticamente
```

---

## Modelo de dados (schema `moravo`)

| Tabela | O que guarda |
|---|---|
| `usuarios` | perfil, credenciais, CRECI/região (corretor), tipo_imovel/preço (proprietário) |
| `imoveis` | anúncio + endereço + `status` (ativo/vendido/pausado) + `status_aprovacao` (pendente/aprovado/reprovado) + matrícula/escritura/condomínio |
| `interesses` | candidatura do **corretor** ao imóvel: pendente/aceito/recusado + dados do grupo de WhatsApp |
| `interesses_compradores` | clique de "Falar com um Corretor" do **comprador** |
| `favoritos` | usuário ↔ imóvel |
| `notificacoes` | destinatário, tipo, payload JSONB, lida |
| `admin_login_logs` | auditoria de acesso ao painel admin |

**Tipos de notificação:** `corretor_interessado`, `corretor_escolhido`, `corretor_recusado`,
`corretor_recusado_auto`, `corretor_renunciou`, `imovel_vendido`, `documento_reprovado`.

---

## Integrações

**Waha (WhatsApp)** — `lib/waha.js`. Cria o grupo com proprietário + corretor + atendente
principal (`WAHA_ATENDENTE_PRINCIPAL`). Só funciona com o interesse em `aceito`. É
idempotente: se o grupo já existe, devolve o link.

**Geocoding** — `GET /api/geocode` tenta ArcGIS e cai pra Nominatim.

---

## Pontos de atenção / dívida conhecida

- **A aprovação não é um portão.** O filtro que escondia imóveis não aprovados do feed foi
  removido de propósito (`routes/imoveis.js`, no GET `/`): imóvel pendente ou reprovado
  continua aparecendo na busca, só com badge diferente. Se a intenção for bloquear, precisa
  voltar o filtro.
- **Credenciais no repositório**: senha do Postgres num comentário do `db/schema.sql`,
  `WAHA_API_KEY` preenchida no `.env.example`, e senha do admin fixa no `server.js`.
  Deveriam sair para variáveis de ambiente e ser rotacionadas.
- **Sem testes automatizados.** Só o `test-badge-f5.js` avulso.
- **`dashboard.html` tem ~6.900 linhas** com HTML, CSS e JS juntos. Mexer nele exige cuidado.
- Perfil `comprador` legado ainda aparece em condicionais soltas no código.

---

## Manutenção deste arquivo

Atualizar **no mesmo commit** da mudança sempre que mexer em:

- o que um perfil pode ou não pode fazer
- rotas da API (nova, removida, mudança de permissão)
- schema do banco
- fluxo de negócio (aprovação, candidatura, grupo de WhatsApp)
- deploy, variáveis de ambiente, integrações

Registrar a mudança no histórico abaixo, uma linha por alteração relevante.

### Histórico

- **2026-08-17** — Documento criado: mapeamento dos 3 perfis (admin / vendedor-proprietário /
  corretor), fluxo de intermediação, modelo de dados e dívidas conhecidas.
