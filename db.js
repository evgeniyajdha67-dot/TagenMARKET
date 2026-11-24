const Database = require('better-sqlite3');
const db = new Database('market.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    ton_balance REAL DEFAULT 100
  );
  CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    nft_slug TEXT,
    nft_name TEXT,
    nft_emoji TEXT
  );
  CREATE TABLE IF NOT EXISTS listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    seller_id INTEGER,
    nft_slug TEXT,
    nft_name TEXT,
    nft_emoji TEXT,
    price_ton REAL,
    status TEXT DEFAULT 'active'
  );
`);

module.exports = db;
