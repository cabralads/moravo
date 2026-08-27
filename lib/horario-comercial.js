// =========================================================================
// Horário comercial da Moravo (fuso de São Paulo)
// =========================================================================
// O prazo de 1h para o corretor entrar no grupo só corre em horário
// comercial. Um lead que chega sábado às 17h não pode ser repassado às 18h,
// quando ninguém está trabalhando: o corretor perderia a vez sem ter tido
// chance nenhuma de responder.
//
// Por isso o prazo aqui não é "agora + 1h", é "agora + 1h ÚTIL": o relógio
// pausa fora do expediente e volta a andar quando ele reabre.
// =========================================================================

const FUSO = 'America/Sao_Paulo';

// dia: 0 = domingo ... 6 = sábado
const EXPEDIENTE = {
  1: [8, 18], 2: [8, 18], 3: [8, 18], 4: [8, 18], 5: [8, 18], // seg a sex
  6: [8, 16],                                                  // sábado
  // domingo não aparece: fechado
};

// Converte um instante para os campos de calendário em São Paulo. Sem isso o
// servidor em UTC acharia que 22h de sexta em SP é sábado de madrugada.
// Um formatador só, criado uma vez. Criar um Intl.DateTimeFormat a cada
// chamada custa caro, e este método roda uma vez por minuto de intervalo:
// era ele o gargalo que fazia a conta levar segundos.
const FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUSO, hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
});

function emSaoPaulo(data) {
  const fmt = FMT;
  const p = {};
  for (const parte of fmt.formatToParts(data)) p[parte.type] = parte.value;
  const DIAS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    ano: +p.year, mes: +p.month, dia: +p.day,
    hora: +(p.hour === '24' ? 0 : p.hour), minuto: +p.minute, segundo: +p.second,
    diaSemana: DIAS[p.weekday],
    minutosDoDia: +(p.hour === '24' ? 0 : p.hour) * 60 + +p.minute,
  };
}

function dentroDoExpediente(data) {
  const d = emSaoPaulo(data || new Date());
  const faixa = EXPEDIENTE[d.diaSemana];
  if (!faixa) return false;
  return d.minutosDoDia >= faixa[0] * 60 && d.minutosDoDia < faixa[1] * 60;
}

// Quantos minutos úteis existem entre dois instantes.
// Anda de minuto em minuto de propósito: o volume aqui é baixo (um punhado de
// atendimentos abertos) e a versão esperta, com fusos e horário de verão no
// meio, é onde esse tipo de conta costuma errar sem ninguém perceber.
// Teto de 60 dias: andar de minuto em minuto é barato numa janela de horas,
// e catastrófico numa de décadas. Uma data ausente vira 1970 em JavaScript,
// e o laço rodaria 29 milhões de voltas travando o processo inteiro. Como
// qualquer prazo nosso é de horas, 14 dias já responde "estourou" com folga.
const TETO_DIAS = 14;

function minutosUteisEntre(inicio, fim) {
  const ini = inicio instanceof Date ? inicio : new Date(inicio);
  const fin = fim instanceof Date ? fim : new Date(fim);
  if (isNaN(ini.getTime()) || isNaN(fin.getTime())) return 0;
  if (fin <= ini) return 0;

  const limite = TETO_DIAS * 24 * 60 * 60000;
  const partida = (fin - ini > limite) ? new Date(fin.getTime() - limite) : ini;

  let total = 0;
  const cursor = new Date(partida.getTime());
  cursor.setSeconds(0, 0);
  while (cursor < fin) {
    if (dentroDoExpediente(cursor)) total++;
    cursor.setTime(cursor.getTime() + 60000);
  }
  return total;
}

// O prazo já venceu? Ou seja: passaram-se N minutos úteis desde o início?
function prazoVencido(inicio, minutosUteis) {
  // Sem data de início não dá para dizer que venceu: não venceu.
  if (!inicio) return false;
  const ini = inicio instanceof Date ? inicio : new Date(inicio);
  if (isNaN(ini.getTime())) return false;
  return minutosUteisEntre(ini, new Date()) >= minutosUteis;
}

// Quando o expediente reabre (ou agora, se já está aberto). Serve para dizer
// ao corretor até que horas ele tem, em vez de mostrar um prazo que corre
// enquanto ele dorme.
function proximaAbertura(data) {
  const cursor = new Date((data || new Date()).getTime());
  cursor.setSeconds(0, 0);
  for (let i = 0; i < 60 * 24 * 8; i++) {   // no máximo 8 dias à frente
    if (dentroDoExpediente(cursor)) return cursor;
    cursor.setTime(cursor.getTime() + 60000);
  }
  return cursor;
}

module.exports = {
  FUSO, EXPEDIENTE, emSaoPaulo, dentroDoExpediente,
  minutosUteisEntre, prazoVencido, proximaAbertura,
};
