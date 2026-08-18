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

## Infraestrutura

| Camada | Onde fica |
|---|---|
| **Aplicação** | VPS **Hostinger** — `srv848979.hstgr.cloud` (103.199.184.81), numa **stack Docker chamada `moravo`** |
| **Banco** | **Supabase**, projeto `slebpxrifihecanljzak` (nome: `relatorios_ads_wpp`), região `sa-east-1`, Postgres 15, via pooler na porta `6543` |
| **Imagem** | GitHub Actions builda e publica no `ghcr.io` a cada push na `main` |
| **Hostoo** | Hospeda **outros domínios** da conta. Tem uma integração Git que aponta para o repo, mas **não serve o moravo.com.br** |

O schema fica em `moravo` (não em `public`).

---

## Deploy

⚠️ **`git push` sozinho NÃO publica nada.** Descoberto em 17/08/2026, depois de quase um mês
com o commit `6c99c20` (21/07) no ar sem ninguém perceber.

O push builda a imagem no ghcr.io, mas quem atende o domínio é a **stack `moravo` na VPS
Hostinger**. Enquanto ela não for atualizada, o site não muda.

**Para publicar:** atualizar a stack `moravo` na VPS Hostinger (painel da Hostinger →
Docker/stack, ou por SSH com `docker compose pull && docker compose up -d` no diretório da
stack). Só depois disso o que está na `main` chega ao ar.

**Pegadinhas conhecidas:**
- O histórico de deploys da Hostoo mostra **sucesso** mesmo sem efeito nenhum. Não use como
  confirmação — confira o site.
- Mudança em `public/` só aparece depois que o container é recriado.
- Mudança em `server.js`, `routes/` ou `lib/` exige recriar o container **e** reiniciar o
  processo Node, porque o código só é lido na inicialização.
- Para conferir se subiu, compare o tamanho do arquivo servido com o do repo:
  `curl -s https://moravo.com.br/dashboard.html | wc -c`

→ Testar local antes. Em mudança arriscada, usar branch separada e só mergear depois de revisar.

---

## Divergência entre o banco e o repositório

O banco de produção tem objetos que **não existem no repo** — foram criados direto no Supabase.
Um banco novo montado a partir do `db/schema.sql` não fica igual à produção.

Conhecidos até agora:

- `imoveis_matricula_chk`: `CHECK (matricula IS NULL OR char_length(matricula) BETWEEN 1 AND 100)`.
  Ou seja, **string vazia é proibida** e "sem matrícula" se representa com `NULL`.
  A coluna é `nullable` em produção, embora o `server.js` antigo a declarasse `NOT NULL DEFAULT ''`.
  Isso derrubava as migrações de boot a cada inicialização (corrigido em 17/08/2026).
- `imoveis_valor_condominio_chk`.

Antes de escrever qualquer migração que mexa em `imoveis`, confira as constraints reais:

```sql
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid = 'moravo.imoveis'::regclass;
```

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
lib/whatsapp.js        WhatsApp Cloud API oficial (envio do convite, config cifrada)
lib/grupo.js           cria/reaproveita o grupo da negociação e dispara os convites

routes/
  auth.js          register, login, me
  admin.js         login auditado + fila de aprovação + logs
  imoveis.js       CRUD, feed, status, clique-interesse do comprador
interesses.js    carteira do corretor (imóveis que ele escolheu trabalhar)
propostas.js     proposta de compra: cria o grupo e aciona o proprietário
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
anuncie.html     landing de conversão do proprietário (URL limpa /anuncie)
anuncie-2.html   variante da landing para teste A/B (URL limpa /anuncie-2)
anuncie-3.html   terceira variante, com calculadora do custo de esperar (/anuncie-3)
  login.html       login normal
  busca.html       busca e filtros
  detalhes.html    página do imóvel + CTA que muda conforme o perfil
  dashboard.html   painel do usuário logado (proprietario e corretor)
  admin.html       painel do admin (login próprio)
  politica-de-privacidade.html   página legal (URL limpa /politica-de-privacidade)
  termos-de-uso.html             página legal (URL limpa /termos-de-uso)
  _legal-shell.css               estilo compartilhado das duas páginas legais
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
Proprietário cadastra imóvel (+ matrícula / escritura)
  → Admin aprova ou reprova com motivo
  → Corretor clica em "Trabalhar este imóvel" e ele entra na CARTEIRA dele, na hora
  → Corretor trabalha o imóvel (sem acionar o proprietário)
  → Corretor envia PROPOSTA (valor, forma de pagamento, condições)
     → grupo de WhatsApp é criado e as duas partes recebem o convite
     → proprietário é notificado
  → Proprietário aceita ou recusa a PROPOSTA
  → Marcado como vendido
```

### Não existe mais aceite de corretor (mudado em 2026-08-18)

Antes, o corretor se candidatava e ficava **travado** até o proprietário aprovar. Como o
proprietário só era avisado dentro do site, candidatura ficava parada por semanas e o imóvel
não andava.

Agora o corretor entra na carteira **imediatamente**, e o proprietário só é acionado quando
existe **proposta de verdade** na mesa. A decisão dele mudou de objeto: era sobre *pessoas*,
passou a ser sobre *propostas*.

Consequências no código:

- `POST /api/interesses/imovel/:id` grava direto com `status = 'aceito'`, que agora significa
  **"está na carteira"**, não "o dono aprovou". Os valores `pendente` e `recusado` continuam
  no CHECK por compatibilidade.
- O grupo de WhatsApp **não nasce mais do aceite**. Nasce em `POST /api/propostas`
  (`lib/grupo.js`, `garantirGrupo`), e é idempotente.
- Notificação `corretor_trabalhando` avisa o dono que alguém entrou no imóvel.
  `proposta_recebida` é a que realmente pede ação dele.

**Ainda não feito, de propósito** (decidido em 2026-08-18: primeiro o básico funcionando):

- **Verificação de CRECI.** Hoje só o formato é validado (`routes/auth.js`), então qualquer
  cadastro vira corretor com acesso a contato de proprietário. Com o portão aberto, isso
  deixou de ser desejável e virou necessário.
- **Bloqueio de corretor pelo proprietário.**
- O `GET /api/imoveis/:id` devolve `dono_whatsapp` e `dono_email` para qualquer usuário
  logado, sem checar carteira.

---

## Modelo de dados (schema `moravo`)

| Tabela | O que guarda |
|---|---|
| `usuarios` | perfil, credenciais, CRECI/região (corretor), tipo_imovel/preço (proprietário) |
| `imoveis` | anúncio + endereço + `status` (ativo/vendido/pausado) + `status_aprovacao` (pendente/aprovado/reprovado) + matrícula/escritura/condomínio |
| `interesses` | **carteira**: imóveis que o corretor escolheu trabalhar + dados do grupo de WhatsApp |
| `propostas` | proposta de compra do corretor: valor, forma de pagamento, entrada, validade, status |
| `interesses_compradores` | clique de "Falar com um Corretor" do **comprador** |
| `favoritos` | usuário ↔ imóvel |
| `notificacoes` | destinatário, tipo, payload JSONB, lida |
| `admin_login_logs` | auditoria de acesso ao painel admin |

**Tipos de notificação:** `corretor_trabalhando`, `proposta_recebida`, `proposta_aceita`,
`proposta_recusada`, `envio_whatsapp_falhou`, `corretor_escolhido`, `corretor_recusado`,
`corretor_recusado_auto`, `corretor_renunciou`, `imovel_vendido`, `documento_reprovado`.

---

## Integrações

**WhatsApp — dois serviços, dois papéis:**

| Etapa | Quem faz | Observação |
|---|---|---|
| Criar o grupo | **Waha** (sessão `moravo_portal`, em `wpp.atendentex.com.br`) | Número não oficial controlado por API |
| Enviar o convite | **WhatsApp Cloud API** (oficial, Meta) | Template `link_grupo_convite`, idioma `pt_BR` |

**O grupo nasce só com os números da Moravo.** Proprietário e corretor **não são mais
adicionados à força** — recebem o link e entram por vontade própria. Foi essa mudança que
tirou o risco de banimento do número da sessão. Se o Waha exigir mais de um participante
para criar o grupo, informe um segundo número interno em `WAHA_PARTICIPANTES_EXTRA`.

**O template usa botão de URL dinâmica.** Na Meta, esse botão tem base fixa e só o sufixo
varia: o template fica cadastrado como `https://chat.whatsapp.com/{{1}}` e o sistema envia
**apenas o código** do convite, nunca a URL inteira (`lib/whatsapp.js`, `extrairCodigoConvite`).

**A configuração fica no painel do admin** (`/admin` → Config. WhatsApp), gravada em
`moravo.config_whatsapp` (linha única). O **token é cifrado com AES-256-GCM** usando
`CONFIG_SECRET` (ou `JWT_SECRET` como reserva) e **nunca volta para o front-end** — a tela
mostra só os 4 últimos caracteres. Com `ativo` desligado, o grupo é criado e o link aparece,
mas nenhuma mensagem é disparada.

**Toda tentativa de envio vira uma linha em `moravo.whatsapp_envios`.** Falha gera notificação
para todos os admins (`tipo = 'envio_whatsapp_falhou'`) e aparece em `/admin` → Envios
WhatsApp, com botão de reenviar. Envio por SMS como alternativa fica para um segundo momento.

**Telefones**: no banco há números com e sem o DDI 55. A normalização acontece no envio
(`lib/whatsapp.js`, `normalizarTelefone`). É a causa clássica de mensagem que não chega.

Criar o grupo só é permitido com o interesse em `aceito`, e é idempotente: se o grupo já
existe, o link é devolvido e o convite reenviado.

**Geocoding** — `GET /api/geocode` tenta ArcGIS e cai pra Nominatim.

---

## Posicionamento e modelo de receita

**Nome da marca: Moravo.** Os nomes alternativos estudados (BrokerOS, Broker Cloud, ABAS,
REaaS Brasil, AgentOS, Cloud Realty, RealtyOS) ficaram de fora por ora.

**Não usar a sigla "REaaS" em nada voltado ao cliente.** No Brasil ela já significa outra
coisa (moradia por assinatura, tipo Housi) e criaria confusão. O conceito pode ser explicado
em texto corrido, sem o rótulo.

### O corretor fica com 77% (decidido em 2026-08-05, Marcos e Amandus)

A imobiliária deixa de ser a "chefe" e vira **infraestrutura contratada**. O corretor usa a
plataforma e paga **23%** da comissão pelo uso — contra os **50%** da imobiliária tradicional.

Assinatura comercial: **50/50 × 77/23**.

Isso substitui o posicionamento anterior ("Modelo Fora Imobiliária" / "100% da comissão"),
que foi removido da copy em 2026-08-17.

**Buraco conhecido:** o produto **não tem gancho nenhum para cobrar os 23%**. Marcar um imóvel
como "vendido" é só um flip de status que o dono ou o corretor aceito fazem com um clique
(`PATCH /api/imoveis/:id/status`) — sem valor da venda, sem contrato, sem comprovação, sem
cobrança. A receita da empresa não existe no código. Isso precisa ser desenhado.

Material de referência da reunião: `arquivos-alinhamento/`.

---

## Decisões de produto

Escolhas deliberadas que podem parecer bug para quem lê o código sem contexto.

### A aprovação não bloqueia o imóvel no feed (decidido em 2026-08-17)

O `status_aprovacao` **não filtra a listagem**. Imóvel pendente ou reprovado continua
aparecendo na busca pública e nas telas internas — a única diferença é o selo
**"Verificado"**, que só o aprovado exibe (`index.html`, `busca.html`, `detalhes.html`,
`dashboard.html`).

O filtro existia no `GET /api/imoveis` e foi removido de propósito; o comentário no lugar
dele (`routes/imoveis.js`, no GET `/`) marca onde ficava.

**Motivo:** o catálogo ainda tem poucos imóveis e só existe um login de admin. Esconder o
que não foi moderado criaria fila e travaria o crescimento do catálogo sem ganho real nessa
escala. A moderação funciona como **selo de confiança**, não como portão.

**Reavaliar quando:** o volume de imóveis crescer, ou passar a existir mais de um moderador.
Aí decidir se some só o reprovado ou se nada aparece antes de aprovado.

---

## Pontos de atenção / dívida conhecida

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
- **2026-08-17** — Registrado que a aprovação não bloquear o imóvel no feed é decisão de
  produto (poucos imóveis, um só admin), e não dívida. Movido para "Decisões de produto".
- **2026-08-17** — Modelo do corretor mudou de "100% da comissão" para **77/23**. Copy do site
  atualizada em 6 pontos (`public/index.html`, `public/cadastro.html`). Marca segue Moravo e a
  sigla "REaaS" não é usada na comunicação.
- **2026-08-17** — Removidos todos os travessões do site (70 ocorrências em 7 páginas).
- **2026-08-17** — Criadas as páginas legais `/politica-de-privacidade` e `/termos-de-uso`
  (exigidas pelo app do Meta para a WhatsApp API), ligadas no rodapé e no cadastro. Faltam
  preencher razão social, CNPJ, endereço e comarca, e passar por revisão jurídica.
- **2026-08-17** — Páginas legais: responsável definido como "Moravo Portal" e foro de
  Joinville/SC. CNPJ e endereço ficam de fora até a empresa ser constituída.
- **2026-08-17** — **Descoberto que o deploy nunca funcionou.** Produção roda numa VPS
  Hostinger, não na Hostoo. Seção "Deploy" reescrita.
- **2026-08-17** — Documentada a infraestrutura real: stack Docker `moravo` na VPS Hostinger
  + banco Supabase `slebpxrifihecanljzak`.
- **2026-08-18** — Terceira variante da landing em `/anuncie-3`, ângulo de **tempo**. Traz uma
  calculadora que soma o custo mensal informado pelo próprio proprietário pelos meses de
  espera. Nenhum número é inventado: a conta usa só o que a pessoa digita, e a página diz de
  forma explícita que não promete prazo de venda ("o que a gente não vai prometer").
- **2026-08-18** — Criada a variante `/anuncie-2` para teste A/B. Ângulo diferente da
  primeira: `/anuncie` ataca o assédio ("seu telefone vira call center"), `/anuncie-2` ataca a
  exclusividade ("uma imobiliária tem uma equipe, aqui o mercado inteiro trabalha"). Layout
  também é outro: hero escuro, tabela comparativa e trilha vertical, contra o hero claro e os
  cards da primeira. As duas usam os mesmos fatos (R$ 0, 6% do CRECI, sem números inventados).
- **2026-08-18** — Copy do site inteiro alinhada ao fluxo novo: landing `/anuncie` (10
  trechos), home, Termos de Uso, Política de Privacidade, painel e página do imóvel. Saiu
  "você escolhe com quem trabalhar" e entrou "vários corretores trabalham, você decide a
  proposta". Notificações `proposta_recebida`, `proposta_aceita`, `proposta_recusada`,
  `corretor_trabalhando` e `envio_whatsapp_falhou` ganharam texto no painel. Os textos de
  `corretor_escolhido`/`corretor_recusado` e os balões de chat de "aguardando o proprietário"
  ficaram no código para renderizar registros antigos, mas são inalcançáveis para dados novos.
- **2026-08-18** — **Fim do aceite de corretor.** O corretor passa a adicionar o imóvel à
  carteira na hora, e o proprietário só é acionado quando chega uma proposta. Nova tabela
  `propostas`, nova rota `/api/propostas`, `lib/grupo.js` com a criação do grupo (que agora
  dispara na proposta, não no aceite). Front: "Minha carteira" para o corretor com botão de
  proposta, e aba "Propostas recebidas" para o proprietário. Travas de segurança (verificação
  de CRECI, bloqueio de corretor) ficaram para depois, a pedido: primeiro o básico rodando.
- **2026-08-17** — Criada a landing do proprietário em `/anuncie`, focada em conversão de
  cadastro. Sem números de catálogo (a home ainda exibe 2.480 imóveis e 1.100+ corretores,
  contra 7 e 9 reais). Argumentos usados são só os que o produto sustenta: anúncio gratuito,
  endereço único, dono escolhe o corretor, conferência documental e grupo único no WhatsApp.
- **2026-08-17** — WhatsApp migrado para modelo híbrido: Waha cria o grupo (sem adicionar
  ninguém) e a Cloud API oficial envia o convite. Novo `lib/whatsapp.js`, tabelas
  `config_whatsapp` e `whatsapp_envios`, painel do admin com configuração, teste e log de
  erros. Template `link_grupo_convite` ainda em aprovação na Meta — manter `ativo` desligado
  até liberar.
- **2026-08-17** — Corrigidas as migrações de boot do `server.js`: cada uma passa a rodar
  isolada (antes, a primeira falha abortava as sete seguintes em silêncio) e a normalização
  `matricula = ''` foi removida por violar a constraint real do banco. No Supabase, removido
  o default `''` da coluna `matricula`.
