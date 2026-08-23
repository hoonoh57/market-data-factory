import 'dotenv/config';
import mysql from 'mysql2/promise';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3306;
const DEFAULT_DATABASE = 'market_data';

export function mysqlUrl(env = process.env) {
  const value = String(env.MYSQL_URL ?? '').trim();
  if (!value) return null;

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

export function mysqlConfig(env = process.env) {
  const uri = mysqlUrl(env);
  if (uri) return { uri };

  const host = String(env.MYSQL_HOST ?? DEFAULT_HOST).trim() || DEFAULT_HOST;
  const port = Number(env.MYSQL_PORT ?? DEFAULT_PORT);
  const user = String(env.MYSQL_USER ?? '').trim();
  const password = String(env.MYSQL_PASSWORD ?? '');
  const database = String(env.MYSQL_DATABASE ?? DEFAULT_DATABASE).trim() || DEFAULT_DATABASE;

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('MYSQL_PORT must be an integer between 1 and 65535.');
  }
  if (!user) throw new Error('MYSQL_USER is required when MYSQL_URL is not set.');
  if (!password) throw new Error('MYSQL_PASSWORD is required when MYSQL_URL is not set.');

  return { host, port, user, password, database };
}

export function createMySqlPool({ env = process.env, overrides = {} } = {}) {
  return mysql.createPool({
    ...mysqlConfig(env),
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
