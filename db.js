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

const isLocal = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');

// Formatter: Hapus atau ganti parameter sslmode yang memaksa pemindaian sertifikat ketat di Vercel/Supabase
let cleanedConnectionString = connectionString;
if (!isLocal) {
  cleanedConnectionString = cleanedConnectionString
    .replace(/sslmode=(require|verify-full|verify-ca)/gi, 'sslmode=no-verify');
}

export const pool = new Pool({
  connectionString: cleanedConnectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false }
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
    
    // 1. Tabel app_users (Penggunaan nama 'app_users' mencegah bentrokan dengan tabel 'users' sistem Supabase)
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        watchlist TEXT[] DEFAULT ARRAY['BBRI.JK', 'TLKM.JK', 'BBCA.JK', 'AAPL', 'GOOGL'],
        tier VARCHAR(20) DEFAULT 'FREE',
        payment_status VARCHAR(20) DEFAULT 'FREE',
        payment_method VARCHAR(50) DEFAULT 'FREE',
        tier_expires TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      ALTER TABLE app_users ADD COLUMN IF NOT EXISTS watchlist TEXT[] DEFAULT ARRAY['BBRI.JK', 'TLKM.JK', 'BBCA.JK', 'AAPL', 'GOOGL'];
      ALTER TABLE app_users ADD COLUMN IF NOT EXISTS tier VARCHAR(20) DEFAULT 'FREE';
      ALTER TABLE app_users ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) DEFAULT 'FREE';
      ALTER TABLE app_users ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50) DEFAULT 'FREE';
      ALTER TABLE app_users ADD COLUMN IF NOT EXISTS tier_expires TIMESTAMP WITH TIME ZONE;
    `);

    // 2. Tabel app_transactions (Jurnal & Evaluasi Trading)
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_transactions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES app_users(id) ON DELETE CASCADE,
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
      CREATE INDEX IF NOT EXISTS idx_app_transactions_user_id ON app_transactions(user_id);
      CREATE INDEX IF NOT EXISTS idx_app_transactions_symbol ON app_transactions(symbol);
    `);

    // 3. Tabel app_orders (Riwayat Transaksi Payment Gateway Midtrans)
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_orders (
        order_id VARCHAR(100) PRIMARY KEY,
        user_id INTEGER REFERENCES app_users(id) ON DELETE CASCADE,
        gross_amount NUMERIC(15, 2) NOT NULL,
        payment_method VARCHAR(50) DEFAULT 'QRIS/VA',
        status VARCHAR(50) DEFAULT 'PENDING',
        snap_token VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_app_orders_user_id ON app_orders(user_id);
      CREATE INDEX IF NOT EXISTS idx_app_orders_status ON app_orders(status);
    `);

    console.log('✅ [PostgreSQL] Skema tabel `app_users`, `app_transactions`, dan `app_orders` siap!');
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
