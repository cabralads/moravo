// =========================================================================
// Pool de dados — Postgres real OU stub JSON local
// =========================================================================
const path = require('path');

// Se tiver DATABASE_URL no .env, usa Postgres de verdade.
// Senão, cai no stub JSON (modo dev local, sem instalar nada).
const useRealDb = !!process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== '';

let pool, query, mode;

if (useRealDb) {
  // Modo produção / staging — Postgres real
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on('error', (err) => {
    console.error('[db] erro inesperado em conexão ociosa:', err);
  });

  query = async function (text, params) {
    const start = Date.now();
    try {
      const result = await pool.query(text, params);
      const duration = Date.now() - start;
      if ((process.env.NODE_ENV || 'development') !== 'production') {
        console.log(`[db/pg] ${duration}ms  ${text.split('\n')[0].slice(0, 80)}`);
      }
      return result;
    } catch (err) {
      console.error('[db/pg] query falhou:', err.message);
      throw err;
    }
  };

  mode = 'postgres';
  console.log('[db] modo: POSTGRES →', process.env.DATABASE_URL.replace(/:[^:@]+@/, ':***@'));
} else {
  // Modo dev local — JSON stub
  const stub = require('./db-memory');
  pool = stub.pool;
  query = stub.query;
  mode = stub.mode;
  console.log('[db] modo: JSON STUB →', path.join(__dirname, 'data', 'usuarios.json'));
}

module.exports = { pool, query, mode };
