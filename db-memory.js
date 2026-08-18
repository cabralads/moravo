// =========================================================================
// Stub de banco para desenvolvimento local (sem Postgres instalado)
// =========================================================================
// O db.js cai aqui quando não há DATABASE_URL no .env. A ideia é permitir
// abrir o site e navegar pelas páginas sem depender de banco nenhum.
//
// Não é um Postgres de mentira: consultas retornam vazio. Telas que dependem
// de dados (busca, dashboard, admin) aparecem sem conteúdo, e é esperado.
// Para trabalhar com dados de verdade, defina DATABASE_URL.
// =========================================================================

const vazio = { rows: [], rowCount: 0, command: '', fields: [] };

async function query(text) {
  if ((process.env.NODE_ENV || 'development') !== 'production') {
    const primeiraLinha = String(text || '').trim().split('\n')[0].slice(0, 80);
    console.log(`[db/stub] ignorado: ${primeiraLinha}`);
  }
  return vazio;
}

// Imita o mínimo da interface do pg.Pool usada pelo projeto
const pool = {
  query,
  connect: async () => ({ query, release() {} }),
  end: async () => {},
  on() {},
};

module.exports = { pool, query, mode: 'json-stub' };
