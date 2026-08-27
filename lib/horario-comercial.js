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
function emSaoPaulo(data) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: FUSO, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  });
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
function minutosUteisEntre(inicio, fim) {
  if (fim <= inicio) return 0;
  let total = 0;
  const cursor = new Date(inicio.getTime());
  cursor.setSeconds(0, 0);
  while (cursor < fim) {
    if (dentroDoExpediente(cursor)) total++;
    cursor.setTime(cursor.getTime() + 60000);
  }
  return total;
}

// O prazo já venceu? Ou seja: passaram-se N minutos úteis desde o início?
function prazoVencido(inicio, minutosUteis) {
  return minutosUteisEntre(new Date(inicio), new Date()) >= minutosUteis;
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
