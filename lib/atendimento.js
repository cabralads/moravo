// =========================================================================
// Atendimento do comprador
// =========================================================================
// Um proprietário que quer COMPRAR o imóvel de outro proprietário precisa de
// um corretor no meio: é ele quem leva a proposta ao dono. O grupo do
// comprador é sempre comprador + UM corretor + atendente da Moravo.
//
// Um só, nunca vários: corretores são concorrentes entre si, e um vendo a
// negociação do outro azeda a conversa. E o comprador nunca entra no grupo
// que já existe entre dono e corretor, senão ele negocia direto com o dono e
// a intermediação (que é de onde vem a receita) deixa de existir.
//
// Se ninguém está trabalhando o imóvel, o sistema escolhe um corretor e dá a
// ele 1 hora ÚTIL para entrar no grupo. Não entrou, passa para o próximo.
// =========================================================================
const { query } = require('../db');
const { criarNotificacao } = require('./notifications');
const horario = require('./horario-comercial');

const PRAZO_MINUTOS = 60;

// ---- A fila de candidatos
// A ordem é por faixa, e dentro da faixa por nota. Quem ainda não tem nota
// entra como 3.5 (mediana da escala) em vez de 0: começar do zero congelaria
// o corretor novo para sempre, porque ele nunca receberia o primeiro lead
// que lhe daria a primeira nota.
async function filaCorretores(imovel, excluirIds) {
  const excluir = (excluirIds || []).filter(Boolean);
  const r = await query(
    `SELECT u.id, u.nome, u.whatsapp, u.cidade, u.uf,
            COALESCE(a.media, 3.5) AS nota,
            COALESCE(a.total, 0)   AS avaliacoes,
            CASE
              WHEN EXISTS (SELECT 1 FROM moravo.interesses i
                            WHERE i.imovel_id = $1 AND i.corretor_id = u.id) THEN 0
              WHEN lower(u.cidade) = lower($2) AND upper(COALESCE(u.uf,'')) = upper($3) THEN 1
              WHEN upper(COALESCE(u.uf,'')) = upper($3) THEN 2
              -- A UF tem 2 letras e casa dentro de palavra: '%SC%' pega
              -- "Belem do Sao FranCISCo". Por isso ela é comparada como
              -- palavra inteira, e não como pedaço de texto.
              WHEN COALESCE(u.regiao_atuacao,'') ILIKE '%' || $2 || '%'
                OR COALESCE(u.regiao_atuacao,'') ~* ('(^|[^a-zA-Z])' || $3 || '([^a-zA-Z]|$)') THEN 3
              ELSE 4
            END AS faixa
       FROM moravo.usuarios u
       LEFT JOIN (
         SELECT corretor_id, AVG(nota)::numeric(3,2) AS media, COUNT(*) AS total
           FROM moravo.avaliacoes_corretor GROUP BY corretor_id
       ) a ON a.corretor_id = u.id
      WHERE u.perfil = 'corretor'
        AND u.id <> ALL($4::bigint[])
      ORDER BY faixa, nota DESC, random()`,
    [imovel.id, imovel.cidade || '', imovel.uf || '', excluir.length ? excluir : [0]]
  );
  return r.rows;
}

const NOME_FAIXA = {
  0: 'já trabalha o imóvel',
  1: 'mesma cidade',
  2: 'mesmo estado',
  3: 'região de atuação',
  4: 'sem corretor na região',
};

// ---- Escolhe o próximo corretor e registra a oferta
// Não escolhe quem já foi ofertado neste atendimento, nem o dono do imóvel,
// nem o próprio comprador (um proprietário também pode ser corretor).
async function atribuirCorretor(atendimentoId) {
  const r = await query(
    `SELECT ic.id, ic.imovel_id, ic.comprador_id, ic.rodada,
            im.cidade, im.uf, im.titulo, im.codigo, im.dono_id
       FROM moravo.interesses_compradores ic
       JOIN moravo.imoveis im ON im.id = ic.imovel_id
      WHERE ic.id = $1`,
    [atendimentoId]
  );
  if (r.rowCount === 0) throw new Error('Atendimento não encontrado.');
  const at = r.rows[0];

  const jaOfertados = await query(
    `SELECT corretor_id FROM moravo.ofertas_corretor WHERE atendimento_id = $1`,
    [atendimentoId]
  );
  const excluir = jaOfertados.rows.map((x) => Number(x.corretor_id))
    .concat([Number(at.dono_id), Number(at.comprador_id)]);

  const fila = await filaCorretores({ id: at.imovel_id, cidade: at.cidade, uf: at.uf }, excluir);
  if (!fila.length) {
    // Acabaram os corretores. O grupo continua de pé com o atendente da
    // Moravo dentro, então o comprador não fica sem ninguém: quem assume é
    // uma pessoa, não uma fila vazia.
    await query(
      `UPDATE moravo.interesses_compradores
          SET status = 'sem_corretor', corretor_id = NULL, atribuido_em = NULL
        WHERE id = $1`,
      [atendimentoId]
    );
    return { atribuido: false, motivo: 'Nenhum corretor disponível.' };
  }

  const escolhido = fila[0];
  const rodada = Number(at.rodada) + 1;

  await query(
    `UPDATE moravo.interesses_compradores
        SET corretor_id = $1, status = 'aguardando_corretor',
            atribuido_em = NOW(), entrou_em = NULL, rodada = $2
      WHERE id = $3`,
    [escolhido.id, rodada, atendimentoId]
  );
  await query(
    `INSERT INTO moravo.ofertas_corretor
       (atendimento_id, corretor_id, imovel_id, rodada, criterio)
     VALUES ($1, $2, $3, $4, $5)`,
    [atendimentoId, escolhido.id, at.imovel_id, rodada, NOME_FAIXA[escolhido.faixa] || 'indefinido']
  );

  const ate = horario.proximaAbertura(new Date());
  await criarNotificacao({
    usuario_id: escolhido.id,
    tipo: 'comprador_para_atender',
    imovel_id: at.imovel_id,
    payload: {
      atendimento_id: atendimentoId,
      imovel_titulo: at.titulo,
      imovel_codigo: at.codigo,
      prazo_minutos: PRAZO_MINUTOS,
      criterio: NOME_FAIXA[escolhido.faixa] || '',
      // Prazo só corre em horário comercial: se chegou fora dele, o relógio
      // começa a contar na próxima abertura.
      comeca_em: horario.dentroDoExpediente(new Date()) ? null : ate.toISOString(),
    },
  }).catch((err) => console.warn('[atendimento] notificação falhou:', err.message));

  return { atribuido: true, corretor: escolhido, rodada: rodada, criterio: NOME_FAIXA[escolhido.faixa] };
}

// ---- Marca que o corretor entrou (fecha a oferta aberta)
async function registrarEntrada(atendimentoId, corretorId) {
  const r = await query(
    `UPDATE moravo.interesses_compradores
        SET entrou_em = NOW(), status = 'com_corretor'
      WHERE id = $1 AND corretor_id = $2 AND entrou_em IS NULL
      RETURNING atribuido_em`,
    [atendimentoId, corretorId]
  );
  if (r.rowCount === 0) return { mudou: false };

  // Atendimento sem atribuido_em não tem tempo de resposta para medir
  const inicio = r.rows[0].atribuido_em;
  const minutos = inicio ? horario.minutosUteisEntre(new Date(inicio), new Date()) : null;
  await query(
    `UPDATE moravo.ofertas_corretor
        SET desfecho = 'entrou', respondida_em = NOW(), minutos_uteis = $2
      WHERE atendimento_id = $1 AND corretor_id = $3 AND desfecho = 'aberta'`,
    [atendimentoId, minutos, corretorId]
  );
  return { mudou: true, minutos_uteis: minutos };
}

// ---- Passa adiante quem não entrou no prazo
// Roda de tempos em tempos. Só olha atendimento com corretor atribuído e sem
// entrada registrada; o prazo é contado em minutos ÚTEIS, então quem recebeu
// o lead às 17h50 de sexta ainda tem 50 minutos na segunda de manhã.
async function repassarVencidos() {
  const r = await query(
    `SELECT id, corretor_id, atribuido_em
       FROM moravo.interesses_compradores
      WHERE status = 'aguardando_corretor'
        AND corretor_id IS NOT NULL
        AND entrou_em IS NULL
        AND atribuido_em IS NOT NULL`
  );

  const repassados = [];
  for (const at of r.rows) {
    if (!horario.prazoVencido(at.atribuido_em, PRAZO_MINUTOS)) continue;
    await query(
      `UPDATE moravo.ofertas_corretor
          SET desfecho = 'expirou', respondida_em = NOW(), minutos_uteis = $2
        WHERE atendimento_id = $1 AND corretor_id = $3 AND desfecho = 'aberta'`,
      [at.id, PRAZO_MINUTOS, at.corretor_id]
    );
    try {
      const novo = await atribuirCorretor(at.id);
      // O grupo já existe: renomeia com o nome do novo corretor, revoga o
      // convite de quem perdeu a vez e manda o convite novo.
      try {
        const { trocarCorretorDoGrupo } = require('./grupo');
        await trocarCorretorDoGrupo(at.id, at.corretor_id);
      } catch (err) {
        console.warn('[atendimento] grupo não atualizado no repasse:', err.message);
      }
      repassados.push({ atendimento_id: at.id, de: at.corretor_id, para: novo.corretor ? novo.corretor.id : null });
    } catch (err) {
      console.error('[atendimento] falha ao repassar', at.id, err.message);
    }
  }
  if (repassados.length) console.log('[atendimento] repassados:', JSON.stringify(repassados));
  return repassados;
}

module.exports = {
  PRAZO_MINUTOS, NOME_FAIXA,
  filaCorretores, atribuirCorretor, registrarEntrada, repassarVencidos,
};
