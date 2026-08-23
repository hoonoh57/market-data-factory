import 'dotenv/config';
import mysql from 'mysql2/promise';

export function mysqlUrl(env = process.env) {
  const value = String(env.MYSQL_URL ?? '').trim();
  if (!value) {
    throw new Error('MYSQL_URL is required. Define it in the local .env file.');
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('MYSQL_URL must be a valid mysql:// connection URL.');
  }
  if (!['mysql:', 'mysql2:'].includes(parsed.protocol)) {
    throw new Error('MYSQL_URL protocol must be mysql:// or mysql2://.');
  }
  if (!parsed.hostname) throw new Error('MYSQL_URL must include a host.');
  if (!parsed.pathname || parsed.pathname === '/') throw new Error('MYSQL_URL must include a database name.');
  return value;
}

export function createMySqlPool({ env = process.env, overrides = {} } = {}) {
  return mysql.createPool({
    uri: mysqlUrl(env),
    waitForConnections: true,
    connectionLimit: 10,
    maxIdle: 10,
    idleTimeout: 60000,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    ...overrides,
  });
}

export async function withMySqlConnection(work, options) {
  if (typeof work !== 'function') throw new Error('withMySqlConnection requires a callback.');
  const pool = createMySqlPool(options);
  try {
    const connection = await pool.getConnection();
    try {
      return await work(connection);
    } finally {
      connection.release();
    }
  } finally {
    await pool.end();
  }
}
