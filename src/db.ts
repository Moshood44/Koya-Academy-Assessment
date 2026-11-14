import pg from 'pg';

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    pool = new pg.Pool({
      connectionString,
      max: 1,
      ssl: false,
    });
  }
  return pool;
}
