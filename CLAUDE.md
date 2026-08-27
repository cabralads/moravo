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
lib/site-config.js     scripts de terceiros do admin e a injeção deles no HTML
lib/pagina-grupo.js    página de entrada no grupo de WhatsApp (escapa a query string)
lib/codigo-imovel.js   código público do imóvel, slug e URL amigável
lib/foto-grupo.js      imagem dos grupos, guardada no banco (com padrão no repo)
lib/atendimento.js     fila de corretores para o comprador, atribuição e repasse
lib/visitas.js         contagem de acesso por imóvel (visitante por hash)
lib/horario-comercial.js  expediente da Moravo, para o prazo contar só em hora útil

routes/
  auth.js          register, login, me
  admin.js         login auditado + fila de aprovação + logs
  imoveis.js       CRUD, feed, status, clique-interesse do comprador
interesses.js    carteira do corretor (imóveis que ele escolheu trabalhar)
propostas.js     proposta de compra: cria o grupo e aciona o proprietário
  favoritos.js     favoritar/desfavoritar
  notificacoes.js  listar, contar não lidas, marcar lidas, apagar
  webhook-whatsapp.js  status de entrega vindo da Meta (rota pública, assinada)
  avaliacoes.js    nota de 1 a 5 do proprietário para o corretor
  atendimentos.js  compradores que caíram para o corretor, com o prazo
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
anuncie-4.html   quarta variante, ângulo de facilidade de anunciar (/anuncie-4)
anunciar.html    cadastro e edição de imóvel em página própria (/anunciar[?id=])
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

## Scripts de terceiros (Tag Manager, pixels)

O admin cola o código em `/admin` → **Configurações**, em dois campos: um para o `<head>` e
outro para o `<body>`. Fica gravado em `moravo.config_site` (linha única).

**A injeção acontece na entrega da página**, num middleware do `server.js` que roda **antes**
do `express.static`: ele resolve a URL para o arquivo `.html` em `public/`, insere o código e
devolve. Nenhum arquivo do repositório é alterado, e não precisa de deploy para valer.

Detalhes que importam:

- O `head` entra antes de `</head>`; o `body` logo **depois** da tag `<body>`, que é onde o
  Tag Manager pede o `<noscript>`.
- **`/admin` fica de fora de propósito**: uso interno não deve virar métrica.
- O `replace` usa função em vez de string, senão `$&` e `$1` dentro do código colado seriam
  interpretados pelo Node e o script chegaria corrompido.
- Cache de 30s (`lib/site-config.js`). Salvar pelo painel limpa o cache na hora.
- Se a leitura falhar, a página original é servida sem os scripts: medição nunca derruba site.
- A rota recusa `</head>`, `</body>` e `</html>` no conteúdo, para não quebrar o HTML.

⚠️ Quem tem acesso ao painel do admin pode injetar JavaScript em todas as páginas públicas.
É o que torna o campo útil, e também o que exige cuidado com quem recebe perfil `admin`.

---

## Identificação do imóvel

Cada imóvel tem **duas** identificações, e elas servem a coisas diferentes:

| | O que é | Onde aparece |
|---|---|---|
| `id` | serial do banco | chave estrangeira, nada mais |
| `codigo` | 7 caracteres sorteados (`mc7GvdX`) | URL, selo na página, nome do grupo, mensagem do WhatsApp |

O `id` sequencial dizia quantos imóveis existem e permitia varrer o catálogo
contando de 1 até acabar. O código não tem ordem nem vizinho.

O alfabeto (`lib/codigo-imovel.js`) não tem `0/O/o` nem `1/l/I`: são os pares que
a pessoa erra ao ditar o código por telefone.

O código aparece em **toda tela interna**: card do painel, card do admin, cabeçalho da
edição em `/anunciar`, selo na página do imóvel, nome do grupo e mensagens do WhatsApp.

**O campo "ONDE" da busca também aceita o código.** É o que a pessoa tem em mãos quando
chega por uma mensagem do WhatsApp, e tratá-lo como nome de cidade devolvia "nenhum
imóvel encontrado em PifDBgM". O filtro vai junto para a API (`?codigo=`), porque a lista
do front vem limitada e o imóvel procurado pode nem estar na página trazida.

**URL pública:** `/imovel/<tipo>-<preço>-<cidade>/?id=<codigo>`

O slug é enfeite para leitura e para busca; quem identifica é o código na query.
Assim o preço pode mudar, o slug muda junto, e **nenhum link já enviado quebra**.
`/detalhes?id=…` continua funcionando e responde **301** para a URL nova, aceitando
tanto o id antigo quanto o código.

**Nome do grupo no WhatsApp:** `Tipo Codigo`, por exemplo `Casa mc7GvdX`. A foto é
aplicada logo após a criação; se falhar, o grupo nasce sem foto e o resto segue.

A imagem é trocável em `/admin` → Config. WhatsApp → **Foto dos grupos**, e fica
**no banco** (`config_whatsapp.foto_grupo`, base64), não em `uploads/`: o container
é recriado a cada deploy e arquivo em disco vai junto. Sem nada no banco, vale
`public/img/moravo-grupo.jpg`, então nunca falta imagem por falta de configuração.
A rota pública `GET /img/grupo` serve a que estiver valendo.

**SEO:** a página do imóvel é montada no cliente, então o servidor injeta `<title>`,
`description`, `canonical` e Open Graph com os dados reais antes de entregar o HTML
(`servirPaginaImovel`, no `server.js`). Sem isso o buscador indexa a casca vazia.
Existem também `/sitemap.xml` (gerado do banco) e `/robots.txt`, porque os cards do
site abrem por `onclick` e não por `<a href>`: sem sitemap não há por onde chegar
aos imóveis navegando.

## Cadastro: estado e cidade

**Todo perfil informa estado e cidade**, no cadastro **e no perfil**. Antes o proprietário era
gravado com `cidade = 'Não especificada'` e ficava fora de qualquer critério de região;
o corretor tinha só `regiao_atuacao` em texto livre, que não cruza com nada.

A UF de quem já estava cadastrado foi deduzida onde dava para ter certeza: corretor pela
região de atuação (`"Joinville - SC"`), proprietário pelo estado dos imóveis dele. Quem
não se encaixou ficou `NULL` e cai nas faixas seguintes da fila, que é o comportamento
correto para dado que não se sabe.

## Avaliação do corretor

O proprietário dá de **1 a 5 estrelas** ao corretor, no painel, em cada card de corretor
que trabalha um imóvel dele. Uma nota por (corretor, autor, imóvel), reeditável.

Só avalia quem trabalhou com você: a rota confere que **o imóvel é seu** e que **o
corretor tem interesse nele**. Sem isso a nota viraria opinião de quem nunca trocou uma
palavra com o corretor.

O corretor vê a própria média na aba **Compradores**: é o número que decide quem recebe
comprador primeiro, e escondê-lo dele não faria sentido. Sem avaliação nenhuma, a tela
explica em vez de mostrar zero, que pareceria nota ruim.

A média já é lida por `lib/atendimento.js` para ordenar a fila. Quem não tem nota entra
como 3.5, não 0 (ver "Atendimento do comprador").

## Medição de acesso

`imovel_visitas` conta cada abertura da página do imóvel. A contagem acontece **no
servidor**, depois de a página ser entregue: não depende de JavaScript e não atrasa quem
está olhando o imóvel.

O visitante é identificado por um **hash de IP + navegador**, nunca pelo IP em texto.

⚠️ **"Único" é aparelho/rede, não pessoa.** A mesma pessoa em casa e no trabalho conta
duas vezes, e duas pessoas na mesma casa contam duas. É o que dá para medir sem rastrear
ninguém, e a tela do admin diz isso.

Robôs são descartados por user-agent: contá-los faria o número dizer o contrário da
verdade sobre audiência.

A leitura que interessa não é visita, é **visita contra proposta**: 200 acessos sem
proposta é anúncio caro demais; 3 acessos sem proposta é anúncio invisível. As duas
pedem decisões opostas.

## URLs

**Nenhuma página termina em `.html`.** O `express.static` já servia as duas formas, e as
duas devolviam 200: para o buscador isso é conteúdo duplicado, e para a pessoa é uma
extensão de arquivo à mostra. Agora `/busca.html` responde **301** para `/busca`, e
`index.html` responde para a raiz. Os links internos foram reescritos (76 ocorrências).

`/detalhes.html?id=1` encadeia direto para `/imovel/<slug>/?id=<codigo>`.

Exceção: `public/config.js` mantém `.html` quando a página é aberta por `file://`, onde
não existe servidor para resolver a URL limpa.

⚠️ **Todo caminho de arquivo no front começa com barra.** A página do imóvel vive em
`/imovel/<slug>/`, que é um nível a mais: um `src="config.js"` relativo vira
`/imovel/<slug>/config.js` e dá 404. Foi o que quebrou a página inteira quando a URL
amigável entrou no ar — sem o `config.js`, `MORAVO_API` fica indefinida, a busca do
imóvel falha e o `catch` manda o usuário para `/busca`. Vale para `src`, `href`,
`url()` do CSS e para o que o `fotoUrl` devolve.

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
- **Atendimentos**: quem espera corretor, quem está atendendo, prazo restante e quantos
  corretores já foram acionados naquele atendimento
- **Métricas**: acessos e visitantes únicos por imóvel, contra corretores, compradores e
  propostas. Imóvel com 20+ visitantes únicos e **zero** propostas aparece destacado: é
  audiência que não converte, e é onde vale investigar
- **Corretores**: nota, quantas ofertas recebeu, quantas aceitou, quantas deixou vencer e
  em quantos minutos úteis costuma responder. A ordem da lista é a mesma da fila
- **Verificação de CRECI** manual, com registro de quem verificou e quando
- **Cadastros por período**: usuários e corretores por dia, com filtro de data
- Envios de WhatsApp, configuração e scripts do site
- Vê os últimos 100 logins do painel

Não faz (hoje): gerenciar usuários, editar/excluir imóveis.

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

## Atendimento do comprador (em construção)

Um proprietário também compra. Quando ele quer fazer proposta no imóvel de outro,
precisa de um corretor no meio, e nasce um **segundo grupo**.

**Um corretor por grupo, nunca vários.** Corretores são concorrentes entre si; um
vendo a negociação do outro azeda a conversa. E o comprador **não entra** no grupo
que já existe entre dono e corretor: ali ele negociaria direto com o dono, e a
intermediação, que é de onde sai a receita, deixaria de existir.

**A fila** (`lib/atendimento.js`, `filaCorretores`), por faixa:

| Faixa | Critério |
|---|---|
| 0 | já trabalha o imóvel (está na carteira) |
| 1 | mesma cidade **e** mesmo estado |
| 2 | mesmo estado |
| 3 | `regiao_atuacao` cita a cidade ou o estado |
| 4 | qualquer corretor |

Dentro da faixa, ordena por **nota** (`avaliacoes_corretor`) e depois aleatório. Quem ainda não tem nota entra
como **3.5**, não 0: começar do zero congelaria o corretor novo para sempre, porque
ele nunca receberia o lead que lhe daria a primeira nota.

⚠️ A UF é comparada como **palavra inteira**, não como pedaço de texto: `ILIKE '%SC%'`
casa dentro de "Belém do São Fran**cisc**o" e colocava um corretor de PE na faixa de SC.

**O prazo é de 1 hora ÚTIL.** Não entrou no grupo, passa para o próximo, e quem
perdeu a vez não é oferecido de novo naquele atendimento. Expediente
(`lib/horario-comercial.js`, fuso de São Paulo): seg a sex 8h-18h, sábado 8h-16h,
domingo fechado. O relógio **pausa** fora do expediente: um lead que chega sexta
17h50 ainda tem 50 minutos na segunda de manhã. A ronda roda a cada 5 minutos.

**O grupo nasce já com o corretor definido**, e o primeiro nome dele vai no assunto:
`Casa mc7GvdX · Marcelo`. O comprador pode ter mais de uma negociação aberta, e dois
grupos com o mesmo título não dizem qual é qual. No repasse o grupo é **renomeado**,
o convite de quem perdeu a vez é **revogado** e o novo corretor recebe o dele.

**As telas:** o comprador usa "Falar com um Corretor" na página do imóvel, com o mesmo
modal de progresso do corretor (frases próprias, porque o que roda por trás é outro). O
corretor tem a aba **Compradores** no painel, com o prazo em minutos úteis e o botão que
confirma o atendimento.

**Entrar no grupo é o aceite.** Não existe botão de "aceitar": abrir o convite nominal
fecha o prazo (`registrarEntrada`). Quem abre o link depois de perder a vez recebe uma
página explicando que o prazo terminou e que o atendimento já foi repassado, em vez de
um "convite cancelado" que não diz nada.

**O dono do imóvel é avisado** (`comprador_no_seu_imovel`), uma vez por atendimento:
ele não entra neste grupo, mas saber que apareceu comprador no imóvel dele é a
informação mais importante que ele recebe da plataforma. O repasse para outro corretor
não gera aviso novo.

**Acabando os corretores**, o atendimento fica `sem_corretor`, mas o grupo continua
de pé com o atendente da Moravo dentro: quem assume é uma pessoa, não uma fila vazia.

⚠️ `minutosUteisEntre` anda de minuto em minuto e tem **teto de 14 dias**. Sem o teto,
uma data ausente (que em JavaScript vira 1970) fazia o laço rodar 29 milhões de voltas
e **travar o processo inteiro**, servidor incluído. O formatador de fuso é criado uma
vez só, fora da função: criá-lo a cada minuto levava a conta de 58ms para 5,9s.

`ofertas_corretor` grava cada oferta e o desfecho (`entrou`, `expirou`, `recusou`) com
o tempo de resposta em minutos úteis. Não muda nada hoje: existe para o ranking ter
histórico real quando chegar, o que não dá para reconstruir depois.

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
| `imovel_visitas` | um acesso à página do imóvel (visitante por hash) |
| `ofertas_corretor` | cada oferta de atendimento a um corretor e o desfecho |
| `avaliacoes_corretor` | nota de 1 a 5 que o proprietário dá ao corretor |
| `whatsapp_envios` | um envio de convite: status na Meta + status de entrega do webhook |

**Tipos de notificação:** `corretor_trabalhando`, `proposta_recebida`, `proposta_aceita`,
`proposta_recusada`, `envio_whatsapp_falhou`, `corretor_escolhido`, `corretor_recusado`,
`corretor_recusado_auto`, `corretor_renunciou`, `imovel_vendido`, `documento_reprovado`,
`comprador_para_atender` (corretor), `comprador_no_seu_imovel` (dono).

⚠️ Tipo novo sem `case` no `dashboard.html` cai no `default` e aparece **como o próprio
slug** para o usuário. Ao criar um tipo, escrever o texto dele no mesmo commit.

---

## Integrações

**WhatsApp — dois serviços, dois papéis:**

| Etapa | Quem faz | Observação |
|---|---|---|
| Criar o grupo | **Waha** (sessão `moravo_portal`, em `wpp.atendentex.com.br`) | Número não oficial controlado por API |
| Enviar o convite | **WhatsApp Cloud API** (oficial, Meta) | Dois templates, idioma `pt_BR` |

**O grupo nasce só com os números da Moravo.** Proprietário e corretor **não são mais
adicionados à força** — recebem o link e entram por vontade própria. Foi essa mudança que
tirou o risco de banimento do número da sessão. Se o Waha exigir mais de um participante
para criar o grupo, informe um segundo número interno em `WAHA_PARTICIPANTES_EXTRA`.

**São DOIS templates, um por destinatário** (conferidos no painel da Meta em 27/08/2026).
Não existe template único: cada lado recebe um texto diferente, e a **ordem das variáveis
não é a mesma nos dois**. Trocar um pelo outro entrega a frase invertida.

`convite_grupo_proprietario` (campo **Template do proprietário** no painel):

> Olá, *{{1}}*! O corretor *{{2}}* começou a trabalhar o seu imóvel {{3}} na Moravo.

| Variável | O que o sistema envia |
|---|---|
| `{{1}}` | **primeiro nome** do proprietário |
| `{{2}}` | **nome completo** do corretor |
| `{{3}}` | título do imóvel + `(imóvel N)` |

Para o **grupo do comprador** existe um segundo par, `atendimento_comprador` e
`atendimento_corretor`, com a mesma regra: sem template próprio, aquela pessoa não
recebe nada, e a falha fica em `whatsapp_envios`.

`convite_grupo_corretor` (campo **Template do corretor**):

> Olá, {{1}}! O imóvel {{2}} entrou na sua carteira na Moravo.
> Criamos um grupo no WhatsApp com você, o proprietário *{{3}}* e um atendente da Moravo.

| Variável | O que o sistema envia |
|---|---|
| `{{1}}` | **primeiro nome** do corretor |
| `{{2}}` | título do imóvel + `(imóvel N)` |
| `{{3}}` | **nome completo** do proprietário |

Nos dois, o **botão de URL** tem `{{1}}` com o **token nominal**, anexado à base fixa
`https://moravo.com.br/linkgrupo/`. O que vai no link é o token, nunca o código do grupo.

⚠️ **Não existe reserva de template.** Se o campo de um dos lados estiver vazio, aquela
pessoa **não recebe mensagem** e a falha fica registrada em `whatsapp_envios` para reenvio.
Usar o template do outro lado seria pior que não enviar: as variáveis entram em posições
diferentes e a frase sai trocada (aconteceu em 26/08/2026, com o corretor recebendo
"o corretor começou a trabalhar o seu imóvel").

### Por que token e não o código do convite

O código do convite é a chave do grupo: quem o tiver entra, venha de onde vier. Se ele
aparece na URL, basta repassar o link para qualquer pessoa entrar. E id de imóvel ou de
interesse seria pior ainda, porque são sequenciais e adivinháveis.

Por isso cada destinatário recebe um **token aleatório de 32 caracteres**, gravado em
`moravo.convites_grupo` e amarrado a (interesse, pessoa, papel). O que isso dá:

- **Não é adivinhável.** Token desconhecido devolve 404, sem exceção.
- **Sabe-se quem abriu.** A tabela guarda `aberturas`, `aberto_em` e `ultimo_ip`.
- **Dá para revogar um sem afetar o outro** (`revogado = true` devolve 410).
- **O convite do grupo pode ser refeito** sem invalidar os links já enviados.
- **Nome e imóvel na página vêm do banco**, nunca da query string: não dá para forjar.

⚠️ Regra que não pode ser afrouxada: `/linkgrupo` **só resolve por token**. Não existe atalho
por id de interesse nem por código de grupo solto. Sem isso, qualquer pessoa usaria o domínio
da Moravo para dar aparência oficial a um convite de grupo qualquer.

**A conexão do Waha também é editada no painel** (`/admin` → Config. WhatsApp): nome da
sessão, número do atendente principal, URL e números internos extras ficam em
`moravo.config_whatsapp`. O `.env` continua valendo como reserva, e o painel mostra a origem
de cada valor (painel, `.env` ou padrão do código).

A **chave de API do Waha também fica no painel**, cifrada com AES-256-GCM (`lib/cripto.js`,
compartilhado com o token da Meta) e nunca devolvida ao front-end: a tela mostra só os 4
últimos caracteres. Campo em branco mantém a chave atual.

⚠️ O padrão embutido no código é `AtendenteX_Waha`. Antes disso, quem esquecesse
`WAHA_SESSION` no `.env` ficava usando essa sessão sem nunca ser avisado, e o grupo
simplesmente não nascia. O `.env` do servidor continua valendo como reserva para todos esses valores.

**A configuração da Meta fica no painel do admin** (`/admin` → Config. WhatsApp), gravada em
`moravo.config_whatsapp` (linha única). O **token é cifrado com AES-256-GCM** usando
`CONFIG_SECRET` (ou `JWT_SECRET` como reserva) e **nunca volta para o front-end** — a tela
mostra só os 4 últimos caracteres. Com `ativo` desligado, o grupo é criado e o link aparece,
mas nenhuma mensagem é disparada.

**Toda tentativa de criar grupo vira uma linha em `moravo.grupo_tentativas`**, com a **etapa**
em que parou (`criando o grupo no Waha`, `obtendo o link do convite`, `enviando os convites`),
o erro e o número de tentativas. Aparece em `/admin` → Envios WhatsApp, com botão de
**Repetir**, que chama `garantirGrupo` de novo. Sem isso o erro só existia no log do servidor.

**Toda tentativa de envio vira uma linha em `moravo.whatsapp_envios`.** Falha gera notificação
para todos os admins (`tipo = 'envio_whatsapp_falhou'`) e aparece em `/admin` → Envios
WhatsApp, com botão de reenviar. Envio por SMS como alternativa fica para um segundo momento.

**O status de entrega vem do webhook da Meta** (`POST /webhooks/whatsapp`). Sem ele,
`whatsapp_envios.status = 'enviado'` diz apenas que **a Meta aceitou a chamada**, não que a
mensagem chegou: era o ponto cego que transformava todo "não recebi" em palpite. O webhook
grava `entrega` (`sent`, `delivered`, `read`, `failed`), `entrega_erro` e `entrega_em`, e o
painel mostra isso embaixo do status do envio.

A rota é **pública de propósito** (quem chama é a Meta, não um usuário logado). O que
garante a procedência:

- **GET**: handshake com o `webhook_token` de `config_whatsapp`, gerado sozinho na migração
- **POST**: HMAC SHA-256 do corpo cru com o **App Secret**, comparado com
  `X-Hub-Signature-256`. Sem App Secret configurado a checagem é pulada e **o painel avisa**
- o UPDATE **só encosta em linha cujo `wamid` já existe**: o webhook nunca cria registro

Os estados chegam fora de ordem com frequência, então o status só avança na escala
`sent < delivered < read < failed` e nunca regride.

Configurar em Meta Developers → WhatsApp → Configuração → Webhooks, assinando o campo
**messages**. URL, token e o campo do App Secret ficam em `/admin` → Config. WhatsApp.

**Telefones**: no banco há números com e sem o DDI 55. A normalização acontece no envio
(`lib/whatsapp.js`, `normalizarTelefone`). É a causa clássica de mensagem que não chega.

**O grupo nasce quando o corretor coloca o imóvel na carteira**, não na proposta. O corretor
precisa falar com o dono para trabalhar (visita, chaves, detalhes); esperar a proposta seria
pedir que ele vendesse às cegas. `garantirGrupo` é idempotente, então a proposta apenas
reaproveita o grupo existente. Falha no WhatsApp não desfaz a entrada na carteira.

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

## Agente de bugs

`.claude/agents/bugcode.md` é um subagente de caça a bugs, só de leitura. A lista de
armadilhas dentro dele não é genérica: saiu de defeitos que já aconteceram aqui (SELECT
sem a coluna, UPDATE que apaga o bloco vizinho, laço sobre tempo sem teto, `bigint` que
volta como string, `ILIKE '%SC%'` casando dentro de "Francisco"). Quando um bug novo
tiver uma causa que não está lá, vale acrescentar.

Invocar com `bugcode`, apontando o fluxo a investigar.

## Manutenção deste arquivo

Atualizar **no mesmo commit** da mudança sempre que mexer em:

- o que um perfil pode ou não pode fazer
- rotas da API (nova, removida, mudança de permissão)
- schema do banco
- fluxo de negócio (aprovação, candidatura, grupo de WhatsApp)
- deploy, variáveis de ambiente, integrações

Registrar a mudança no histórico abaixo, uma linha por alteração relevante.

### Histórico

- **2026-08-27** — Painel do admin ganhou quatro telas: **Atendimentos** (fila e prazo),
  **Métricas** (acessos, únicos, corretores, compradores e propostas por imóvel),
  **Corretores** (nota, taxa de aceite, tempo de resposta e verificação de CRECI manual) e
  **Cadastros por período** (usuários e corretores por dia, com filtro de data). Criada a
  tabela `imovel_visitas`, contada no servidor e com visitante por hash.
- **2026-08-27** — Revisão das telas por perfil, com seis correções: estado e cidade
  passam a ser editáveis no **perfil** (e o `PUT /api/usuarios/me` grava `uf`, que antes
  ignorava); o **dono é avisado** quando aparece comprador no imóvel dele; as duas
  notificações novas ganharam texto (apareciam como o slug cru); o corretor **vê a própria
  nota**; e o código do imóvel passou a aparecer no admin, no `/anunciar` e nos cards.
- **2026-08-27** — Telas do atendimento: botão do comprador em `/detalhes` com modal de
  progresso próprio, e aba **Compradores** no painel do corretor mostrando o prazo em
  minutos úteis e o botão que confirma. Nova rota `GET /api/atendimentos/meus`.
- **2026-08-27** — Fim do `.html` nas URLs: 301 de `/x.html` para `/x` e 76 links internos
  reescritos. As duas formas devolviam 200, o que era conteúdo duplicado.
- **2026-08-27** — Criado o subagente `bugcode` (`.claude/agents/`), só de leitura, com a
  lista de armadilhas reais deste projeto em vez de conselhos genéricos.
- **2026-08-27** — **Grupo do comprador**: nasce já com o corretor definido e leva o
  primeiro nome dele no assunto (`Casa mc7GvdX · Marcelo`). No repasse o grupo é
  renomeado, o convite anterior é revogado e o corretor que abre o link fora do prazo
  recebe uma página explicando o que houve. Abrir o convite passou a ser o aceite.
  Dois templates novos na Meta (`atendimento_comprador`, `atendimento_corretor`) com
  campos próprios no painel.
- **2026-08-27** — Corrigido um travamento no cálculo de hora útil: com data ausente
  (1970 em JavaScript) o laço rodava 29 milhões de voltas e **derrubava o servidor**.
  Teto de 14 dias e formatador de fuso criado uma vez só: 5,9s → 58ms no pior caso.
- **2026-08-27** — Estado e cidade passam a ser obrigatórios para **todos** os perfis no
  cadastro (antes o proprietário virava "Não especificada"), com backfill da UF de quem já
  existia. Criada a avaliação por estrelas do corretor (`/api/avaliacoes`), já lida pela
  fila do atendimento. Copy do cadastro: "Quero anunciar ou comprar imóveis" e "Quero
  trabalhar imóveis na Moravo".
- **2026-08-27** — Base do **atendimento do comprador**: fila de corretores por faixa
  (carteira > cidade > estado > região > qualquer), prazo de 1 hora **útil** com repasse
  automático, e `ofertas_corretor` gravando o desfecho desde já para alimentar o ranking
  futuro. Adicionados `usuarios.uf`, `usuarios.creci_verificado` e `avaliacoes_corretor`.
  Falta a criação do grupo do comprador, as telas e os templates da Meta.
- **2026-08-27** — Foto dos grupos passa a ser trocável pelo painel, gravada no banco em
  vez de `uploads/`, que se perde quando o container é recriado. O arquivo do repositório
  continua como padrão.
- **2026-08-27** — Imóvel ganhou **código público** de 7 caracteres (`codigo`), e ele
  substitui o id sequencial em tudo que é visível: URL (`/imovel/<slug>/?id=<codigo>`),
  selo na página do imóvel, nome do grupo (`Casa mc7GvdX`) e variável das mensagens.
  `/detalhes?id=` responde 301 para a URL nova. O servidor passou a injetar title,
  description, canonical e Open Graph do imóvel, e foram criados `/sitemap.xml` e
  `/robots.txt`: os cards abrem por `onclick`, então antes não havia link nenhum para um
  buscador seguir. Grupo novo já nasce com a foto da Moravo.
- **2026-08-27** — `/linkgrupo` passa a mandar primeiro para `whatsapp://chat?code=`, com
  `https://chat.whatsapp.com/` como reserva automática. No iPhone, o link https aberto de
  dentro do navegador embutido do WhatsApp levava à página web do WhatsApp e de lá para a App
  Store, oferecendo instalar o app para quem já tinha. Os dois endereços saem do mesmo link
  validado, e o `render` revalida por conta própria.
- **2026-08-27** — `#propertyMap` ganhou `position: relative; z-index: 0`. Os panes do Leaflet
  usam z-index 200/400 e os controles 1000; sem contexto de empilhamento no contêiner, eles
  escapavam e cobriam o modal de "Trabalhar este imóvel", que fica preso no contexto criado
  pelo `position: sticky` do `.sticky-card`.
- **2026-08-27** — Criado o **webhook de status da Meta** (`routes/webhook-whatsapp.js`):
  a lista de envios passa a mostrar entregue, lido ou falhou na entrega, com o motivo, em vez
  de só "a Meta aceitou". Handshake por token, corpo conferido por assinatura quando o App
  Secret está configurado, e o update só toca em `wamid` já existente. No caminho apareceu que
  o botão **Reenviar** do painel mandava **sem variável nenhuma** e com o **código do grupo no
  lugar do token** (link que o `/linkgrupo` nunca resolveria): agora ele usa o mesmo
  `montarDestinatarios` do envio original, extraído para `lib/grupo.js`.
- **2026-08-27** — Os dois formulários de `/admin` → Config. WhatsApp salvam pelo mesmo
  `PUT /whatsapp/config`, e cada um manda só os campos do seu bloco. O UPDATE gravava NULL
  no que faltasse, então **salvar a configuração da Meta apagava a conexão do Waha** (foi o
  que zerou sessão e atendente às 12:48). Agora campo ausente no corpo não é tocado.
- **2026-08-27** — `getConfig` (`lib/whatsapp.js`) não trazia `template_corretor` no SELECT,
  então o campo era sempre vazio: o painel mostrava em branco mesmo depois de salvo e o
  corretor nunca recebia convite. Registrado também que **`status = 'enviado'` significa
  "a Meta aceitou"**, não "chegou": sem webhook de status, entrega não é observável.
- **2026-08-27** — Confirmado o par de templates da Meta: `convite_grupo_proprietario` e
  `convite_grupo_corretor`, com **três variáveis cada e ordens diferentes**. A ordem enviada
  pelo `lib/grupo.js` bate com as duas. Removida a reserva de template (sem o do corretor,
  ele não recebe nada em vez de receber o texto do proprietário) e apagada a `enviarConvites`
  morta de `routes/interesses.js`, que ainda enviava sem variável nenhuma. O `gerarInviteGrupo`
  passou a tentar primeiro o endpoint que o Waha responde, tirando três 404 do log a cada
  grupo criado.
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
- **2026-08-27** — Template com mais de uma variável no corpo: `enviarTemplateConvite` passa a
  receber uma lista, e cada destinatário tem a sua ordem. A configuração ganhou um segundo
  campo (template do proprietário e do corretor), e o envio de teste pergunta à Meta quantas
  variáveis o template espera em vez de adivinhar.
- **2026-08-27** — Modal de progresso ao clicar em "Trabalhar este imóvel", com frases
  alternando enquanto o grupo é criado e as mensagens saem, terminando no botão de entrar no
  grupo. Quando o grupo falha, a tela diz que o imóvel entrou na carteira e omite o botão, em
  vez de oferecer um link vazio.
- **2026-08-27** — **Primeiro convite entregue de ponta a ponta** em produção: grupo criado no
  Waha, token emitido, template disparado e mensagem recebida com o botão. O corretor, porém,
  recebeu o texto do proprietário, porque `template_corretor` estava vazio e havia reserva
  para o outro template. A reserva foi removida: sem template próprio, o corretor não recebe
  mensagem e a falha fica registrada em `whatsapp_envios` com o motivo, para reenvio depois.
- **2026-08-27** — Falhas na criação do grupo passam a ser registradas em `grupo_tentativas`
  com a etapa em que pararam, visíveis no painel e com botão de repetir. O teste dessa
  instrumentação revelou um bug que travava **toda** criação de grupo: `criarGrupo` exigia 2
  participantes, regra herdada de quando proprietário e corretor eram adicionados à força. No
  modelo atual o grupo nasce só com o atendente, ou seja, 1 participante.
- **2026-08-27** — Corrigido o bug que anulava a configuração do painel: `lib/grupo.js` e a
  rota `/criar-grupo-whatsapp` liam `process.env.WAHA_ATENDENTE_PRINCIPAL` direto, ignorando o
  que o admin tinha preenchido. A rota antiga (213 linhas com a criação do grupo duplicada)
  passou a chamar `garantirGrupo`, e ficou com 38. **Nada em `routes/` lê variável do Waha
  agora**: só `lib/waha.js`, que é onde o `.env` funciona como reserva.
- **2026-08-27** — Chave de API do Waha passa a ser configurável no painel, cifrada como o
  token da Meta. Cifra extraída para `lib/cripto.js`, usada pelos dois. Motivo: o diagnóstico
  mostrou que o `.env` da VPS não tinha nenhuma variável do Waha, e sem a chave a criação do
  grupo falha na primeira linha, sem deixar registro de envio.
- **2026-08-27** — Conexão do Waha (sessão, atendente, URL e extras) passa a ser editável em
  `/admin` → Config. WhatsApp, gravada em `config_whatsapp`, com o `.env` como reserva. Novo
  diagnóstico mostra a sessão realmente em uso, de onde ela veio e o status das sessões no
  Waha. Motivo: um imóvel entrou na carteira sem criar grupo e sem nenhum registro de erro
  visível, porque a sessão vinha de variável de ambiente com padrão silencioso.
- **2026-08-25** — Convite do grupo passa a usar **token nominal** (`convites_grupo`) em vez do
  código do WhatsApp na URL, com registro de quem abriu e revogação individual. `/linkgrupo`
  só resolve por token: id de imóvel e código de grupo solto foram removidos por serem
  adivinháveis. O grupo passou a nascer no clique de "Trabalhar este imóvel", não na proposta.
- **2026-08-25** — `/linkgrupo` deixou de ser um 302 seco e virou página de confirmação, com
  o imóvel, quem está no grupo e botão manual. Aceita `?id=&corretor=` além do sufixo no
  caminho. Query string escapada e destino restrito ao domínio do WhatsApp.
- **2026-08-25** — Template de WhatsApp acertado com o que foi cadastrado na Meta: o corpo
  tem `{{1}}` com o primeiro nome e o botão usa base `https://moravo.com.br/linkgrupo/`.
  Criada a rota `GET /linkgrupo/:codigo` que redireciona para o convite real. Erros da Meta
  passam a trazer código e subcódigo, para diagnóstico.
- **2026-08-19** — Cadastro e edição de imóvel saíram do modal do `dashboard.html` e viraram
  página própria em `/anunciar` (`?id=` para editar). O modal antigo continua no arquivo, mas
  inalcançável: `openImovelModal` e `editarImovel` passaram a redirecionar, e as versões
  originais viraram `*Antigo`. Atenção: `GET /api/cidades` devolve só **20 cidades** por
  padrão, então a página pede `limit=1000` (sem isso Joinville não aparecia na lista de SC).
- **2026-08-18** — Nova aba **Configurações** no painel do admin, com campos de script para
  `<head>` e `<body>` (Tag Manager, pixels). Tabela `config_site`, `lib/site-config.js` e um
  middleware no `server.js` que injeta o código ao servir cada página HTML. O painel do admin
  é excluído da injeção.
- **2026-08-18** — Quarta variante em `/anuncie-4`, ângulo de **facilidade**. Mostra as três
  telas reais do cadastro em mockup, lista o que o proprietário **não** precisa fazer (visita
  de avaliação, contrato, sessão de fotos, pagamento, aprovar corretor, sair de casa) e o que
  ele precisa ter em mãos. Todos os campos exibidos batem com o formulário real.
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
