// Only loaded by `run.cjs database`. Every write is rolled back, including DDL.
const { Client } = require('pg');
const crypto = require('node:crypto');
const test = require('node:test');
const pool = require('../../src/db/pool');
const client = new Client({ connectionString: process.env.TEST_DATABASE_URL,
  ssl: process.env.TEST_DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000 });
let sequence = 0;
let connected = false;
let queue = Promise.resolve();
function serial(fn) {
  const next = queue.then(fn);
  queue = next.catch(() => {});
  return next;
}
async function savepoint(fn) {
  const name = 'suite_sp_' + (++sequence);
  await client.query('SAVEPOINT ' + name);
  try {
    const result = await fn(client);
    await client.query('RELEASE SAVEPOINT ' + name);
    return result;
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT ' + name);
    await client.query('RELEASE SAVEPOINT ' + name);
    throw error;
  }
}
pool.query = (sql, params) => serial(() => savepoint(c => c.query(sql, params)));
pool.withTransaction = fn => serial(() => savepoint(fn));
pool.getPool = () => ({ end: async () => {} });
test.before(async () => {
  await client.connect();
  connected = true;
  await client.query('BEGIN');
  const schema = 'test_suite_' + crypto.randomBytes(8).toString('hex');
  await client.query('CREATE SCHEMA ' + schema);
  await client.query('SET LOCAL search_path TO ' + schema);
  await client.query("SET LOCAL statement_timeout = '30s'");
  console.log('Real PostgreSQL tests: isolated schema, outer rollback, nested savepoints.');
});
test.after(async () => {
  if (!connected) return;
  try {
    await queue;
    await client.query('ROLLBACK');
    console.log('Rolled back test schema and all test records.');
  } finally { await client.end(); }
});
