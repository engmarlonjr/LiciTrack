const { Pool } = require('pg');
let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000
    });
  }
  return pool;
}

async function initDB() {
  const p = getPool();
  await p.query(`CREATE TABLE IF NOT EXISTS salvos (id TEXT PRIMARY KEY, dados JSONB NOT NULL, criado_em TIMESTAMP DEFAULT NOW(), atualizado_em TIMESTAMP DEFAULT NOW())`);
  await p.query(`CREATE INDEX IF NOT EXISTS salvos_atualizado_em_idx ON salvos (atualizado_em DESC)`);
}

module.exports = { getPool, initDB };
