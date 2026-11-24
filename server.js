const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./db');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const SUPER_ADMIN = 'tagen';
const SALT_ROUNDS = 12;
const SELL_TON_TO_STARS = 200;
const BUY_TON_FOR_STARS = 2500;
const EXCHANGE_FEE_PCT = 2;

const FEE_SALE = 10;
const FEE_WITHDRAW_NORMAL = 10;
const FEE_WITHDRAW_URGENT = 15;
const FEE_WITHDRAW_NFT = 10;
const MASS_WITHDRAW_THRESHOLD = 100;
const MASS_WITHDRAW_FEE = 12;
const BOOST_PRICE = 1;
const ROULETTE_COST = 10;
const INSTANT_BUY_FEE = 2;
const FAST_BID_PRICE = 0.3;
const GUARANTEE_FEE = 3;
const PRIVATE_LISTING_PRICE = 0.5;
const NFT_TRIAL_PRICE = 0.1;
const EVALUATION_PRICE = 0.2;
const RESERVE_AUCTION_PRICE = 1;
const SEARCH_BOOST_PRICE = 0.5;
const FAST_OFFER_PRICE = 0.1;
const PRICE_LOCK_PRICE = 0.5;
const BUNDLE_FEE = 5;
const HEIR_PRICE = 10;
const VERIFY_PRICE = 50;
const CANCEL_LISTING_FEE = 0.5;
const EXTEND_AUCTION_PRICE = 0.5;
const URGENT_AUCTION_PRICE = 2;
const CANCEL_OFFER_FEE = 0.2;
const MAX_ACTIVE_LISTINGS = 10;
const MAX_ACTIVE_LISTINGS_VERIFIED = 50;
const OFFER_RATE_LIMIT = 10;

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50, standardHeaders: true, legacyHeaders: false });
const offerLimiter = rateLimit({ windowMs: 60 * 1000, max: OFFER_RATE_LIMIT, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => String(req.body?.buyerId || req.ip) });

function num(v, min = 0, max = 1e9) { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : null; }
function validUsername(u) { return typeof u === 'string' && /^[a-zA-Z0-9_]{3,20}$/.test(u); }
function validTarget(t, currency) {
    if (typeof t !== 'string' || t.length < 4 || t.length > 100) return false;
    if (currency === 'TON') return t.length >= 4;
    return t.startsWith('@') && t.length >= 4;
}
function logAction(uid, action, details, ip) {
    try { const u = db.prepare('SELECT role FROM users WHERE id = ?').get(uid); db.prepare('INSERT INTO logs (user_id, role, action, details, ip) VALUES (?,?,?,?,?)').run(uid, u?.role || 'user', action, details, ip || null); }
    catch(e) { console.error('logAction', e); }
}
function notify(uid, title, text) { try { db.prepare('INSERT INTO notifications (user_id, title, text) VALUES (?,?,?)').run(uid, title, text); } catch(e) { console.error('notify', e); } }
function getUser(id) { return db.prepare('SELECT * FROM users WHERE id = ?').get(id); }
function isAdmin(id) { const u = getUser(id); return u && (u.role === 'super' || u.role === 'moder') && !u.is_banned; }
function isSuper(id) { const u = getUser(id); return u && u.role === 'super' && !u.is_banned; }
function isBanned(id) { const u = getUser(id); return !u || !!u.is_banned; }
function validCurrency(c) { return c === 'TON' || c === 'STARS'; }
function owner() { return db.prepare('SELECT id FROM users WHERE username = ?').get(SUPER_ADMIN); }
function payOwner(amount, currency) {
    if (!amount || amount <= 0) return;
    const o = owner(); if (!o) return;
    const bf = currency === 'TON' ? 'ton_balance' : 'stars_balance';
    db.prepare(`UPDATE users SET ${bf} = ${bf} + ? WHERE id = ?`).run(+Number(amount).toFixed(6), o.id);
}
function creditSeller(sellerId, price, currency, feePct = FEE_SALE) {
    const fee = +(price * feePct / 100).toFixed(6);
    const sellerGets = +(price - fee).toFixed(6);
    const bf = currency === 'TON' ? 'ton_balance' : 'stars_balance';
    db.prepare(`UPDATE users SET ${bf} = ${bf} + ? WHERE id = ?`).run(sellerGets, sellerId);
    payOwner(fee, currency);
    return { fee, sellerGets };
}
function recordSale(sellerId, buyerId, nft, price, currency, saleType, feePct = FEE_SALE) {
    const { fee } = creditSeller(sellerId, price, currency, feePct);
    db.prepare(`INSERT INTO sales_history (seller_id, buyer_id, nft_slug, nft_name, nft_emoji, price, currency, sale_type, fee, fee_currency) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(sellerId, buyerId, nft.nft_slug, nft.nft_name, nft.nft_emoji, price, currency, saleType, fee, currency);
    return fee;
}
function addTx(userId, type, currency, amount, meta) {
    try {
        const u = getUser(userId);
        const balanceAfter = currency === 'TON' ? u.ton_balance : u.stars_balance;
        db.prepare('INSERT INTO transactions (user_id, type, currency, amount, balance_after, meta) VALUES (?,?,?,?,?,?)').run(userId, type, currency, amount, balanceAfter, meta ? JSON.stringify(meta) : null);
    } catch(e) { console.error('addTx', e); }
}
function ip(req) { return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || null; }
function countActiveListings(userId) { return db.prepare("SELECT COUNT(*) as c FROM listings WHERE seller_id = ? AND status = 'active'").get(userId).c; }

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/health', (req, res) => {
    let dbOk = true;
    try { db.prepare('SELECT 1').get(); } catch(e) { dbOk = false; }
    res.json({ ok: dbOk, db: dbOk ? 'ok' : 'error', uptime: process.uptime(), memory: process.memoryUsage().rss });
});

// ===== РЕГИСТРАЦИЯ / ЛОГИН =====
app.post('/api/register', authLimiter, async (req, res) => {
    try {
        const { username, password, ref } = req.body;
        if (!validUsername(username)) return res.status(400).json({ error: 'Ник: 3-20 символов, a-z0-9_' });
        if (!password || password.length < 6) return res.status(400).json({ error: 'Пароль мин. 6' });
        if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return res.status(400).json({ error: 'Ник занят' });
        const hash = await bcrypt.hash(password, SALT_ROUNDS);
        const role = username === SUPER_ADMIN ? 'super' : 'user';
        const info = db.prepare('INSERT INTO users (username, password_hash, role, ref_by) VALUES (?,?,?,?)').run(username, hash, role, ref || null);
        const user = getUser(info.lastInsertRowid);
        if (ref && ref !== user.id) {
            const r = getUser(ref);
            if (r) { db.prepare('UPDATE users SET ton_balance = ton_balance + 5 WHERE id = ?').run(ref); db.prepare('UPDATE users SET ton_balance = ton_balance + 5 WHERE id = ?').run(user.id); notify(ref, '🤝 Реферал', `${username} пришёл. +5 TON`); }
        }
        logAction(user.id, 'register', 'Новый аккаунт', ip(req));
        res.json({ id: user.id, username: user.username, ton_balance: user.ton_balance, stars_balance: user.stars_balance, role: user.role, is_verified: user.is_verified });
    } catch(e) { console.error('register', e); res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/login', authLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
        if (!user || !user.password_hash) return res.status(401).json({ error: 'Неверный ник или пароль' });
        if (!(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Неверный ник или пароль' });
        if (user.is_banned) return res.status(403).json({ error: 'Вы забанены' });
        logAction(user.id, 'login', 'Вход', ip(req));
        res.json({ id: user.id, username: user.username, ton_balance: user.ton_balance, stars_balance: user.stars_balance, role: user.role, is_verified: user.is_verified });
    } catch(e) { console.error('login', e); res.status(500).json({ error: 'Ошибка' }); }
});
app.get('/api/user/:id', (req, res) => {
    const u = getUser(req.params.id);
    if (!u) return res.status(404).json({ error: 'Нет' });
    res.json({ id: u.id, username: u.username, ton_balance: u.ton_balance, stars_balance: u.stars_balance, role: u.role, is_banned: u.is_banned, is_verified: u.is_verified, heir_id: u.heir_id });
});
app.get('/api/user-by-name/:username', (req, res) => {
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(req.params.username);
    if (!u) return res.status(404).json({ error: 'Нет' });
    const listings = db.prepare("SELECT * FROM listings WHERE seller_id = ? AND status = 'active' AND is_private = 0 ORDER BY id DESC").all(u.id);
    const sales = db.prepare("SELECT COUNT(*) as c FROM sales_history WHERE seller_id = ?").get(u.id).c;
    const ratingRow = db.prepare("SELECT AVG(rating) as avg, COUNT(*) as c FROM reviews WHERE seller_id = ?").get(u.id);
    res.json({ id: u.id, username: u.username, is_verified: u.is_verified, role: u.role, created_at: u.created_at, listings, sales, rating: ratingRow.avg || 0, reviews_count: ratingRow.c || 0 });
});

// ===== ОБМЕН =====
app.post('/api/exchange', (req, res) => {
    try {
        const { userId, from } = req.body;
        const amount = num(req.body.amount, 0.000001, 1e9);
        if (!amount) return res.status(400).json({ error: 'Сумма' });
        if (!validCurrency(from)) return res.status(400).json({ error: 'Валюта' });
        if (isBanned(userId)) return res.status(403).json({ error: 'Забанен' });
        const u = getUser(userId); if (!u) return res.status(400).json({ error: 'Нет' });
        const trx = db.transaction(() => {
            if (from === 'TON') {
                if (u.ton_balance < amount) throw new Error('Мало TON');
                const gross = amount * SELL_TON_TO_STARS;
                const feeStars = gross * EXCHANGE_FEE_PCT / 100;
                const net = Math.floor(gross - feeStars);
                db.prepare('UPDATE users SET ton_balance = ton_balance - ?, stars_balance = stars_balance + ? WHERE id = ?').run(amount, net, userId);
                payOwner(feeStars, 'STARS');
                addTx(userId, 'exchange', 'TON', -amount, { to: 'STARS', net });
                addTx(userId, 'exchange', 'STARS', net, { from: 'TON' });
            } else {
                if (u.stars_balance < amount) throw new Error('Мало Stars');
                const gross = amount / BUY_TON_FOR_STARS;
                const feeTon = gross * EXCHANGE_FEE_PCT / 100;
                const net = gross - feeTon;
                db.prepare('UPDATE users SET stars_balance = stars_balance - ?, ton_balance = ton_balance + ? WHERE id = ?').run(amount, net, userId);
                payOwner(feeTon, 'TON');
                addTx(userId, 'exchange', 'STARS', -amount, { to: 'TON', net });
                addTx(userId, 'exchange', 'TON', net, { from: 'STARS' });
            }
        });
        trx();
        res.json({ success: true });
    } catch(e) { if (e.message.includes('Мало')) return res.status(400).json({ error: e.message }); console.error('exchange', e); res.status(500).json({ error: 'Ошибка' }); }
});

// ===== ИНВЕНТАРЬ / ИЗБРАННОЕ / ИСТОРИЯ ТРАНЗАКЦИЙ =====
app.get('/api/inventory/:userId', (req, res) => res.json(db.prepare('SELECT * FROM inventory WHERE user_id = ?').all(req.params.userId)));
app.get('/api/favorites/:userId', (req, res) => res.json(db.prepare('SELECT nft_slug FROM favorites WHERE user_id = ?').all(req.params.userId).map(f=>f.nft_slug)));
app.post('/api/favorites', (req, res) => {
    try {
        const { userId, slug } = req.body;
        const ex = db.prepare('SELECT id FROM favorites WHERE user_id = ? AND nft_slug = ?').get(userId, slug);
        if (ex) db.prepare('DELETE FROM favorites WHERE id = ?').run(ex.id);
        else db.prepare('INSERT INTO favorites (user_id, nft_slug) VALUES (?,?)').run(userId, slug);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
app.get('/api/transactions/:userId', (req, res) => {
    res.json(db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(req.params.userId));
});

// ===== WATCHLIST =====
app.get('/api/watchlist/:userId', (req, res) => res.json(db.prepare('SELECT collection_slug FROM watchlist WHERE user_id = ?').all(req.params.userId).map(w=>w.collection_slug)));
app.post('/api/watchlist', (req, res) => {
    try {
        const { userId, slug } = req.body;
        const ex = db.prepare('SELECT id FROM watchlist WHERE user_id = ? AND collection_slug = ?').get(userId, slug);
        if (ex) db.prepare('DELETE FROM watchlist WHERE id = ?').run(ex.id);
        else db.prepare('INSERT INTO watchlist (user_id, collection_slug) VALUES (?,?)').run(userId, slug);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});

// ===== ЛОТЫ =====
app.get('/api/listings', (req, res) => {
    res.json(db.prepare(`SELECT l.*, u.username as seller_name, u.is_verified as seller_verified FROM listings l JOIN users u ON l.seller_id = u.id WHERE l.status = 'active' AND l.is_private = 0 ORDER BY l.boosted_until DESC, l.id DESC`).all());
});
app.post('/api/listings', (req, res) => {
    try {
        const { userId, nft_slug, nft_name, nft_emoji, currency } = req.body;
        const price = num(req.body.price, 0.000001, 1e9);
        if (!price) return res.status(400).json({ error: 'Цена > 0' });
        if (isBanned(userId)) return res.status(403).json({ error: 'Забанен' });
        const u = getUser(userId);
        const maxLots = u.is_verified ? MAX_ACTIVE_LISTINGS_VERIFIED : MAX_ACTIVE_LISTINGS;
        if (countActiveListings(userId) >= maxLots) return res.status(400).json({ error: `Лимит ${maxLots} активных лотов. Верифицируйся для ${MAX_ACTIVE_LISTINGS_VERIFIED}` });
        const item = db.prepare('SELECT * FROM inventory WHERE user_id = ? AND nft_slug = ?').get(userId, nft_slug);
        if (!item) return res.status(400).json({ error: 'NFT не найден' });
        const already = db.prepare("SELECT id FROM listings WHERE seller_id = ? AND nft_slug = ? AND status = 'active'").get(userId, nft_slug);
        if (already) return res.status(400).json({ error: 'Уже выставлен' });
        db.prepare('INSERT INTO listings (seller_id, nft_slug, nft_name, nft_emoji, price, currency) VALUES (?,?,?,?,?,?)').run(userId, nft_slug, nft_name, nft_emoji, price, currency || 'TON');
        db.prepare('DELETE FROM inventory WHERE id = ?').run(item.id);
        logAction(userId, 'listing', `${nft_name} за ${price} ${currency}`, ip(req));
        res.json({ success: true });
    } catch(e) { console.error('listing', e); res.status(500).json({ error: 'Ошибка' }); }
});
app.delete('/api/listings/:id', (req, res) => {
    try {
        const { userId } = req.query;
        const l = db.prepare("SELECT * FROM listings WHERE id = ? AND status = 'active'").get(req.params.id);
        if (!l) return res.status(404).json({ error: 'Нет' });
        const admin = isAdmin(userId);
        if (l.seller_id !== Number(userId) && !admin) return res.status(403).json({ error: 'Нет доступа' });
        const u = getUser(userId);
        if (!admin && (!u || u.ton_balance < CANCEL_LISTING_FEE)) return res.status(400).json({ error: `Нужно ${CANCEL_LISTING_FEE} TON` });
        const trx = db.transaction(() => {
            if (!admin) { db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(CANCEL_LISTING_FEE, userId); payOwner(CANCEL_LISTING_FEE, 'TON'); addTx(userId, 'fee', 'TON', -CANCEL_LISTING_FEE, { reason: 'cancel_listing' }); }
            db.prepare("UPDATE listings SET status = 'cancelled' WHERE id = ?").run(l.id);
            db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)').run(l.seller_id, l.nft_slug, l.nft_name, l.nft_emoji);
        });
        trx();
        logAction(userId, 'cancel_listing', l.nft_name, ip(req));
        res.json({ success: true });
    } catch(e) { console.error('cancel_listing', e); res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/listings/:id/boost', (req, res) => {
    try {
        const { userId } = req.body;
        const l = db.prepare("SELECT * FROM listings WHERE id = ? AND status = 'active'").get(req.params.id);
        if (!l) return res.status(404).json({ error: 'Нет' });
        const admin = isAdmin(userId);
        if (l.seller_id !== Number(userId) && !admin) return res.status(403).json({ error: 'Нет доступа' });
        const u = getUser(userId);
        if (!admin && (!u || u.ton_balance < BOOST_PRICE)) return res.status(400).json({ error: `Нужно ${BOOST_PRICE} TON` });
        const trx = db.transaction(() => {
            if (!admin) { db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(BOOST_PRICE, userId); payOwner(BOOST_PRICE, 'TON'); addTx(userId, 'fee', 'TON', -BOOST_PRICE, { reason: 'boost' }); }
            db.prepare('UPDATE listings SET boosted_until = ? WHERE id = ?').run(Date.now() + 24*3600*1000, l.id);
        });
        trx();
        logAction(userId, 'boost_listing', l.nft_name, ip(req));
        res.json({ success: true });
    } catch(e) { console.error('boost', e); res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/listings/:id/private', (req, res) => {
    try {
        const { userId } = req.body;
        const l = db.prepare("SELECT * FROM listings WHERE id = ? AND status = 'active'").get(req.params.id);
        if (!l) return res.status(404).json({ error: 'Нет' });
        const admin = isAdmin(userId);
        if (l.seller_id !== Number(userId) && !admin) return res.status(403).json({ error: 'Нет доступа' });
        const u = getUser(userId);
        if (!admin && (!u || u.ton_balance < PRIVATE_LISTING_PRICE)) return res.status(400).json({ error: `Нужно ${PRIVATE_LISTING_PRICE} TON` });
        const trx = db.transaction(() => {
            if (!admin) { db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(PRIVATE_LISTING_PRICE, userId); payOwner(PRIVATE_LISTING_PRICE, 'TON'); addTx(userId, 'fee', 'TON', -PRIVATE_LISTING_PRICE, { reason: 'private' }); }
            db.prepare('UPDATE listings SET is_private = 1 WHERE id = ?').run(l.id);
        });
        trx();
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/listings/:id/lock-price', (req, res) => {
    try {
        const { userId } = req.body;
        const l = db.prepare("SELECT * FROM listings WHERE id = ? AND status = 'active'").get(req.params.id);
        if (!l) return res.status(404).json({ error: 'Нет' });
        if (l.seller_id !== Number(userId)) return res.status(403).json({ error: 'Нет доступа' });
        const u = getUser(userId);
        if (!u || u.ton_balance < PRICE_LOCK_PRICE) return res.status(400).json({ error: `Нужно ${PRICE_LOCK_PRICE} TON` });
        const trx = db.transaction(() => { db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(PRICE_LOCK_PRICE, userId); payOwner(PRICE_LOCK_PRICE, 'TON'); addTx(userId, 'fee', 'TON', -PRICE_LOCK_PRICE, { reason: 'lock_price' }); db.prepare('UPDATE listings SET price_locked_until = ? WHERE id = ?').run(Date.now() + 7*24*3600*1000, l.id); });
        trx();
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/listings/:id/search-boost', (req, res) => {
    try {
        const { userId } = req.body;
        const l = db.prepare("SELECT * FROM listings WHERE id = ? AND status = 'active'").get(req.params.id);
        if (!l) return res.status(404).json({ error: 'Нет' });
        if (l.seller_id !== Number(userId)) return res.status(403).json({ error: 'Нет доступа' });
        const u = getUser(userId);
        if (!u || u.ton_balance < SEARCH_BOOST_PRICE) return res.status(400).json({ error: `Нужно ${SEARCH_BOOST_PRICE} TON` });
        const trx = db.transaction(() => { db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(SEARCH_BOOST_PRICE, userId); payOwner(SEARCH_BOOST_PRICE, 'TON'); addTx(userId, 'fee', 'TON', -SEARCH_BOOST_PRICE, { reason: 'search_boost' }); db.prepare('UPDATE listings SET search_boost_until = ? WHERE id = ?').run(Date.now() + 7*24*3600*1000, l.id); });
        trx();
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});

// ===== ПОКУПКА =====
app.post('/api/listings/:id/buy', (req, res) => {
    try {
        const { buyerId, instant } = req.body;
        const l = db.prepare("SELECT * FROM listings WHERE id = ? AND status = 'active'").get(req.params.id);
        if (!l) return res.status(404).json({ error: 'Нет лота' });
        if (l.seller_id === Number(buyerId)) return res.status(400).json({ error: 'Свой лот' });
        if (isBanned(buyerId)) return res.status(403).json({ error: 'Забанен' });
        const buyer = getUser(buyerId);
        const bf = l.currency === 'TON' ? 'ton_balance' : 'stars_balance';
        const feePct = instant ? (FEE_SALE + INSTANT_BUY_FEE) : FEE_SALE;
        const buyerPays = instant ? +(l.price * (1 + INSTANT_BUY_FEE/100)).toFixed(6) : l.price;
        if (!buyer || buyer[bf] < buyerPays) return res.status(400).json({ error: 'Мало ' + l.currency });
        const trx = db.transaction(() => {
            db.prepare(`UPDATE users SET ${bf} = ${bf} - ? WHERE id = ?`).run(buyerPays, buyerId);
            recordSale(l.seller_id, buyerId, l, l.price, l.currency, 'listing', feePct);
            db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)').run(buyerId, l.nft_slug, l.nft_name, l.nft_emoji);
            db.prepare("UPDATE listings SET status = 'sold' WHERE id = ?").run(l.id);
            addTx(buyerId, 'purchase', l.currency, -buyerPays, { nft: l.nft_name });
        });
        trx();
        notify(l.seller_id, '💰 Продажа', `${l.nft_name} за ${l.price} ${l.currency}`);
        notify(buyerId, '✅ Покупка', l.nft_name);
        logAction(buyerId, 'buy', `${l.nft_name} ${l.price} ${l.currency}`, ip(req));
        res.json({ success: true });
    } catch(e) { console.error('buy', e); res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/listings/:id/guarantee', (req, res) => {
    try {
        const { buyerId } = req.body;
        const l = db.prepare("SELECT * FROM listings WHERE id = ? AND status = 'active'").get(req.params.id);
        if (!l) return res.status(404).json({ error: 'Нет' });
        if (l.seller_id === Number(buyerId)) return res.status(400).json({ error: 'Свой' });
        if (isBanned(buyerId)) return res.status(403).json({ error: 'Забанен' });
        const fee = +(l.price * GUARANTEE_FEE / 100).toFixed(6);
        const total = +(l.price + fee).toFixed(6);
        const buyer = getUser(buyerId);
        const bf = l.currency === 'TON' ? 'ton_balance' : 'stars_balance';
        if (!buyer || buyer[bf] < total) return res.status(400).json({ error: 'Мало ' + l.currency });
        const trx = db.transaction(() => {
            db.prepare(`UPDATE users SET ${bf} = ${bf} - ? WHERE id = ?`).run(total, buyerId);
            db.prepare('INSERT INTO guarantees (listing_id, buyer_id, seller_id, price, currency, fee) VALUES (?,?,?,?,?,?)').run(l.id, buyerId, l.seller_id, l.price, l.currency, fee);
            addTx(buyerId, 'guarantee_hold', l.currency, -total, { nft: l.nft_name });
        });
        trx();
        const admins = db.prepare("SELECT id FROM users WHERE role IN ('super','moder')").all();
        admins.forEach(a => notify(a.id, '🛡 Гарант-запрос', `${l.nft_name} за ${l.price} + ${fee} комиссия`));
        res.json({ success: true, fee });
    } catch(e) { console.error('guarantee', e); res.status(500).json({ error: 'Ошибка' }); }
});

// ===== ОФФЕРЫ =====
app.post('/api/offers', offerLimiter, (req, res) => {
    try {
        const { listingId, buyerId, currency, fast } = req.body;
        const price = num(req.body.price, 0.000001, 1e9);
        if (!price) return res.status(400).json({ error: 'Цена' });
        const l = db.prepare("SELECT * FROM listings WHERE id = ? AND status = 'active'").get(listingId);
        if (!l) return res.status(404).json({ error: 'Нет' });
        if (l.seller_id === Number(buyerId)) return res.status(400).json({ error: 'Свой лот' });
        if (isBanned(buyerId)) return res.status(403).json({ error: 'Забанен' });
        const cur = currency || 'TON';
        if (!validCurrency(cur)) return res.status(400).json({ error: 'Валюта' });
        const buyer = getUser(buyerId);
        const bf = cur === 'TON' ? 'ton_balance' : 'stars_balance';
        const extra = fast ? FAST_OFFER_PRICE : 0;
        const totalNeed = price + (cur === 'TON' ? extra : 0);
        if (!buyer || buyer[bf] < totalNeed) return res.status(400).json({ error: 'Мало ' + cur });
        const trx = db.transaction(() => {
            if (fast && cur === 'TON') { db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(FAST_OFFER_PRICE, buyerId); payOwner(FAST_OFFER_PRICE, 'TON'); addTx(buyerId, 'fee', 'TON', -FAST_OFFER_PRICE, { reason: 'fast_offer' }); }
            db.prepare('INSERT INTO offers (listing_id, buyer_id, price, currency, fast_delivery) VALUES (?,?,?,?,?)').run(listingId, buyerId, price, cur, fast ? 1 : 0);
        });
        trx();
        notify(l.seller_id, fast ? '⚡ Быстрый оффер' : '📩 Оффер', `${l.nft_name} за ${price} ${cur}`);
        res.json({ success: true });
    } catch(e) { console.error('offer', e); res.status(500).json({ error: 'Ошибка' }); }
});
app.get('/api/offers/incoming/:userId', (req, res) => { res.json(db.prepare(`SELECT o.*, u.username as buyer_name, l.nft_name, l.nft_emoji FROM offers o JOIN listings l ON o.listing_id = l.id JOIN users u ON o.buyer_id = u.id WHERE l.seller_id = ? AND o.status = 'pending' AND l.status = 'active' ORDER BY o.fast_delivery DESC, o.id DESC`).all(req.params.userId)); });
app.post('/api/offers/:id/accept', (req, res) => {
    try {
        const { sellerId } = req.body;
        const o = db.prepare("SELECT * FROM offers WHERE id = ? AND status = 'pending'").get(req.params.id);
        if (!o) return res.status(404).json({ error: 'Нет' });
        const l = db.prepare("SELECT * FROM listings WHERE id = ? AND status = 'active'").get(o.listing_id);
        if (!l || l.seller_id !== sellerId) return res.status(403).json({ error: 'Нет доступа' });
        const buyer = getUser(o.buyer_id);
        const bf = o.currency === 'TON' ? 'ton_balance' : 'stars_balance';
        if (!buyer || buyer[bf] < o.price) return res.status(400).json({ error: 'Мало ' + o.currency });
        const trx = db.transaction(() => {
            db.prepare(`UPDATE users SET ${bf} = ${bf} - ? WHERE id = ?`).run(o.price, o.buyer_id);
            recordSale(sellerId, o.buyer_id, l, o.price, o.currency, 'offer');
            db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)').run(o.buyer_id, l.nft_slug, l.nft_name, l.nft_emoji);
            db.prepare("UPDATE listings SET status = 'sold' WHERE id = ?").run(l.id);
            db.prepare("UPDATE offers SET status = 'accepted' WHERE id = ?").run(o.id);
            db.prepare("UPDATE offers SET status = 'rejected' WHERE listing_id = ? AND id != ?").run(l.id, o.id);
            addTx(o.buyer_id, 'purchase', o.currency, -o.price, { nft: l.nft_name, via: 'offer' });
        });
        trx();
        notify(sellerId, '✅ Оффер принят', l.nft_name);
        notify(o.buyer_id, '✅ Оффер принят', l.nft_name);
        res.json({ success: true });
    } catch(e) { console.error('offer_accept', e); res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/offers/:id/reject', (req, res) => {
    try {
        const { sellerId } = req.body;
        const o = db.prepare("SELECT * FROM offers WHERE id = ? AND status = 'pending'").get(req.params.id);
        if (!o) return res.status(404).json({ error: 'Нет' });
        const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(o.listing_id);
        if (!l || l.seller_id !== sellerId) return res.status(403).json({ error: 'Нет доступа' });
        db.prepare("UPDATE offers SET status = 'rejected' WHERE id = ?").run(req.params.id);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/offers/:id/cancel', (req, res) => {
    try {
        const { buyerId } = req.body;
        const o = db.prepare("SELECT * FROM offers WHERE id = ? AND status = 'pending'").get(req.params.id);
        if (!o) return res.status(404).json({ error: 'Нет' });
        if (o.buyer_id !== Number(buyerId)) return res.status(403).json({ error: 'Нет доступа' });
        const u = getUser(buyerId);
        if (!u || u.ton_balance < CANCEL_OFFER_FEE) return res.status(400).json({ error: `Нужно ${CANCEL_OFFER_FEE} TON` });
        const trx = db.transaction(() => { db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(CANCEL_OFFER_FEE, buyerId); payOwner(CANCEL_OFFER_FEE, 'TON'); addTx(buyerId, 'fee', 'TON', -CANCEL_OFFER_FEE, { reason: 'cancel_offer' }); db.prepare("UPDATE offers SET status = 'cancelled' WHERE id = ?").run(o.id); });
        trx();
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});

// ===== АУКЦИОНЫ =====
function settleExpiredAuctions() {
    const now = Date.now();
    const expired = db.prepare("SELECT * FROM auctions WHERE end_time < ? AND status = 'active'").all(now);
    for (const a of expired) {
        try {
            const hold = db.prepare('SELECT * FROM auction_holds WHERE auction_id = ?').get(a.id);
            const reserveOk = !a.reserve_price || (a.current_bid >= a.reserve_price);
            if (a.current_bidder_id && hold && reserveOk) {
                const buyer = getUser(a.current_bidder_id);
                const bf = hold.currency === 'TON' ? 'ton_balance' : 'stars_balance';
                if (buyer && buyer[bf] >= hold.amount) {
                    const trx = db.transaction(() => { db.prepare(`UPDATE users SET ${bf} = ${bf} - ? WHERE id = ?`).run(hold.amount, a.current_bidder_id); recordSale(a.seller_id, a.current_bidder_id, a, hold.amount, hold.currency, 'auction'); db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)').run(a.current_bidder_id, a.nft_slug, a.nft_name, a.nft_emoji); db.prepare("UPDATE auctions SET status = 'sold' WHERE id = ?").run(a.id); db.prepare('DELETE FROM auction_holds WHERE auction_id = ?').run(a.id); addTx(a.current_bidder_id, 'purchase', hold.currency, -hold.amount, { nft: a.nft_name, via: 'auction' }); });
                    trx();
                    notify(a.seller_id, '⏳ Аукцион продан', a.nft_name);
                    notify(a.current_bidder_id, '🏆 Победа', a.nft_name);
                } else {
                    if (hold) { const oldBf = hold.currency === 'TON' ? 'ton_balance' : 'stars_balance'; db.prepare(`UPDATE users SET ${oldBf} = ${oldBf} + ? WHERE id = ?`).run(hold.amount, hold.user_id); db.prepare('DELETE FROM auction_holds WHERE auction_id = ?').run(a.id); addTx(hold.user_id, 'refund', hold.currency, hold.amount, { reason: 'auction_failed' }); }
                    db.prepare("UPDATE auctions SET status = 'ended' WHERE id = ?").run(a.id);
                    db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)').run(a.seller_id, a.nft_slug, a.nft_name, a.nft_emoji);
                }
            } else {
                if (hold) { const oldBf = hold.currency === 'TON' ? 'ton_balance' : 'stars_balance'; db.prepare(`UPDATE users SET ${oldBf} = ${oldBf} + ? WHERE id = ?`).run(hold.amount, hold.user_id); db.prepare('DELETE FROM auction_holds WHERE auction_id = ?').run(a.id); addTx(hold.user_id, 'refund', hold.currency, hold.amount, { reason: 'auction_reserve_not_met' }); }
                db.prepare("UPDATE auctions SET status = 'ended' WHERE id = ?").run(a.id);
                db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)').run(a.seller_id, a.nft_slug, a.nft_name, a.nft_emoji);
                notify(a.seller_id, '⚠️ Аукцион не состоялся', a.nft_name);
            }
        } catch(e) { console.error('settle auction', a.id, e); }
    }
}
setInterval(settleExpiredAuctions, 30 * 1000);

app.get('/api/auctions', (req, res) => { res.json(db.prepare(`SELECT a.*, u.username as seller_name, (SELECT COUNT(*) FROM bids WHERE auction_id = a.id) as bids_count FROM auctions a JOIN users u ON a.seller_id = u.id WHERE a.status = 'active' ORDER BY a.end_time ASC`).all()); });
app.post('/api/auctions', (req, res) => {
    try {
        const { userId, nft_slug, nft_name, nft_emoji, currency, reserve, urgent } = req.body;
        const start_price = num(req.body.start_price, 0.000001, 1e9);
        const hours = num(req.body.hours, 0.01, 720);
        if (!start_price || !hours) return res.status(400).json({ error: 'Параметры' });
        if (isBanned(userId)) return res.status(403).json({ error: 'Забанен' });
        const item = db.prepare('SELECT * FROM inventory WHERE user_id = ? AND nft_slug = ?').get(userId, nft_slug);
        if (!item) return res.status(400).json({ error: 'NFT не найден' });
        let extra = 0; let reserve_price = 0;
        if (reserve) { extra += RESERVE_AUCTION_PRICE; reserve_price = start_price; }
        if (urgent) { extra += URGENT_AUCTION_PRICE; }
        const u = getUser(userId);
        if (extra > 0 && (!u || u.ton_balance < extra)) return res.status(400).json({ error: `Нужно ${extra} TON` });
        const finalHours = urgent ? 1 : hours;
        const endTime = Date.now() + finalHours * 3600 * 1000;
        const trx = db.transaction(() => {
            if (extra > 0) { db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(extra, userId); payOwner(extra, 'TON'); addTx(userId, 'fee', 'TON', -extra, { reason: 'auction_extra' }); }
            db.prepare('INSERT INTO auctions (seller_id, nft_slug, nft_name, nft_emoji, start_price, reserve_price, current_bid, end_time, currency, is_urgent) VALUES (?,?,?,?,?,?,?,?,?,?)').run(userId, nft_slug, nft_name, nft_emoji, start_price, reserve_price, start_price, endTime, currency || 'TON', urgent ? 1 : 0);
            db.prepare('DELETE FROM inventory WHERE id = ?').run(item.id);
        });
        trx();
        logAction(userId, 'auction_start', `${nft_name} ${start_price} ${currency}`, ip(req));
        res.json({ success: true });
    } catch(e) { console.error('auction_create', e); res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/auctions/:id/extend', (req, res) => {
    try {
        const { userId } = req.body;
        const a = db.prepare("SELECT * FROM auctions WHERE id = ? AND status = 'active'").get(req.params.id);
        if (!a) return res.status(404).json({ error: 'Нет' });
        if (a.seller_id !== Number(userId)) return res.status(403).json({ error: 'Нет доступа' });
        const u = getUser(userId);
        if (!u || u.ton_balance < EXTEND_AUCTION_PRICE) return res.status(400).json({ error: `Нужно ${EXTEND_AUCTION_PRICE} TON` });
        const trx = db.transaction(() => { db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(EXTEND_AUCTION_PRICE, userId); payOwner(EXTEND_AUCTION_PRICE, 'TON'); addTx(userId, 'fee', 'TON', -EXTEND_AUCTION_PRICE, { reason: 'extend_auction' }); db.prepare('UPDATE auctions SET end_time = end_time + ? WHERE id = ?').run(3600*1000, a.id); });
        trx();
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/auctions/:id/bid', (req, res) => {
    try {
        const { bidderId, fast } = req.body;
        const amount = num(req.body.amount, 0.000001, 1e9);
        if (!amount) return res.status(400).json({ error: 'Сумма' });
        const a = db.prepare("SELECT * FROM auctions WHERE id = ? AND status = 'active'").get(req.params.id);
        if (!a) return res.status(404).json({ error: 'Нет' });
        if (Date.now() > a.end_time) return res.status(400).json({ error: 'Завершён' });
        if (a.seller_id === Number(bidderId)) return res.status(400).json({ error: 'Свой' });
        if (isBanned(bidderId)) return res.status(403).json({ error: 'Забанен' });
        const minStep = a.current_bid * 1.05;
        if (amount < minStep) return res.status(400).json({ error: `Мин. ${minStep.toFixed(2)} ${a.currency}` });
        const bidder = getUser(bidderId);
        const bf = a.currency === 'TON' ? 'ton_balance' : 'stars_balance';
        const prevHold = db.prepare('SELECT * FROM auction_holds WHERE auction_id = ? AND user_id = ?').get(a.id, bidderId);
        const available = bidder[bf] + (prevHold ? prevHold.amount : 0);
        const fastFee = fast ? FAST_BID_PRICE : 0;
        if (available < amount + fastFee) return res.status(400).json({ error: 'Мало ' + a.currency });
        const trx = db.transaction(() => {
            const oldHold = db.prepare('SELECT * FROM auction_holds WHERE auction_id = ?').get(a.id);
            if (oldHold) { db.prepare('DELETE FROM auction_holds WHERE auction_id = ?').run(a.id); const oldBf = oldHold.currency === 'TON' ? 'ton_balance' : 'stars_balance'; db.prepare(`UPDATE users SET ${oldBf} = ${oldBf} + ? WHERE id = ?`).run(oldHold.amount, oldHold.user_id); addTx(oldHold.user_id, 'refund', oldHold.currency, oldHold.amount, { reason: 'outbid' }); }
            db.prepare(`UPDATE users SET ${bf} = ${bf} - ? WHERE id = ?`).run(amount, bidderId);
            if (fastFee > 0) { db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(fastFee, bidderId); payOwner(fastFee, 'TON'); addTx(bidderId, 'fee', 'TON', -fastFee, { reason: 'fast_bid' }); }
            db.prepare('INSERT INTO auction_holds (auction_id, user_id, amount, currency) VALUES (?,?,?,?)').run(a.id, bidderId, amount, a.currency);
            db.prepare('UPDATE auctions SET current_bid = ?, current_bidder_id = ? WHERE id = ?').run(amount, bidderId, a.id);
            db.prepare('INSERT INTO bids (auction_id, bidder_id, amount) VALUES (?,?,?)').run(a.id, bidderId, amount);
            if (a.end_time - Date.now() < 5 * 60 * 1000) { db.prepare('UPDATE auctions SET end_time = end_time + ? WHERE id = ?').run(5*60*1000, a.id); }
        });
        trx();
        notify(a.seller_id, '💸 Новая ставка', `${a.nft_name} — ${amount} ${a.currency}`);
        res.json({ success: true });
    } catch(e) { console.error('bid', e); res.status(500).json({ error: 'Ошибка' }); }
});
app.get('/api/auctions/:id/bids', (req, res) => { res.json(db.prepare(`SELECT b.*, u.username as bidder_name FROM bids b JOIN users u ON b.bidder_id = u.id WHERE b.auction_id = ? ORDER BY b.id DESC LIMIT 20`).all(req.params.id)); });

// ===== ВЫВОД NFT (списание сразу + комиссия 10% от оценки) =====
app.post('/api/withdraw/nft', (req, res) => {
    try {
        const { userId, slug, name, emoji, target } = req.body;
        if (!validTarget(target, 'NFT')) return res.status(400).json({ error: 'Укажите @username' });
        if (isBanned(userId)) return res.status(403).json({ error: 'Забанен' });
        const item = db.prepare('SELECT * FROM inventory WHERE user_id = ? AND nft_slug = ?').get(userId, slug);
        if (!item) return res.status(400).json({ error: 'NFT не найден' });
        // Комиссия 10% от оценки (используем среднюю оценку из evaluations или дефолт)
        const evalRow = db.prepare('SELECT result FROM evaluations WHERE user_id = ? AND nft_slug = ? ORDER BY id DESC LIMIT 1').get(userId, slug);
        let estimated = 0;
        if (evalRow) { const m = evalRow.result.match(/([\d.]+)/); if (m) estimated = parseFloat(m[1]); }
        const fee = +(estimated * FEE_WITHDRAW_NFT / 100).toFixed(6);
        const u = getUser(userId);
        if (fee > 0 && (!u || u.ton_balance < fee)) return res.status(400).json({ error: `Нужно ${fee} TON комиссии` });
        let newId;
        const trx = db.transaction(() => {
            db.prepare('DELETE FROM inventory WHERE id = ?').run(item.id);
            if (fee > 0) { db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(fee, userId); payOwner(fee, 'TON'); addTx(userId, 'fee', 'TON', -fee, { reason: 'withdraw_nft' }); }
            const info = db.prepare('INSERT INTO withdrawals (user_id, type, nft_slug, nft_name, nft_emoji, target, fee) VALUES (?,?,?,?,?,?,?)').run(userId, 'NFT', slug, name, emoji, target, fee);
            return info.lastInsertRowid;
        });
        newId = trx();
        db.prepare("SELECT id FROM users WHERE role IN ('super','moder')").all().forEach(a => notify(a.id, '📤 Вывод NFT', `${getUser(userId).username}: ${name} → ${target}`));
        logAction(userId, 'withdraw_nft', `${name} → ${target} (fee ${fee})`, ip(req));
        res.json({ success: true, id: newId, fee });
    } catch(e) { console.error('wd_nft', e); res.status(500).json({ error: 'Ошибка' }); }
});

// ===== ВЫВОД TON/STARS (списание сразу) =====
app.post('/api/withdraw/funds', (req, res) => {
    try {
        const { userId, currency, target, urgent } = req.body;
        const net = num(req.body.amount, 0.000001, 1e9);
        if (!net) return res.status(400).json({ error: 'Сумма' });
        if (!validTarget(target, currency)) return res.status(400).json({ error: 'Реквизиты' });
        if (!validCurrency(currency)) return res.status(400).json({ error: 'Валюта' });
        if (isBanned(userId)) return res.status(403).json({ error: 'Забанен' });
        const u = getUser(userId);
        const bf = currency === 'TON' ? 'ton_balance' : 'stars_balance';
        let feePct = urgent ? FEE_WITHDRAW_URGENT : FEE_WITHDRAW_NORMAL;
        if (net >= MASS_WITHDRAW_THRESHOLD) feePct = MASS_WITHDRAW_FEE;
        const fee = +(net * feePct / 100).toFixed(6);
        const total = +(net + fee).toFixed(6);
        if (u[bf] < total) return res.status(400).json({ error: 'Мало ' + currency + ' (с комиссией ' + feePct + '%)' });
        let newId;
        const trx = db.transaction(() => {
            db.prepare(`UPDATE users SET ${bf} = ${bf} - ? WHERE id = ?`).run(total, userId);
            payOwner(fee, currency);
            addTx(userId, 'withdraw_hold', currency, -total, { net, fee, urgent: !!urgent });
            const info = db.prepare('INSERT INTO withdrawals (user_id, type, amount, amount_net, fee, currency, target, urgent) VALUES (?,?,?,?,?,?,?,?)').run(userId, 'FUNDS', total, net, fee, currency, target, urgent ? 1 : 0);
            return info.lastInsertRowid;
        });
        newId = trx();
        db.prepare("SELECT id FROM users WHERE role IN ('super','moder')").all().forEach(a => notify(a.id, '📤 Заявка на вывод', `${u.username}: ${net} ${currency} (fee ${fee}) → ${target}`));
        logAction(userId, 'withdraw_funds', `${net} ${currency} → ${target}`, ip(req));
        res.json({ success: true, id: newId, net, fee, total, feePct });
    } catch(e) { console.error('wd_funds', e); res.status(500).json({ error: 'Ошибка' }); }
});

// ===== РУЛЕТКА =====
app.post('/api/roulette/spin', (req, res) => {
    try {
        const { userId } = req.body;
        if (isBanned(userId)) return res.status(403).json({ error: 'Забанен' });
        const u = getUser(userId);
        if (!u || u.ton_balance < ROULETTE_COST) return res.status(400).json({ error: `Нужно ${ROULETTE_COST} TON` });
        const isOwner = u.role === 'super';
        const roll = Math.random() * 100;
        let prize;
        if (isOwner) prize = roll < 90 ? 20 : (roll < 95 ? 5 : (roll < 99 ? 3 : 1));
        else prize = roll < 60 ? 1 : (roll < 90 ? 3 : (roll < 99 ? 5 : 20));
        const trx = db.transaction(() => {
            db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(ROULETTE_COST, userId);
            db.prepare('UPDATE users SET ton_balance = ton_balance + ? WHERE id = ?').run(prize, userId);
            const ownerCut = ROULETTE_COST - prize;
            if (ownerCut > 0) payOwner(ownerCut, 'TON');
            addTx(userId, 'roulette', 'TON', prize - ROULETTE_COST, { cost: ROULETTE_COST, prize });
            db.prepare('INSERT INTO roulette_spins (user_id, cost, prize, pool) VALUES (?,?,?,?)').run(userId, ROULETTE_COST, prize, isOwner ? 'owner' : 'public');
        });
        trx();
        res.json({ success: true, prize });
    } catch(e) { console.error('spin', e); res.status(500).json({ error: 'Ошибка' }); }
});
app.get('/api/roulette/history/:userId', (req, res) => { res.json(db.prepare('SELECT * FROM roulette_spins WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(req.params.userId)); });

// ===== ВЕРИФИКАЦИЯ / ПРИМЕРКА / ОЦЕНКА =====
app.post('/api/verify', (req, res) => {
    try {
        const { userId } = req.body;
        if (isBanned(userId)) return res.status(403).json({ error: 'Забанен' });
        const u = getUser(userId);
        if (!u) return res.status(404).json({ error: 'Нет' });
        if (u.is_verified) return res.status(400).json({ error: 'Уже верифицирован' });
        if (u.ton_balance < VERIFY_PRICE) return res.status(400).json({ error: `Нужно ${VERIFY_PRICE} TON` });
        const trx = db.transaction(() => { db.prepare('UPDATE users SET ton_balance = ton_balance - ?, is_verified = 1 WHERE id = ?').run(VERIFY_PRICE, userId); payOwner(VERIFY_PRICE, 'TON'); addTx(userId, 'fee', 'TON', -VERIFY_PRICE, { reason: 'verify' }); db.prepare('INSERT OR IGNORE INTO verifications (user_id, paid) VALUES (?,?)').run(userId, VERIFY_PRICE); });
        trx();
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/nft/trial', (req, res) => {
    try {
        const { userId, slug, name, emoji } = req.body;
        const u = getUser(userId);
        if (!u || u.ton_balance < NFT_TRIAL_PRICE) return res.status(400).json({ error: `Нужно ${NFT_TRIAL_PRICE} TON` });
        const trx = db.transaction(() => { db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(NFT_TRIAL_PRICE, userId); payOwner(NFT_TRIAL_PRICE, 'TON'); addTx(userId, 'fee', 'TON', -NFT_TRIAL_PRICE, { reason: 'trial' }); db.prepare('INSERT INTO nft_trials (user_id, nft_slug, nft_name, nft_emoji, expires_at) VALUES (?,?,?,?,?)').run(userId, slug, name, emoji, Date.now() + 24*3600*1000); });
        trx();
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
app.get('/api/nft/trials/:userId', (req, res) => { res.json(db.prepare('SELECT * FROM nft_trials WHERE user_id = ? AND expires_at > ?').all(req.params.userId, Date.now())); });
app.post('/api/nft/evaluate', (req, res) => {
    try {
        const { userId, slug, name } = req.body;
        const u = getUser(userId);
        if (!u || u.ton_balance < EVALUATION_PRICE) return res.status(400).json({ error: `Нужно ${EVALUATION_PRICE} TON` });
        const result = (Math.random() * 50 + 5).toFixed(2) + ' TON';
        const trx = db.transaction(() => { db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(EVALUATION_PRICE, userId); payOwner(EVALUATION_PRICE, 'TON'); addTx(userId, 'fee', 'TON', -EVALUATION_PRICE, { reason: 'evaluate' }); db.prepare('INSERT INTO evaluations (user_id, nft_slug, nft_name, result) VALUES (?,?,?,?)').run(userId, slug, name, result); });
        trx();
        res.json({ success: true, result });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});

// ===== ПАКЕТЫ =====
app.post('/api/bundles', (req, res) => {
    try {
        const { userId, items, currency } = req.body;
        const price = num(req.body.price, 0.000001, 1e9);
        if (!price) return res.status(400).json({ error: 'Цена' });
        if (!Array.isArray(items) || items.length < 3) return res.status(400).json({ error: 'Мин. 3 NFT' });
        if (isBanned(userId)) return res.status(403).json({ error: 'Забанен' });
        const owned = db.prepare(`SELECT * FROM inventory WHERE user_id = ? AND nft_slug IN (${items.map(()=>'?').join(',')})`).all(userId, ...items);
        if (owned.length !== items.length) return res.status(400).json({ error: 'Не все NFT найдены' });
        let bundleId;
        const trx = db.transaction(() => { const info = db.prepare('INSERT INTO bundles (seller_id, price, currency) VALUES (?,?,?)').run(userId, price, currency || 'TON'); bundleId = info.lastInsertRowid; for (const it of owned) { db.prepare('INSERT INTO listings (seller_id, nft_slug, nft_name, nft_emoji, price, currency, bundle_id) VALUES (?,?,?,?,?,?,?)').run(userId, it.nft_slug, it.nft_name, it.nft_emoji, +(price/items.length).toFixed(6), currency || 'TON', bundleId); db.prepare('DELETE FROM inventory WHERE id = ?').run(it.id); } });
        trx();
        res.json({ success: true, bundleId });
    } catch(e) { console.error('bundle', e); res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/bundles/:id/buy', (req, res) => {
    try {
        const { buyerId } = req.body;
        const b = db.prepare("SELECT * FROM bundles WHERE id = ? AND status = 'active'").get(req.params.id);
        if (!b) return res.status(404).json({ error: 'Нет' });
        if (b.seller_id === Number(buyerId)) return res.status(400).json({ error: 'Свой' });
        const buyer = getUser(buyerId);
        const bf = b.currency === 'TON' ? 'ton_balance' : 'stars_balance';
        if (!buyer || buyer[bf] < b.price) return res.status(400).json({ error: 'Мало ' + b.currency });
        const listings = db.prepare("SELECT * FROM listings WHERE bundle_id = ? AND status = 'active'").all(b.id);
        const trx = db.transaction(() => { db.prepare(`UPDATE users SET ${bf} = ${bf} - ? WHERE id = ?`).run(b.price, buyerId); recordSale(b.seller_id, buyerId, { nft_slug: 'bundle', nft_name: 'Пакет #'+b.id, nft_emoji: '📦' }, b.price, b.currency, 'bundle', BUNDLE_FEE); for (const l of listings) { db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)').run(buyerId, l.nft_slug, l.nft_name, l.nft_emoji); db.prepare("UPDATE listings SET status = 'sold' WHERE id = ?").run(l.id); } db.prepare("UPDATE bundles SET status = 'sold' WHERE id = ?").run(b.id); addTx(buyerId, 'purchase', b.currency, -b.price, { bundle: b.id }); });
        trx();
        notify(b.seller_id, '📦 Пакет продан', 'Пакет #'+b.id);
        res.json({ success: true });
    } catch(e) { console.error('bundle_buy', e); res.status(500).json({ error: 'Ошибка' }); }
});

// ===== НАСЛЕДИЕ / ЭКСКЛЮЗИВ =====
app.post('/api/heir', (req, res) => {
    try {
        const { userId, heirId } = req.body;
        const u = getUser(userId);
        if (!u || u.ton_balance < HEIR_PRICE) return res.status(400).json({ error: `Нужно ${HEIR_PRICE} TON` });
        if (!getUser(heirId)) return res.status(400).json({ error: 'Наследник не найден' });
        const trx = db.transaction(() => { db.prepare('UPDATE users SET ton_balance = ton_balance - ?, heir_id = ? WHERE id = ?').run(HEIR_PRICE, heirId, userId); payOwner(HEIR_PRICE, 'TON'); addTx(userId, 'fee', 'TON', -HEIR_PRICE, { reason: 'heir' }); });
        trx();
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/listings/:id/exclusive', (req, res) => {
    try {
        const { userId } = req.body;
        const l = db.prepare("SELECT * FROM listings WHERE id = ? AND status = 'active'").get(req.params.id);
        if (!l) return res.status(404).json({ error: 'Нет' });
        if (l.seller_id !== Number(userId)) return res.status(403).json({ error: 'Нет доступа' });
        db.prepare('UPDATE listings SET is_exclusive = 1 WHERE id = ?').run(l.id);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});

// ===== ОТЗЫВЫ =====
app.post('/api/reviews', (req, res) => {
    try {
        const { sellerId, buyerId, rating, text } = req.body;
        const r = num(rating, 1, 5);
        if (!r) return res.status(400).json({ error: 'Оценка 1-5' });
        if (sellerId === Number(buyerId)) return res.status(400).json({ error: 'Себя нельзя' });
        const bought = db.prepare('SELECT id FROM sales_history WHERE seller_id = ? AND buyer_id = ?').get(sellerId, buyerId);
        if (!bought) return res.status(400).json({ error: 'Сначала купите у продавца' });
        db.prepare('INSERT INTO reviews (seller_id, buyer_id, rating, text) VALUES (?,?,?,?)').run(sellerId, buyerId, r, text || null);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
app.get('/api/reviews/:sellerId', (req, res) => {
    res.json(db.prepare('SELECT r.*, u.username as buyer_name FROM reviews r JOIN users u ON r.buyer_id = u.id WHERE r.seller_id = ? ORDER BY r.id DESC LIMIT 50').all(req.params.sellerId));
});

// ===== ПРОМОКОДЫ =====
app.post('/api/promo/redeem', (req, res) => {
    try {
        const { userId, code } = req.body;
        const p = db.prepare('SELECT * FROM promocodes WHERE code = ?').get(code);
        if (!p) return res.status(404).json({ error: 'Промокод не найден' });
        if (p.used >= p.max_uses) return res.status(400).json({ error: 'Промокод использован' });
        if (p.expires_at && Date.now() > p.expires_at) return res.status(400).json({ error: 'Промокод истёк' });
        const used = db.prepare('SELECT id FROM promo_uses WHERE promo_id = ? AND user_id = ?').get(p.id, userId);
        if (used) return res.status(400).json({ error: 'Уже использован' });
        const bf = p.currency === 'TON' ? 'ton_balance' : 'stars_balance';
        const trx = db.transaction(() => {
            db.prepare(`UPDATE users SET ${bf} = ${bf} + ? WHERE id = ?`).run(p.amount, userId);
            db.prepare('UPDATE promocodes SET used = used + 1 WHERE id = ?').run(p.id);
            db.prepare('INSERT INTO promo_uses (promo_id, user_id) VALUES (?,?)').run(p.id, userId);
            addTx(userId, 'promo', p.currency, p.amount, { code });
        });
        trx();
        res.json({ success: true, amount: p.amount, currency: p.currency });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/admin/promo', (req, res) => {
    try {
        const { adminId, code, currency, amount, max_uses, expires_hours } = req.body;
        if (!isAdmin(adminId)) return res.status(403).json({ error: 'Нет доступа' });
        if (!code || !validCurrency(currency)) return res.status(400).json({ error: 'Параметры' });
        const a = num(amount, 0.000001, 1e9);
        if (!a) return res.status(400).json({ error: 'Сумма' });
        const expires = expires_hours ? Date.now() + expires_hours * 3600 * 1000 : null;
        db.prepare('INSERT INTO promocodes (code, currency, amount, max_uses, expires_at, created_by) VALUES (?,?,?,?,?,?)').run(code, currency, a, max_uses || 1, expires, adminId);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
app.get('/api/admin/promo', (req, res) => {
    if (!isAdmin(req.query.adminId)) return res.status(403).json({ error: 'Нет доступа' });
    res.json(db.prepare('SELECT * FROM promocodes ORDER BY id DESC').all());
});

// ===== ТОП / ИСТОРИЯ / УВЕДОМЛЕНИЯ =====
app.get('/api/top-sellers', (req, res) => { res.json(db.prepare(`SELECT u.username, COUNT(s.id) as sold, COALESCE(SUM(s.price),0) as total FROM users u LEFT JOIN sales_history s ON s.seller_id = u.id GROUP BY u.id HAVING sold > 0 ORDER BY sold DESC LIMIT 10`).all()); });
app.get('/api/history/sales/:userId', (req, res) => { res.json(db.prepare(`SELECT s.*, su.username as seller_name, bu.username as buyer_name FROM sales_history s LEFT JOIN users su ON s.seller_id = su.id LEFT JOIN users bu ON s.buyer_id = bu.id WHERE s.seller_id = ? OR s.buyer_id = ? ORDER BY s.id DESC LIMIT 50`).all(req.params.userId, req.params.userId)); });
app.get('/api/notifications/:userId', (req, res) => { res.json(db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(req.params.userId)); });
app.post('/api/notifications/read', (req, res) => { db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.body.userId); res.json({ success: true }); });

// ===== АДМИН =====
app.get('/api/admin/users', (req, res) => { if (!isAdmin(req.query.adminId)) return res.status(403).json({ error: 'Нет доступа' }); res.json(db.prepare('SELECT id, username, ton_balance, stars_balance, role, is_banned, is_verified FROM users').all()); });
app.get('/api/admin/stats', (req, res) => {
    if (!isAdmin(req.query.adminId)) return res.status(403).json({ error: 'Нет доступа' });
    const users = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const listings = db.prepare("SELECT COUNT(*) as c FROM listings WHERE status = 'active'").get().c;
    const auctions = db.prepare("SELECT COUNT(*) as c FROM auctions WHERE status = 'active'").get().c;
    const sales = db.prepare('SELECT COUNT(*) as c, COALESCE(SUM(price),0) as vol FROM sales_history').get();
    const salesTon = db.prepare("SELECT COALESCE(SUM(price),0) as v FROM sales_history WHERE currency='TON'").get().v;
    const salesStars = db.prepare("SELECT COALESCE(SUM(price),0) as v FROM sales_history WHERE currency='STARS'").get().v;
    const pendingWithdrawals = db.prepare("SELECT COUNT(*) as c FROM withdrawals WHERE status='pending'").get().c;
    const fees = db.prepare("SELECT COALESCE(SUM(fee),0) as v FROM sales_history").get().v;
    res.json({ users, listings, auctions, sales: sales.c, volume: sales.vol, salesTon, salesStars, pendingWithdrawals, fees });
});
app.get('/api/admin/logs', (req, res) => { if (!isAdmin(req.query.adminId)) return res.status(403).json({ error: 'Нет доступа' }); res.json(db.prepare(`SELECT l.*, u.username FROM logs l LEFT JOIN users u ON l.user_id = u.id ORDER BY l.id DESC LIMIT 200`).all()); });
app.get('/api/admin/listings', (req, res) => { if (!isAdmin(req.query.adminId)) return res.status(403).json({ error: 'Нет доступа' }); res.json(db.prepare(`SELECT l.*, u.username as seller_name FROM listings l JOIN users u ON l.seller_id = u.id WHERE l.status = 'active' ORDER BY l.id DESC`).all()); });
app.get('/api/admin/auctions', (req, res) => { if (!isAdmin(req.query.adminId)) return res.status(403).json({ error: 'Нет доступа' }); res.json(db.prepare(`SELECT a.*, u.username as seller_name FROM auctions a JOIN users u ON a.seller_id = u.id WHERE a.status = 'active' ORDER BY a.id DESC`).all()); });
app.get('/api/admin/withdrawals', (req, res) => { if (!isAdmin(req.query.adminId)) return res.status(403).json({ error: 'Нет доступа' }); res.json(db.prepare(`SELECT w.*, u.username FROM withdrawals w JOIN users u ON w.user_id = u.id WHERE w.status = 'pending' ORDER BY w.urgent DESC, w.id DESC`).all()); });
app.post('/api/admin/withdrawals/:id/approve', (req, res) => {
    try {
        const { adminId } = req.body;
        if (!isAdmin(adminId)) return res.status(403).json({ error: 'Нет доступа' });
        const w = db.prepare("SELECT * FROM withdrawals WHERE id = ? AND status = 'pending'").get(req.params.id);
        if (!w) return res.status(404).json({ error: 'Нет' });
        db.prepare("UPDATE withdrawals SET status = 'approved' WHERE id = ?").run(w.id);
        notify(w.user_id, '✅ Вывод одобрен', w.type === 'NFT' ? `${w.nft_name} → ${w.target}` : `${w.amount_net ?? w.amount} ${w.currency} → ${w.target}`);
        logAction(adminId, 'withdraw_approve', `#${w.id}`, ip(req));
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/admin/withdrawals/:id/reject', (req, res) => {
    try {
        const { adminId } = req.body;
        if (!isAdmin(adminId)) return res.status(403).json({ error: 'Нет доступа' });
        const w = db.prepare("SELECT * FROM withdrawals WHERE id = ? AND status = 'pending'").get(req.params.id);
        if (!w) return res.status(404).json({ error: 'Нет' });
        const trx = db.transaction(() => {
            db.prepare("UPDATE withdrawals SET status = 'rejected' WHERE id = ?").run(w.id);
            if (w.type === 'NFT') {
                db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)').run(w.user_id, w.nft_slug, w.nft_name, w.nft_emoji);
                if (w.fee && w.fee > 0) { db.prepare('UPDATE users SET ton_balance = ton_balance + ? WHERE id = ?').run(w.fee, w.user_id); addTx(w.user_id, 'refund', 'TON', w.fee, { reason: 'nft_withdraw_rejected' }); }
            } else {
                const bf = w.currency === 'TON' ? 'ton_balance' : 'stars_balance';
                db.prepare(`UPDATE users SET ${bf} = ${bf} + ? WHERE id = ?`).run(w.amount, w.user_id);
                addTx(w.user_id, 'refund', w.currency, w.amount, { reason: 'withdraw_rejected' });
            }
        });
        trx();
        notify(w.user_id, '❌ Вывод отклонён', w.type === 'NFT' ? w.nft_name : `${w.amount_net ?? w.amount} ${w.currency}`);
        res.json({ success: true });
    } catch(e) { console.error('wd_reject', e); res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/admin/role', (req, res) => {
    try {
        const { adminId, userId, role } = req.body;
        if (!isSuper(adminId)) return res.status(403).json({ error: 'Только super' });
        if (userId === adminId) return res.status(400).json({ error: 'Себя нельзя' });
        if (!['user','moder','super'].includes(role)) return res.status(400).json({ error: 'Роль' });
        const target = getUser(userId);
        if (target?.role === 'super') return res.status(400).json({ error: 'Нельзя менять super' });
        db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId);
        logAction(adminId, 'set_role', `user ${userId} → ${role}`, ip(req));
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/admin/ban', (req, res) => {
    try {
        const { adminId, userId, ban } = req.body;
        if (!isAdmin(adminId)) return res.status(403).json({ error: 'Нет доступа' });
        if (userId === adminId) return res.status(400).json({ error: 'Себя нельзя' });
        const target = getUser(userId);
        if (target?.role === 'super') return res.status(400).json({ error: 'Нельзя банить super' });
        if (!isSuper(adminId) && target?.role === 'moder') return res.status(403).json({ error: 'Нельзя банить модератора' });
        db.prepare('UPDATE users SET is_banned = ? WHERE id = ?').run(ban ? 1 : 0, userId);
        logAction(adminId, ban ? 'ban' : 'unban', `user ${userId}`, ip(req));
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/admin/balance', (req, res) => {
    try {
        const { adminId, userId, currency } = req.body;
        const amount = num(req.body.amount, -1e9, 1e9);
        if (!isAdmin(adminId)) return res.status(403).json({ error: 'Нет доступа' });
        if (!validCurrency(currency) || amount === null) return res.status(400).json({ error: 'Параметры' });
        const field = currency === 'STARS' ? 'stars_balance' : 'ton_balance';
        db.prepare(`UPDATE users SET ${field} = ${field} + ? WHERE id = ?`).run(amount, userId);
        addTx(userId, 'admin_adjust', currency, amount, { admin: adminId });
        logAction(adminId, 'add_balance', `user ${userId} ${amount} ${currency}`, ip(req));
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/admin/give-nft', (req, res) => {
    try {
        const { adminId, userId, slug, name, emoji } = req.body;
        if (!isAdmin(adminId)) return res.status(403).json({ error: 'Нет доступа' });
        db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)').run(userId, slug, name, emoji);
        logAction(adminId, 'give_nft', `user ${userId}`, ip(req));
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/admin/give-nft-mass', (req, res) => {
    try {
        const { adminId, userId, items } = req.body;
        if (!isAdmin(adminId)) return res.status(403).json({ error: 'Нет доступа' });
        if (!Array.isArray(items)) return res.status(400).json({ error: 'items' });
        const trx = db.transaction(() => { for (const it of items) db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)').run(userId, it.slug, it.name, it.emoji); });
        trx();
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
app.delete('/api/admin/auctions/:id', (req, res) => {
    try {
        if (!isSuper(req.query.adminId)) return res.status(403).json({ error: 'Только super' });
        const a = db.prepare('SELECT * FROM auctions WHERE id = ?').get(req.params.id);
        if (!a) return res.status(404).json({ error: 'Нет' });
        const trx = db.transaction(() => {
            const hold = db.prepare('SELECT * FROM auction_holds WHERE auction_id = ?').get(a.id);
            if (hold) { const oldBf = hold.currency === 'TON' ? 'ton_balance' : 'stars_balance'; db.prepare(`UPDATE users SET ${oldBf} = ${oldBf} + ? WHERE id = ?`).run(hold.amount, hold.user_id); db.prepare('DELETE FROM auction_holds WHERE auction_id = ?').run(a.id); addTx(hold.user_id, 'refund', hold.currency, hold.amount, { reason: 'admin_cancel' }); }
            db.prepare("UPDATE auctions SET status = 'cancelled' WHERE id = ?").run(a.id);
            db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)').run(a.seller_id, a.nft_slug, a.nft_name, a.nft_emoji);
        });
        trx();
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
app.delete('/api/admin/users/:id', (req, res) => {
    try {
        if (!isSuper(req.query.adminId)) return res.status(403).json({ error: 'Только super' });
        const u = getUser(req.params.id);
        if (!u || u.role === 'super') return res.status(400).json({ error: 'Нельзя' });
        db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/admin/reset-password', (req, res) => {
    const { adminId, userId, newPassword } = req.body;
    if (!isSuper(adminId)) return res.status(403).json({ error: 'Только super' });
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Пароль мин. 6' });
    bcrypt.hash(newPassword, SALT_ROUNDS).then(hash => { db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId); res.json({ success: true }); }).catch(e => { console.error('reset', e); res.status(500).json({ error: 'Ошибка' }); });
});
app.get('/api/admin/roulette/spins', (req, res) => { if (!isAdmin(req.query.adminId)) return res.status(403).json({ error: 'Нет доступа' }); res.json(db.prepare(`SELECT r.*, u.username FROM roulette_spins r LEFT JOIN users u ON r.user_id = u.id ORDER BY r.id DESC LIMIT 200`).all()); });
app.post('/api/admin/roulette/give', (req, res) => {
    try {
        const { adminId, userId, amount } = req.body;
        if (!isAdmin(adminId)) return res.status(403).json({ error: 'Нет доступа' });
        const a = num(amount, 0.000001, 1e9);
        if (!a) return res.status(400).json({ error: 'Сумма' });
        db.prepare('UPDATE users SET ton_balance = ton_balance + ? WHERE id = ?').run(a, userId);
        notify(userId, '🎁 Бонус от админа', `+${a} TON`);
        logAction(adminId, 'roulette_give', `user ${userId} +${a} TON`, ip(req));
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
app.get('/api/admin/finance', (req, res) => {
    if (!isAdmin(req.query.adminId)) return res.status(403).json({ error: 'Нет доступа' });
    const totalTon = db.prepare('SELECT COALESCE(SUM(ton_balance),0) as v FROM users').get().v;
    const totalStars = db.prepare('SELECT COALESCE(SUM(stars_balance),0) as v FROM users').get().v;
    const ownerRow = db.prepare('SELECT ton_balance, stars_balance FROM users WHERE username = ?').get(SUPER_ADMIN);
    const salesFeesTon = db.prepare("SELECT COALESCE(SUM(fee),0) as v FROM sales_history WHERE fee_currency='TON'").get().v;
    const salesFeesStars = db.prepare("SELECT COALESCE(SUM(fee),0) as v FROM sales_history WHERE fee_currency='STARS'").get().v;
    const withdrawFeesTon = db.prepare("SELECT COALESCE(SUM(fee),0) as v FROM withdrawals WHERE currency='TON' AND status='approved'").get().v;
    const withdrawFeesStars = db.prepare("SELECT COALESCE(SUM(fee),0) as v FROM withdrawals WHERE currency='STARS' AND status='approved'").get().v;
    const rouletteProfit = db.prepare("SELECT COALESCE(SUM(cost - prize),0) as v FROM roulette_spins").get().v;
    res.json({ totalTon, totalStars, ownerTon: ownerRow?.ton_balance || 0, ownerStars: ownerRow?.stars_balance || 0, salesFeesTon, salesFeesStars, withdrawFeesTon, withdrawFeesStars, rouletteProfit });
});
app.get('/api/admin/rich-users', (req, res) => { if (!isAdmin(req.query.adminId)) return res.status(403).json({ error: 'Нет доступа' }); res.json(db.prepare('SELECT id, username, ton_balance, stars_balance, role FROM users ORDER BY ton_balance DESC LIMIT 20').all()); });
app.get('/api/admin/chart/registrations', (req, res) => { if (!isAdmin(req.query.adminId)) return res.status(403).json({ error: 'Нет доступа' }); res.json(db.prepare(`SELECT DATE(created_at) as day, COUNT(*) as count FROM users GROUP BY DATE(created_at) ORDER BY day DESC LIMIT 30`).all()); });
app.get('/api/admin/chart/sales', (req, res) => { if (!isAdmin(req.query.adminId)) return res.status(403).json({ error: 'Нет доступа' }); res.json(db.prepare(`SELECT DATE(created_at) as day, COUNT(*) as count, COALESCE(SUM(price),0) as volume FROM sales_history GROUP BY DATE(created_at) ORDER BY day DESC LIMIT 30`).all()); });
app.get('/api/admin/user-inventory/:userId', (req, res) => { if (!isAdmin(req.query.adminId)) return res.status(403).json({ error: 'Нет доступа' }); res.json(db.prepare('SELECT * FROM inventory WHERE user_id = ?').all(req.params.userId)); });
app.get('/api/admin/user-sales/:userId', (req, res) => { if (!isAdmin(req.query.adminId)) return res.status(403).json({ error: 'Нет доступа' }); res.json(db.prepare(`SELECT s.*, su.username as seller_name, bu.username as buyer_name FROM sales_history s LEFT JOIN users su ON s.seller_id = su.id LEFT JOIN users bu ON s.buyer_id = bu.id WHERE s.seller_id = ? OR s.buyer_id = ? ORDER BY s.id DESC LIMIT 100`).all(req.params.userId, req.params.userId)); });
app.post('/api/admin/verify', (req, res) => {
    try {
        const { adminId, userId, verify } = req.body;
        if (!isAdmin(adminId)) return res.status(403).json({ error: 'Нет доступа' });
        db.prepare('UPDATE users SET is_verified = ? WHERE id = ?').run(verify ? 1 : 0, userId);
        logAction(adminId, verify ? 'verify' : 'unverify', `user ${userId}`, ip(req));
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
app.get('/api/admin/guarantees', (req, res) => { if (!isAdmin(req.query.adminId)) return res.status(403).json({ error: 'Нет доступа' }); res.json(db.prepare(`SELECT g.*, bu.username as buyer_name, su.username as seller_name, l.nft_name, l.nft_emoji FROM guarantees g LEFT JOIN users bu ON g.buyer_id = bu.id LEFT JOIN users su ON g.seller_id = su.id LEFT JOIN listings l ON g.listing_id = l.id WHERE g.status = 'pending' ORDER BY g.id DESC`).all()); });
app.post('/api/admin/guarantees/:id/complete', (req, res) => {
    try {
        const { adminId } = req.body;
        if (!isAdmin(adminId)) return res.status(403).json({ error: 'Нет доступа' });
        const g = db.prepare("SELECT * FROM guarantees WHERE id = ? AND status = 'pending'").get(req.params.id);
        if (!g) return res.status(404).json({ error: 'Нет' });
        const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(g.listing_id);
        if (!l) return res.status(404).json({ error: 'Лот пропал' });
        const trx = db.transaction(() => {
            recordSale(g.seller_id, g.buyer_id, l, g.price, g.currency, 'guarantee');
            db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)').run(g.buyer_id, l.nft_slug, l.nft_name, l.nft_emoji);
            db.prepare("UPDATE listings SET status = 'sold' WHERE id = ?").run(l.id);
            db.prepare("UPDATE guarantees SET status = 'completed' WHERE id = ?").run(g.id);
            payOwner(g.fee, g.currency);
        });
        trx();
        notify(g.buyer_id, '🛡 Гарант: сделка завершена', l.nft_name);
        notify(g.seller_id, '🛡 Гарант: сделка завершена', l.nft_name);
        logAction(adminId, 'guarantee_complete', `#${g.id}`, ip(req));
        res.json({ success: true });
    } catch(e) { console.error('guarantee_complete', e); res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/admin/guarantees/:id/cancel', (req, res) => {
    try {
        const { adminId } = req.body;
        if (!isAdmin(adminId)) return res.status(403).json({ error: 'Нет доступа' });
        const g = db.prepare("SELECT * FROM guarantees WHERE id = ? AND status = 'pending'").get(req.params.id);
        if (!g) return res.status(404).json({ error: 'Нет' });
        const bf = g.currency === 'TON' ? 'ton_balance' : 'stars_balance';
        const trx = db.transaction(() => { db.prepare(`UPDATE users SET ${bf} = ${bf} + ? WHERE id = ?`).run(g.price + g.fee, g.buyer_id); db.prepare("UPDATE guarantees SET status = 'cancelled' WHERE id = ?").run(g.id); addTx(g.buyer_id, 'refund', g.currency, g.price + g.fee, { reason: 'guarantee_cancelled' }); });
        trx();
        notify(g.buyer_id, '❌ Гарант отменён', `Возврат ${g.price + g.fee} ${g.currency}`);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/admin/broadcast', (req, res) => {
    try {
        const { adminId, title, text } = req.body;
        if (!isAdmin(adminId)) return res.status(403).json({ error: 'Нет доступа' });
        if (!title || !text) return res.status(400).json({ error: 'Заполните' });
        const users = db.prepare('SELECT id FROM users').all();
        const trx = db.transaction(() => { for (const u of users) db.prepare('INSERT INTO notifications (user_id, title, text) VALUES (?,?,?)').run(u.id, title, text); });
        trx();
        logAction(adminId, 'broadcast', title, ip(req));
        res.json({ success: true, sent: users.length });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/admin/mass-balance', (req, res) => {
    try {
        const { adminId, amount, currency } = req.body;
        const a = num(amount, -1e9, 1e9);
        if (!isAdmin(adminId)) return res.status(403).json({ error: 'Нет доступа' });
        if (!validCurrency(currency) || a === null) return res.status(400).json({ error: 'Параметры' });
        const field = currency === 'STARS' ? 'stars_balance' : 'ton_balance';
        db.prepare(`UPDATE users SET ${field} = ${field} + ?`).run(a);
        logAction(adminId, 'mass_balance', `${a} ${currency} всем`, ip(req));
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/admin/mass-give-nft', (req, res) => {
    try {
        const { adminId, slug, name, emoji } = req.body;
        if (!isAdmin(adminId)) return res.status(403).json({ error: 'Нет доступа' });
        const users = db.prepare('SELECT id FROM users').all();
        const trx = db.transaction(() => { for (const u of users) db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)').run(u.id, slug, name, emoji); });
        trx();
        logAction(adminId, 'mass_give_nft', name, ip(req));
        res.json({ success: true, sent: users.length });
    } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});

// ===== SSE real-time уведомления =====
const sseClients = new Map();
app.get('/api/notifications/stream/:userId', (req, res) => {
    const userId = Number(req.params.userId);
    if (!userId) return res.status(400).end();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = (data) => { try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch(e) {} };
    send({ type: 'hello' });
    if (!sseClients.has(userId)) sseClients.set(userId, new Set());
    sseClients.get(userId).add(send);
    const interval = setInterval(() => { try { res.write(':ping\n\n'); } catch(e) {} }, 25000);
    req.on('close', () => { clearInterval(interval); const set = sseClients.get(userId); if (set) { set.delete(send); if (!set.size) sseClients.delete(userId); } });
});
const origNotify = notify;
function notifySse(userId, title, text) {
    try { const set = sseClients.get(Number(userId)); if (set) set.forEach(fn => fn({ type: 'notification', title, text, at: Date.now() })); } catch(e) {}
}
// переопределяем notify, чтобы дублировать в SSE
notify = function(uid, title, text) { origNotify(uid, title, text); notifySse(uid, title, text); };

// ===== CRON-задачи =====
setInterval(() => {
    try {
        // 1. Просроченные офферы (>48ч) → rejected
        db.prepare("UPDATE offers SET status = 'expired' WHERE status = 'pending' AND created_at < datetime('now', '-48 hours')").run();
        // 2. Просроченные примерки → удалить
        db.prepare('DELETE FROM nft_trials WHERE expires_at < ?').run(Date.now());
        // 3. Зависшие заявки на вывод (>3 дней) → rejected + возврат
        const stuck = db.prepare("SELECT * FROM withdrawals WHERE status = 'pending' AND created_at < datetime('now', '-3 days')").all();
        for (const w of stuck) {
            const trx = db.transaction(() => {
                db.prepare("UPDATE withdrawals SET status = 'rejected' WHERE id = ?").run(w.id);
                if (w.type === 'NFT') db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)').run(w.user_id, w.nft_slug, w.nft_name, w.nft_emoji);
                else { const bf = w.currency === 'TON' ? 'ton_balance' : 'stars_balance'; db.prepare(`UPDATE users SET ${bf} = ${bf} + ? WHERE id = ?`).run(w.amount, w.user_id); }
            });
            try { trx(); notify(w.user_id, '⏰ Заявка на вывод истекла', 'Автоматический возврат'); } catch(e) { console.error(e); }
        }
    } catch(e) { console.error('cron', e); }
}, 10 * 60 * 1000);

// ===== ПУБЛИЧНОЕ API =====
app.get('/api/public/listings', (req, res) => {
    const limit = Math.min(num(req.query.limit, 1, 100) || 50, 100);
    res.json(db.prepare("SELECT id, nft_slug, nft_name, nft_emoji, price, currency, created_at FROM listings WHERE status = 'active' AND is_private = 0 ORDER BY id DESC LIMIT ?").all(limit));
});
app.get('/api/public/stats', (req, res) => {
    const users = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const listings = db.prepare("SELECT COUNT(*) as c FROM listings WHERE status = 'active'").get().c;
    const sales = db.prepare('SELECT COUNT(*) as c FROM sales_history').get().c;
    res.json({ users, listings, sales });
});

// ===== СТАРТ =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Сервер на порту ' + PORT));
process.on('SIGTERM', () => { console.log('SIGTERM, выход...'); process.exit(0); });
process.on('SIGINT', () => { console.log('SIGINT, выход...'); process.exit(0); });
