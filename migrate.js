// ينشئ الجداول الأساسية لو مش موجودة. يشتغل مرة واحدة بس (تلقائيًا عند أول تشغيل).
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS installments (
      id TEXT PRIMARY KEY,
      fields JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      fields JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log('migration done');
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
