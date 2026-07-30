import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

// Initialize PostgreSQL Connection Pool (Supports Vercel Postgres, Supabase, Neon, etc.)
const connectionString = 
  process.env.DATABASE_URL || 
  process.env.POSTGRES_URL || 
  process.env.POSTGRES_PRISMA_URL || 
  process.env.POSTGRES_URL_NON_POOLING || 
  process.env.SUPABASE_DATABASE_URL || 
  'postgres://postgres:password@localhost:5432/stock_analyzer';

export const pool = new Pool({
  connectionString,
  ssl: connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
    ? false
    : { rejectUnauthorized: false }
});

pool.on('error', (err) => {
  console.error('[PG Pool Error] Unexpected error on idle client:', err.message);
});

/**
 * Initialize database schemas (Auto-Migration)
 */
export async function initDB() {
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    console.warn('\n⚠️ [PostgreSQL Warning]: Tidak dapat terhubung ke database PostgreSQL.');
    console.warn(`⚠️ Error detail: ${err.message}`);
    console.warn(`⚠️ Pastikan PostgreSQL sudah terinstal dan aktif, serta string DATABASE_URL pada .env sudah benar.`);
    console.warn(`⚠️ Fitur analisa saham real-time tetap beroperasi normal, namun fitur login & jurnal trading menanti koneksi database.\n`);
    return false;
  }

  try {
    console.log('📦 [PostgreSQL] Terhubung ke database. Menyiapkan skema tabel (Auto-Migration)...');
    
    // 1. Tabel users
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Tabel transactions (Jurnal & Evaluasi)
    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        symbol VARCHAR(20) NOT NULL,
        type VARCHAR(10) NOT NULL,
        price NUMERIC(15, 2) NOT NULL,
        quantity INTEGER NOT NULL,
        total_value NUMERIC(18, 2) NOT NULL,
        transaction_date TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        strategy_tag VARCHAR(100),
        notes TEXT,
        pnl NUMERIC(15, 2) DEFAULT NULL,
        pnl_percent NUMERIC(8, 2) DEFAULT NULL
      );
    `);

    // Indexing untuk kecepatan pencarian transaksi berdasarkan user dan simbol saham
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_symbol ON transactions(symbol);
    `);

    console.log('✅ [PostgreSQL] Skema tabel `users` dan `transactions` siap!');
    return true;
  } catch (err) {
    console.error('❌ [PostgreSQL Migration Error]:', err.message);
    return false;
  } finally {
    if (client) client.release();
  }
}

let dbInitPromise = null;
export async function ensureDB() {
  if (!dbInitPromise) {
    dbInitPromise = initDB();
  }
  return await dbInitPromise;
}
