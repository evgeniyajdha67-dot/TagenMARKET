const Database = require('better-sqlite3');
const db = new Database(process.env.DB_PATH || 'market.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password_hash TEXT,
    ton_balance REAL DEFAULT 0,
    stars_balance REAL DEFAULT 0,
    role TEXT DEFAULT 'user',
    is_banned INTEGER DEFAULT 0,
    is_verified INTEGER DEFAULT 0,
    ref_by INTEGER,
    heir_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    nft_slug TEXT,
    nft_name TEXT,
    nft_emoji TEXT,
    acquired_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id INTEGER,
    nft_slug TEXT,
    nft_name TEXT,
    nft_emoji TEXT,
    price REAL,
    currency TEXT DEFAULT 'TON',
    status TEXT DEFAULT 'active',
    boosted_until INTEGER DEFAULT 0,
    search_boost_until INTEGER DEFAULT 0,
    price_locked_until INTEGER DEFAULT 0,
    is_private INTEGER DEFAULT 0,
    is_exclusive INTEGER DEFAULT 0,
    bundle_id INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS bundles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id INTEGER,
    price REAL,
    currency TEXT DEFAULT 'TON',
    status TEXT DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS offers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER,
    buyer_id INTEGER,
    price REAL,
    currency TEXT DEFAULT 'TON',
    status TEXT DEFAULT 'pending',
    fast_delivery INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS auctions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id INTEGER,
    nft_slug TEXT,
    nft_name TEXT,
    nft_emoji TEXT,
    start_price REAL,
    reserve_price REAL DEFAULT 0,
    current_bid REAL,
    current_bidder_id INTEGER,
    currency TEXT DEFAULT 'TON',
    end_time INTEGER,
    status TEXT DEFAULT 'active',
    is_urgent INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS bids (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    auction_id INTEGER,
    bidder_id INTEGER,
    amount REAL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sales_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id INTEGER,
    buyer_id INTEGER,
    nft_slug TEXT,
    nft_name TEXT,
    nft_emoji TEXT,
    price REAL,
    currency TEXT,
    sale_type TEXT,
    fee REAL DEFAULT 0,
    fee_currency TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    nft_slug TEXT,
    UNIQUE(user_id, nft_slug)
  );
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    title TEXT,
    text TEXT,
    is_read INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    role TEXT,
    action TEXT,
    details TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS withdrawals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    type TEXT,
    nft_slug TEXT,
    nft_name TEXT,
    nft_emoji TEXT,
    amount REAL,
    amount_net REAL,
    fee REAL DEFAULT 0,
    currency TEXT,
    target TEXT,
    urgent INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS auction_holds (
    auction_id INTEGER PRIMARY KEY,
    user_id INTEGER,
    amount REAL,
    currency TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS roulette_spins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    cost REAL,
    prize REAL,
    pool TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER UNIQUE,
    paid REAL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS guarantees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id INTEGER,
    buyer_id INTEGER,
    seller_id INTEGER,
    price REAL,
    currency TEXT DEFAULT 'TON',
    fee REAL,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS nft_trials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    nft_slug TEXT,
    nft_name TEXT,
    nft_emoji TEXT,
    expires_at INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    nft_slug TEXT,
    nft_name TEXT,
    result TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
`);

// Идемпотентные миграции для старых БД
const migrations = [
  "ALTER TABLE sales_history ADD COLUMN fee REAL DEFAULT 0",
  "ALTER TABLE sales_history ADD COLUMN fee_currency TEXT",
  "ALTER TABLE withdrawals ADD COLUMN fee REAL DEFAULT 0",
  "ALTER TABLE withdrawals ADD COLUMN amount_net REAL",
  "ALTER TABLE withdrawals ADD COLUMN urgent INTEGER DEFAULT 0",
  "ALTER TABLE users ADD COLUMN is_verified INTEGER DEFAULT 0",
  "ALTER TABLE users ADD COLUMN heir_id INTEGER",
  "ALTER TABLE listings ADD COLUMN boosted_until INTEGER DEFAULT 0",
  "ALTER TABLE listings ADD COLUMN search_boost_until INTEGER DEFAULT 0",
  "ALTER TABLE listings ADD COLUMN price_locked_until INTEGER DEFAULT 0",
  "ALTER TABLE listings ADD COLUMN is_private INTEGER DEFAULT 0",
  "ALTER TABLE listings ADD COLUMN is_exclusive INTEGER DEFAULT 0",
  "ALTER TABLE listings ADD COLUMN bundle_id INTEGER",
  "ALTER TABLE offers ADD COLUMN fast_delivery INTEGER DEFAULT 0",
  "ALTER TABLE auctions ADD COLUMN reserve_price REAL DEFAULT 0",
  "ALTER TABLE auctions ADD COLUMN is_urgent INTEGER DEFAULT 0",
];
for (const m of migrations) { try { db.exec(m); } catch(e){} }

module.exports = db;
