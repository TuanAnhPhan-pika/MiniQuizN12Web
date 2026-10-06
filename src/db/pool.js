const { Pool } = require('pg');

let pool = null;

function getPoolConfig() {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
      max: 20,
      idleTimeoutMillis: 30000,
    };
  }

  const host = process.env.SQL_HOST || process.env.PGHOST || '127.0.0.1';
  const isUnixSocket = host.startsWith('/');

  return {
    host: host,
    port: isUnixSocket ? undefined : Number(process.env.SQL_PORT || process.env.PGPORT || 5432),
    user: process.env.SQL_USER || process.env.PGUSER || 'postgres',
    password: process.env.SQL_PASSWORD || process.env.PGPASSWORD || '',
    database: process.env.SQL_DB_NAME || process.env.PGDATABASE || 'postgres',
    max: 20,
    idleTimeoutMillis: 30000,
  };
}

function getPool() {
  if (!pool) {
    const config = getPoolConfig();
    pool = new Pool(config);

    pool.on('error', (err) => {
      console.error('Lỗi bất ngờ trên idle PostgreSQL client:', err.message);
    });
  }
  return pool;
}

async function query(text, params) {
  const p = getPool();
  const start = Date.now();
  try {
    const res = await p.query(text, params);
    return res;
  } catch (err) {
    console.error('Lỗi thực thi PostgreSQL query:', err.message, { text: text.slice(0, 100) });
    throw err;
  }
}

async function withTransaction(callback) {
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getPool,
  query,
  withTransaction,
};
