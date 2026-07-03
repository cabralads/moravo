// =========================================================================
// Helper: criar notificação persistida
// =========================================================================
const { query } = require('../db');

/**
 * Insere uma notificação para o usuario_id com os metadados fornecidos.
 * @param {Object} notif
 * @param {number} notif.usuario_id   - quem recebe
 * @param {string} notif.tipo         - 'corretor_escolhido' | 'corretor_recusado' | 'corretor_recusado_auto' | 'imovel_vendido'
 * @param {number} [notif.imovel_id]
 * @param {number} [notif.interesse_id]
 * @param {number} [notif.remetente_id] - quem gerou (dono, corretor, etc)
 * @param {Object} [notif.payload]      - dados extras (JSONB)
 */
async function criarNotificacao(notif) {
  const r = await query(
    `INSERT INTO moravo.notificacoes
       (usuario_id, tipo, imovel_id, interesse_id, remetente_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, created_at`,
    [
      notif.usuario_id,
      notif.tipo,
      notif.imovel_id || null,
      notif.interesse_id || null,
      notif.remetente_id || null,
      JSON.stringify(notif.payload || {}),
    ]
  );
  return r.rows[0];
}

module.exports = { criarNotificacao };
