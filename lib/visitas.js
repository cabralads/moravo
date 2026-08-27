// =========================================================================
// Contagem de acessos por imóvel
// =========================================================================
// "Quantas pessoas viram este imóvel" é a pergunta que decide se o problema
// é falta de audiência ou falta de conversão: 200 visitas sem proposta é um
// anúncio caro; 3 visitas sem proposta é um anúncio invisível. São decisões
// opostas, e sem número não dá para saber qual é.
//
// O visitante é identificado por um HASH de IP + navegador, nunca pelo IP em
// texto. Isso basta para separar "único" de "geral" e não guarda um dado
// pessoal que a gente não precisa ter.
//
// ⚠️ "Único" aqui é aparelho/rede, não pessoa: mesma casa com dois celulares
// conta dois, e a mesma pessoa no trabalho e em casa também. É a definição
// honesta do que dá para medir sem rastrear ninguém.
// =========================================================================
const crypto = require('crypto');
const { query } = require('../db');

const SEGREDO = process.env.CONFIG_SECRET || process.env.JWT_SECRET || 'moravo-visitas';

// Robô não é audiência: contá-los faria o número dizer o contrário da verdade
const ROBOS = /bot|crawler|spider|crawling|facebookexternalhit|slurp|bingpreview|headless|curl|wget|python-requests|axios|postman|lighthouse|monitor|pingdom|uptime/i;

function ehRobo(userAgent) {
  return ROBOS.test(String(userAgent || ''));
}

function hashVisitante(ip, userAgent) {
  return crypto.createHash('sha256')
    .update(String(ip || '') + '|' + String(userAgent || '') + '|' + SEGREDO)
    .digest('hex')
    .slice(0, 32);
}

// Registrar visita não pode atrasar nem derrubar a entrega da página: se
// falhar, a pessoa vê o imóvel do mesmo jeito e a gente perde uma contagem.
async function registrarVisita({ imovelId, ip, userAgent, usuarioId }) {
  if (!imovelId || ehRobo(userAgent)) return { contou: false };
  try {
    await query(
      `INSERT INTO moravo.imovel_visitas (imovel_id, visitante_hash, usuario_id)
       VALUES ($1, $2, $3)`,
      [imovelId, hashVisitante(ip, userAgent), usuarioId || null]
    );
    return { contou: true };
  } catch (err) {
    console.warn('[visitas] não registrou:', err.message);
    return { contou: false };
  }
}

module.exports = { registrarVisita, hashVisitante, ehRobo };
