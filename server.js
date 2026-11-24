const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./db');

const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());

const SUPER_ADMIN = 'tagen';
const SALT_ROUNDS = 12;
const SELL_TON_TO_STARS = 200;
const BUY_TON_FOR_STARS = 2500;
const EXCHANGE_FEE_PCT = 2;

// === 30 МЕХАНИК ===
const FEE_SALE = 10;            // 1,2,3
const FEE_WITHDRAW_NORMAL = 10; // 4
const FEE_WITHDRAW_URGENT = 15; // 5
const FEE_WITHDRAW_NFT = 10;    // 6
const BOOST_PRICE = 1;          // 7
const ROULETTE_COST = 10;       // 8
const MASS_WITHDRAW_THRESHOLD = 100; // 20
const MASS_WITHDRAW_FEE = 12;
const INSTANT_BUY_FEE = 2;      // 16
const FAST_BID_PRICE = 0.3;     // 17
const GUARANTEE_FEE = 3;        // 18
const PRIVATE_LISTING_PRICE = 0.5; // 19
const NFT_TRIAL_PRICE = 0.1;    // 21
const URGENT_SALE_FEE = 12;     // 22
const EVALUATION_PRICE = 0.2;   // 23
const RESERVE_AUCTION_PRICE = 1; // 24
const SEARCH_BOOST_PRICE = 0.5; // 25
const FAST_OFFER_PRICE = 0.1;   // 26
const PRICE_LOCK_PRICE = 0.5;   // 27
const BUNDLE_FEE = 5;           // 28
const HEIR_PRICE = 10;          // 29
const EXCLUSIVE_FEE = 20;       // 30
const VERIFY_PRICE = 50;        // 15
const CANCEL_LISTING_FEE = 0.5; // 11
const EXTEND_AUCTION_PRICE = 0.5; // 12
const URGENT_AUCTION_PRICE = 2; // 13
const CANCEL_OFFER_FEE = 0.2;   // 14

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

function num(v, min = 0, max = 1e9) { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : null; }
function logAction(uid, action, details) { try { const u = db.prepare('SELECT role FROM users WHERE id = ?').get(uid); db.prepare('INSERT INTO logs (user_id, role, action, details) VALUES (?,?,?,?)').run(uid, u?.role || 'user', action, details); } catch(e) { console.error(e); } }
function notify(uid, title, text) { try { db.prepare('INSERT INTO notifications (user_id, title, text) VALUES (?,?,?)').run(uid, title, text); } catch(e) { console.error(e); } }
function getUser(id) { return db.prepare('SELECT * FROM users WHERE id = ?').get(id); }
function isAdmin(id) { const u = getUser(id); return u && (u.role === 'super' || u.role === 'moder') && !u.is_banned; }
function isSuper(id) { const u = getUser(id); return u && u.role === 'super' && !u.is_banned; }
function isBanned(id) { const u = getUser(id); return !u || u.is_banned; }
function validCurrency(c) { return c === 'TON' || c === 'STARS'; }
function owner() { return db.prepare('SELECT id FROM users WHERE username = ?').get(SUPER_ADMIN); }

// Вся комиссия капает SUPER_ADMIN
function payOwner(amount, currency) {
    if (!amount || amount <= 0) return;
    const o = owner(); if (!o) return;
    const bf = currency === 'TON' ? 'ton_balance' : 'stars_balance';
    db.prepare(`UPDATE users SET ${bf} = ${bf} + ? WHERE id = ?`).run(+amount.toFixed(6), o.id);
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

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ===== РЕГИСТРАЦИЯ / ЛОГИН =====
app.post('/api/register', authLimiter, async (req, res) => {
    const { username, password, ref } = req.body;
    if (!username || !password || password.length < 6) return res.status(400).json({ error: 'Ник и пароль (мин. 6)' });
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return res.status(400).json({ error: 'Ник занят' });
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const role = username === SUPER_ADMIN ? 'super' : 'user';
    const info = db.prepare('INSERT INTO users (username, password_hash, role, ref_by) VALUES (?,?,?,?)').run(username, hash, role, ref || null);
    const user = getUser(info.lastInsertRowid);
    if (ref && ref !== user.id) {
        const r = getUser(ref);
        if (r) { db.prepare('UPDATE users SET ton_balance = ton_balance + 5 WHERE id = ?').run(ref); db.prepare('UPDATE users SET ton_balance = ton_balance + 5 WHERE id = ?').run(user.id); notify(ref, '🤝 Реферал', `${username} пришёл. +5 TON`); }
    }
    logAction(user.id, 'register', 'Новый аккаунт');
    res.json({ id: user.id, username: user.username, ton_balance: user.ton_balance, stars_balance: user.stars_balance, role: user.role, is_verified: user.is_verified });
});
app.post('/api/login', authLimiter, async (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !user.password_hash) return res.status(401).json({ error: 'Неверный ник или пароль' });
    if (!(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: 'Неверный ник или пароль' });
    if (user.is_banned) return res.status(403).json({ error: 'Вы забанены' });
    logAction(user.id, 'login', 'Вход');
    res.json({ id: user.id, username: user.username, ton_balance: user.ton_balance, stars_balance: user.stars_balance, role: user.role, is_verified: user.is_verified });
});
app.get('/api/user/:id', (req, res) => {
    const u = getUser(req.params.id);
    if (!u) return res.status(404).json({ error: 'Нет' });
    res.json({ id: u.id, username: u.username, ton_balance: u.ton_balance, stars_balance: u.stars_balance, role: u.role, is_banned: u.is_banned, is_verified: u.is_verified, heir_id: u.heir_id });
});

// ===== ОБМЕН (9,10) =====
app.post('/api/exchange', (req, res) => {
    const { userId, from } = req.body;
    const amount = num(req.body.amount, 0.000001, 1e9);
    if (!amount) return res.status(400).json({ error: 'Сумма' });
    if (!validCurrency(from)) return res.status(400).json({ error: 'Валюта' });
    if (isBanned(userId)) return res.status(403).json({ error: 'Забанен' });
    const u = getUser(userId); if (!u) return res.status(400).json({ error: 'Нет' });
    if (from === 'TON') {
        if (u.ton_balance < amount) return res.status(400).json({ error: 'Мало TON' });
        const gross = amount * SELL_TON_TO_STARS;
        const feeStars = gross * EXCHANGE_FEE_PCT / 100;
        const net = Math.floor(gross - feeStars);
        db.prepare('UPDATE users SET ton_balance = ton_balance - ?, stars_balance = stars_balance + ? WHERE id = ?').run(amount, net, userId);
        payOwner(feeStars, 'STARS');
        logAction(userId, 'exchange', `${amount} TON → ${net} ⭐ (fee ${feeStars.toFixed(2)})`);
    } else {
        if (u.stars_balance < amount) return res.status(400).json({ error: 'Мало Stars' });
        const gross = amount / BUY_TON_FOR_STARS;
        const feeTon = gross * EXCHANGE_FEE_PCT / 100;
        const net = gross - feeTon;
        db.prepare('UPDATE users SET stars_balance = stars_balance - ?, ton_balance = ton_balance + ? WHERE id = ?').run(amount, net, userId);
        payOwner(feeTon, 'TON');
        logAction(userId, 'exchange', `${amount} ⭐ → ${net.toFixed(4)} TON (fee ${feeTon.toFixed(6)})`);
    }
    res.json({ success: true });
});

// ===== ИНВЕНТАРЬ / ИЗБРАННОЕ =====
app.get('/api/inventory/:userId', (req, res) => res.json(db.prepare('SELECT * FROM inventory WHERE user_id = ?').all(req.params.userId)));
app.get('/api/favorites/:userId', (req, res) => res.json(db.prepare('SELECT nft_slug FROM favorites WHERE user_id = ?').all(req.params.userId).map(f=>f.nft_slug)));
app.post('/api/favorites', (req, res) => {
    const { userId, slug } = req.body;
    const ex = db.prepare('SELECT id FROM favorites WHERE user_id = ? AND nft_slug = ?').get(userId, slug);
    if (ex) db.prepare('DELETE FROM favorites WHERE id = ?').run(ex.id);
    else db.prepare('INSERT INTO favorites (user_id, nft_slug) VALUES (?,?)').run(userId, slug);
    res.json({ success: true });
});

// ===== ЛОТЫ =====
app.get('/api/listings', (req, res) => {
    const now = Date.now();
    res.json(db.prepare(`SELECT l.*, u.username as seller_name, u.is_verified as seller_verified FROM listings l JOIN users u ON l.seller_id = u.id WHERE l.status = 'active' AND l.is_private = 0 ORDER BY l.boosted_until DESC, l.id DESC`).all().map(l=>({...l, boosted_until: l.boosted_until||0, search_boost_until: l.search_boost_until||0})));
});
app.post('/api/listings', (req, res) => {
    const { userId, nft_slug, nft_name, nft_emoji, currency } = req.body;
    const price = num(req.body.price, 0.000001, 1e9);
    if (!price) return res.status(400).json({ error: 'Цена > 0' });
    if (isBanned(userId)) return res.status(403).json({ error: 'Забанен' });
    const item = db.prepare('SELECT * FROM inventory WHERE user_id = ? AND nft_slug = ?').get(userId, nft_slug);
    if (!item) return res.status(400).json({ error: 'NFT не найден' });
    const already = db.prepare("SELECT id FROM listings WHERE seller_id = ? AND nft_slug = ? AND status = 'active'").get(userId, nft_slug);
    if (already) return res.status(400).json({ error: 'Уже выставлен' });
    db.prepare('INSERT INTO listings (seller_id, nft_slug, nft_name, nft_emoji, price, currency) VALUES (?,?,?,?,?,?)').run(userId, nft_slug, nft_name, nft_emoji, price, currency || 'TON');
    db.prepare('DELETE FROM inventory WHERE id = ?').run(item.id);
    logAction(userId, 'listing', `${nft_name} за ${price} ${currency}`);
    res.json({ success: true });
});
// 11. Досрочное снятие — 0.5 TON
app.delete('/api/listings/:id', (req, res) => {
    const { userId } = req.query;
    const l = db.prepare("SELECT * FROM listings WHERE id = ? AND status = 'active'").get(req.params.id);
    if (!l) return res.status(404).json({ error: 'Нет' });
    if (l.seller_id !== Number(userId) && !isAdmin(userId)) return res.status(403).json({ error: 'Нет доступа' });
    const u = getUser(userId);
    if (u && u.ton_balance < CANCEL_LISTING_FEE && !isAdmin(userId)) return res.status(400).json({ error: `Нужно ${CANCEL_LISTING_FEE} TON для снятия` });
    const trx = db.transaction(() => {
        if (!isAdmin(userId)) { db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(CANCEL_LISTING_FEE, userId); payOwner(CANCEL_LISTING_FEE, 'TON'); }
        db.prepare("UPDATE listings SET status = 'cancelled' WHERE id = ?").run(req.params.id);
        db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)').run(l.seller_id, l.nft_slug, l.nft_name, l.nft_emoji);
    });
    try { trx(); logAction(userId, 'cancel_listing', l.nft_name); res.json({ success: true, fee: isAdmin(userId)?0:CANCEL_LISTING_FEE }); }
    catch(e) { console.error(e); res.status(500).json({ error: 'Ошибка' }); }
});
// 7. Продвижение в топ — 1 TON
app.post('/api/listings/:id/boost', (req, res) => {
    const { userId } = req.body;
    const l = db.prepare("SELECT * FROM listings WHERE id = ? AND status = 'active'").get(req.params.id);
    if (!l) return res.status(404).json({ error: 'Нет' });
    if (l.seller_id !== Number(userId) && !isAdmin(userId)) return res.status(403).json({ error: 'Нет доступа' });
    const u = getUser(userId);
    if (!isAdmin(userId) && (!u || u.ton_balance < BOOST_PRICE)) return res.status(400).json({ error: `Нужно ${BOOST_PRICE} TON` });
    const trx = db.transaction(() => {
        if (!isAdmin(userId)) { db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(BOOST_PRICE, userId); payOwner(BOOST_PRICE, 'TON'); }
        db.prepare('UPDATE listings SET boosted_until = ? WHERE id = ?').run(Date.now() + 24*3600*1000, l.id);
    });
    try { trx(); logAction(userId, 'boost_listing', l.nft_name); res.json({ success: true }); }
    catch(e) { console.error(e); res.status(500).json({ error: 'Ошибка' }); }
});
// 19. Приватный лот — 0.5 TON
app.post('/api/listings/:id/private', (req, res) => {
    const { userId } = req.body;
    const l = db.prepare("SELECT * FROM listings WHERE id = ? AND status = 'active'").get(req.params.id);
    if (!l) return res.status(404).json({ error: 'Нет' });
    if (l.seller_id !== Number(userId) && !isAdmin(userId)) return res.status(403).json({ error: 'Нет доступа' });
    const u = getUser(userId);
    if (!isAdmin(userId) && (!u || u.ton_balance < PRIVATE_LISTING_PRICE)) return res.status(400).json({ error: `Нужно ${PRIVATE_LISTING_PRICE} TON` });
    const trx = db.transaction(() => {
        if (!isAdmin(userId)) { db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(PRIVATE_LISTING_PRICE, userId); payOwner(PRIVATE_LISTING_PRICE, 'TON'); }
        db.prepare('UPDATE listings SET is_private = 1 WHERE id = ?').run(l.id);
    });
    try { trx(); res.json({ success: true }); } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
// 27. Заморозка цены — 0.5 TON
app.post('/api/listings/:id/lock-price', (req, res) => {
    const { userId } = req.body;
    const l = db.prepare("SELECT * FROM listings WHERE id = ? AND status = 'active'").get(req.params.id);
    if (!l) return res.status(404).json({ error: 'Нет' });
    if (l.seller_id !== Number(userId)) return res.status(403).json({ error: 'Нет доступа' });
    const u = getUser(userId);
    if (!u || u.ton_balance < PRICE_LOCK_PRICE) return res.status(400).json({ error: `Нужно ${PRICE_LOCK_PRICE} TON` });
    const trx = db.transaction(() => {
        db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(PRICE_LOCK_PRICE, userId);
        payOwner(PRICE_LOCK_PRICE, 'TON');
        db.prepare('UPDATE listings SET price_locked_until = ? WHERE id = ?').run(Date.now() + 7*24*3600*1000, l.id);
    });
    try { trx(); res.json({ success: true }); } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
// 25. Продвижение в поиске — 0.5 TON
app.post('/api/listings/:id/search-boost', (req, res) => {
    const { userId } = req.body;
    const l = db.prepare("SELECT * FROM listings WHERE id = ? AND status = 'active'").get(req.params.id);
    if (!l) return res.status(404).json({ error: 'Нет' });
    if (l.seller_id !== Number(userId)) return res.status(403).json({ error: 'Нет доступа' });
    const u = getUser(userId);
    if (!u || u.ton_balance < SEARCH_BOOST_PRICE) return res.status(400).json({ error: `Нужно ${SEARCH_BOOST_PRICE} TON` });
    const trx = db.transaction(() => {
        db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(SEARCH_BOOST_PRICE, userId);
        payOwner(SEARCH_BOOST_PRICE, 'TON');
        db.prepare('UPDATE listings SET search_boost_until = ? WHERE id = ?').run(Date.now() + 7*24*3600*1000, l.id);
    });
    try { trx(); res.json({ success: true }); } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});

// ===== ПОКУПКА (1, 16) =====
app.post('/api/listings/:id/buy', (req, res) => {
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
    });
    try { trx(); notify(l.seller_id, '💰 Продажа', `${l.nft_name} за ${l.price} ${l.currency}`); notify(buyerId, '✅ Покупка', l.nft_name); res.json({ success: true }); }
    catch(e) { console.error(e); res.status(500).json({ error: 'Ошибка' }); }
});

// 18. Гарант — 3%
app.post('/api/listings/:id/guarantee', (req, res) => {
    const { buyerId } = req.body;
    const l = db.prepare("SELECT * FROM listings WHERE id = ? AND status = 'active'").get(req.params.id);
    if (!l) return res.status(404).json({ error: 'Нет' });
    if (l.seller_id === Number(buyerId)) return res.status(400).json({ error: 'Свой' });
    const fee = +(l.price * GUARANTEE_FEE / 100).toFixed(6);
    db.prepare('INSERT INTO guarantees (listing_id, buyer_id, seller_id, price, currency, fee) VALUES (?,?,?,?,?,?)').run(l.id, buyerId, l.seller_id, l.price, l.currency, fee);
    const admins = db.prepare("SELECT id FROM users WHERE role IN ('super','moder')").all();
    admins.forEach(a => notify(a.id, '🛡 Гарант-запрос', `${l.nft_name} за ${l.price}`));
    res.json({ success: true, fee });
});

// ===== ОФФЕРЫ (2, 26, 14) =====
app.post('/api/offers', (req, res) => {
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
        if (fast && cur === 'TON') { db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(FAST_OFFER_PRICE, buyerId); payOwner(FAST_OFFER_PRICE, 'TON'); }
        db.prepare('INSERT INTO offers (listing_id, buyer_id, price, currency, fast_delivery) VALUES (?,?,?,?,?)').run(listingId, buyerId, price, cur, fast ? 1 : 0);
    });
    try { trx(); notify(l.seller_id, fast ? '⚡ Быстрый оффер' : '📩 Оффер', `${l.nft_name} за ${price} ${cur}`); res.json({ success: true }); }
    catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
app.get('/api/offers/incoming/:userId', (req, res) => {
    res.json(db.prepare(`SELECT o.*, u.username as buyer_name, l.nft_name, l.nft_emoji FROM offers o JOIN listings l ON o.listing_id = l.id JOIN users u ON o.buyer_id = u.id WHERE l.seller_id = ? AND o.status = 'pending' AND l.status = 'active' ORDER BY o.fast_delivery DESC, o.id DESC`).all(req.params.userId));
});
app.post('/api/offers/:id/accept', (req, res) => {
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
    });
    try { trx(); notify(sellerId, '✅ Оффер принят', l.nft_name); notify(o.buyer_id, '✅ Оффер принят', l.nft_name); res.json({ success: true }); }
    catch(e) { console.error(e); res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/offers/:id/reject', (req, res) => {
    const { sellerId } = req.body;
    const o = db.prepare("SELECT * FROM offers WHERE id = ? AND status = 'pending'").get(req.params.id);
    if (!o) return res.status(404).json({ error: 'Нет' });
    const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(o.listing_id);
    if (!l || l.seller_id !== sellerId) return res.status(403).json({ error: 'Нет доступа' });
    db.prepare("UPDATE offers SET status = 'rejected' WHERE id = ?").run(req.params.id);
    res.json({ success: true });
});
// 14. Отмена оффера покупателем — 0.2 TON
app.post('/api/offers/:id/cancel', (req, res) => {
    const { buyerId } = req.body;
    const o = db.prepare("SELECT * FROM offers WHERE id = ? AND status = 'pending'").get(req.params.id);
    if (!o) return res.status(404).json({ error: 'Нет' });
    if (o.buyer_id !== Number(buyerId)) return res.status(403).json({ error: 'Нет доступа' });
    const u = getUser(buyerId);
    if (!u || u.ton_balance < CANCEL_OFFER_FEE) return res.status(400).json({ error: `Нужно ${CANCEL_OFFER_FEE} TON` });
    const trx = db.transaction(() => {
        db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(CANCEL_OFFER_FEE, buyerId);
        payOwner(CANCEL_OFFER_FEE, 'TON');
        db.prepare("UPDATE offers SET status = 'cancelled' WHERE id = ?").run(o.id);
    });
    try { trx(); res.json({ success: true }); } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});

// ===== АУКЦИОНЫ (3, 12, 13, 17, 24) =====
function settleExpiredAuctions() {
    const now = Date.now();
    const expired = db.prepare("SELECT * FROM auctions WHERE end_time < ? AND status = 'active'").all(now);
    for (const a of expired) {
        const hold = db.prepare('SELECT * FROM auction_holds WHERE auction_id = ?').get(a.id);
        const reserveOk = !a.reserve_price || (a.current_bid >= a.reserve_price);
        if (a.current_bidder_id && hold && reserveOk) {
            const buyer = getUser(a.current_bidder_id);
            const bf = hold.currency === 'TON' ? 'ton_balance' : 'stars_balance';
            if (buyer && buyer[bf] >= hold.amount) {
                const trx = db.transaction(() => {
                    db.prepare(`UPDATE users SET ${bf} = ${bf} - ? WHERE id = ?`).run(hold.amount, a.current_bidder_id);
                    recordSale(a.seller_id, a.current_bidder_id, a, hold.amount, hold.currency, 'auction');
                    db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)').run(a.current_bidder_id, a.nft_slug, a.nft_name, a.nft_emoji);
                    db.prepare("UPDATE auctions SET status = 'sold' WHERE id = ?").run(a.id);
                    db.prepare('DELETE FROM auction_holds WHERE auction_id = ?').run(a.id);
                });
                try { trx(); notify(a.seller_id, '⏳ Аукцион продан', a.nft_name); notify(a.current_bidder_id, '🏆 Победа', a.nft_name); } catch(e) { console.error(e); }
            } else { db.prepare("UPDATE auctions SET status = 'ended' WHERE id = ?").run(a.id); db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)').run(a.seller_id, a.nft_slug, a.nft_name, a.nft_emoji); db.prepare('DELETE FROM auction_holds WHERE auction_id = ?').run(a.id); }
        } else {
            if (hold) { const oldBf = hold.currency === 'TON' ? 'ton_balance' : 'stars_balance'; db.prepare(`UPDATE users SET ${oldBf} = ${oldBf} + ? WHERE id = ?`).run(hold.amount, hold.user_id); db.prepare('DELETE FROM auction_holds WHERE auction_id = ?').run(a.id); }
            db.prepare("UPDATE auctions SET status = 'ended' WHERE id = ?").run(a.id);
            db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)').run(a.seller_id, a.nft_slug, a.nft_name, a.nft_emoji);
            notify(a.seller_id, '⚠️ Аукцион не состоялся', a.nft_name);
        }
    }
}
setInterval(settleExpiredAuctions, 30 * 1000);

app.get('/api/auctions', (req, res) => {
    res.json(db.prepare(`SELECT a.*, u.username as seller_name, (SELECT COUNT(*) FROM bids WHERE auction_id = a.id) as bids_count FROM auctions a JOIN users u ON a.seller_id = u.id WHERE a.status = 'active' ORDER BY a.end_time ASC`).all());
});
app.post('/api/auctions', (req, res) => {
    const { userId, nft_slug, nft_name, nft_emoji, currency, reserve, urgent } = req.body;
    const start_price = num(req.body.start_price, 0.000001, 1e9);
    const hours = num(req.body.hours, 0.01, 720);
    if (!start_price || !hours) return res.status(400).json({ error: 'Параметры' });
    if (isBanned(userId)) return res.status(403).json({ error: 'Забанен' });
    const item = db.prepare('SELECT * FROM inventory WHERE user_id = ? AND nft_slug = ?').get(userId, nft_slug);
    if (!item) return res.status(400).json({ error: 'NFT не найден' });
    let extra = 0;
    let reserve_price = 0;
    if (reserve) { extra += RESERVE_AUCTION_PRICE; reserve_price = start_price; }
    if (urgent) { extra += URGENT_AUCTION_PRICE; }
    const u = getUser(userId);
    if (extra > 0 && (!u || u.ton_balance < extra)) return res.status(400).json({ error: `Нужно ${extra} TON` });
    const finalHours = urgent ? 1 : hours;
    const endTime = Date.now() + finalHours * 3600 * 1000;
    const trx = db.transaction(() => {
        if (extra > 0) { db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(extra, userId); payOwner(extra, 'TON'); }
        db.prepare('INSERT INTO auctions (seller_id, nft_slug, nft_name, nft_emoji, start_price, reserve_price, current_bid, end_time, currency, is_urgent) VALUES (?,?,?,?,?,?,?,?,?,?)').run(userId, nft_slug, nft_name, nft_emoji, start_price, reserve_price, start_price, endTime, currency || 'TON', urgent ? 1 : 0);
        db.prepare('DELETE FROM inventory WHERE id = ?').run(item.id);
    });
    try { trx(); logAction(userId, 'auction_start', nft_name); res.json({ success: true }); }
    catch(e) { console.error(e); res.status(500).json({ error: 'Ошибка' }); }
});
// 12. Продление — 0.5 TON за +1ч
app.post('/api/auctions/:id/extend', (req, res) => {
    const { userId } = req.body;
    const a = db.prepare("SELECT * FROM auctions WHERE id = ? AND status = 'active'").get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Нет' });
    if (a.seller_id !== Number(userId)) return res.status(403).json({ error: 'Нет доступа' });
    const u = getUser(userId);
    if (!u || u.ton_balance < EXTEND_AUCTION_PRICE) return res.status(400).json({ error: `Нужно ${EXTEND_AUCTION_PRICE} TON` });
    const trx = db.transaction(() => {
        db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(EXTEND_AUCTION_PRICE, userId);
        payOwner(EXTEND_AUCTION_PRICE, 'TON');
        db.prepare('UPDATE auctions SET end_time = end_time + ? WHERE id = ?').run(3600*1000, a.id);
    });
    try { trx(); res.json({ success: true }); } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
// 17. Платное поднятие ставки — 0.3 TON
app.post('/api/auctions/:id/bid', (req, res) => {
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
        if (oldHold) { db.prepare('DELETE FROM auction_holds WHERE auction_id = ?').run(a.id); const oldBf = oldHold.currency === 'TON' ? 'ton_balance' : 'stars_balance'; db.prepare(`UPDATE users SET ${oldBf} = ${oldBf} + ? WHERE id = ?`).run(oldHold.amount, oldHold.user_id); }
        db.prepare(`UPDATE users SET ${bf} = ${bf} - ? WHERE id = ?`).run(amount, bidderId);
        if (fastFee > 0) { db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(fastFee, bidderId); payOwner(fastFee, 'TON'); }
        db.prepare('INSERT INTO auction_holds (auction_id, user_id, amount, currency) VALUES (?,?,?,?)').run(a.id, bidderId, amount, a.currency);
        db.prepare('UPDATE auctions SET current_bid = ?, current_bidder_id = ? WHERE id = ?').run(amount, bidderId, a.id);
        db.prepare('INSERT INTO bids (auction_id, bidder_id, amount) VALUES (?,?,?)').run(a.id, bidderId, amount);
        if (a.end_time - Date.now() < 5 * 60 * 1000) { db.prepare('UPDATE auctions SET end_time = end_time + ? WHERE id = ?').run(5*60*1000, a.id); }
    });
    try { trx(); notify(a.seller_id, '💸 Новая ставка', `${a.nft_name} — ${amount} ${a.currency}`); res.json({ success: true }); }
    catch(e) { console.error(e); res.status(500).json({ error: 'Ошибка' }); }
});
app.get('/api/auctions/:id/bids', (req, res) => {
    res.json(db.prepare(`SELECT b.*, u.username as bidder_name FROM bids b JOIN users u ON b.bidder_id = u.id WHERE b.auction_id = ? ORDER BY b.id DESC LIMIT 20`).all(req.params.id));
});

// ===== ВЫВОД NFT (6) =====
app.post('/api/withdraw/nft', (req, res) => {
    const { userId, slug, name, emoji, target } = req.body;
    if (!target || target.length < 4) return res.status(400).json({ error: 'Укажите @username' });
    if (isBanned(userId)) return res.status(403).json({ error: 'Забанен' });
    const item = db.prepare('SELECT * FROM inventory WHERE user_id = ? AND nft_slug = ?').get(userId, slug);
    if (!item) return res.status(400).json({ error: 'NFT не найден' });
    let newId;
    const trx = db.transaction(() => {
        db.prepare('DELETE FROM inventory WHERE id = ?').run(item.id);
        const info = db.prepare('INSERT INTO withdrawals (user_id, type, nft_slug, nft_name, nft_emoji, target) VALUES (?,?,?,?,?,?)').run(userId, 'NFT', slug, name, emoji, target);
        return info.lastInsertRowid;
    });
    try { newId = trx(); } catch(e) { console.error(e); return res.status(500).json({ error: 'Ошибка' }); }
    db.prepare("SELECT id FROM users WHERE role IN ('super','moder')").all().forEach(a => notify(a.id, '📤 Вывод NFT', `${getUser(userId).username}: ${name} → ${target}`));
    res.json({ success: true, id: newId });
});

// ===== ВЫВОД TON/STARS (4, 5, 20) =====
app.post('/api/withdraw/funds', (req, res) => {
    const { userId, currency, target, urgent } = req.body;
    const net = num(req.body.amount, 0.000001, 1e9);
    if (!net) return res.status(400).json({ error: 'Сумма' });
    if (!target || target.length < 4) return res.status(400).json({ error: 'Реквизиты' });
    if (!validCurrency(currency)) return res.status(400).json({ error: 'Валюта' });
    if (isBanned(userId)) return res.status(403).json({ error: 'Забанен' });
    const u = getUser(userId);
    const bf = currency === 'TON' ? 'ton_balance' : 'stars_balance';
    let feePct = urgent ? FEE_WITHDRAW_URGENT : FEE_WITHDRAW_NORMAL;
    if (net >= MASS_WITHDRAW_THRESHOLD) feePct = MASS_WITHDRAW_FEE;
    const fee = +(net * feePct / 100).toFixed(6);
    const total = +(net + fee).toFixed(6);
    if (u[bf] < total) return res.status(400).json({ error: 'Мало ' + currency + ' (с учётом комиссии ' + feePct + '%)' });
    let newId;
    const trx = db.transaction(() => {
        db.prepare(`UPDATE users SET ${bf} = ${bf} - ? WHERE id = ?`).run(total, userId);
        payOwner(fee, currency);
        const info = db.prepare('INSERT INTO withdrawals (user_id, type, amount, amount_net, fee, currency, target, urgent) VALUES (?,?,?,?,?,?,?,?)').run(userId, 'FUNDS', total, net, fee, currency, target, urgent ? 1 : 0);
        return info.lastInsertRowid;
    });
    try { newId = trx(); } catch(e) { console.error(e); return res.status(500).json({ error: 'Ошибка' }); }
    db.prepare("SELECT id FROM users WHERE role IN ('super','moder')").all().forEach(a => notify(a.id, '📤 Заявка на вывод', `${u.username}: ${net} ${currency} (fee ${fee}, ${urgent?'срочно':'3 дня'}) → ${target}`));
    res.json({ success: true, id: newId, net, fee, total, feePct });
});

// ===== РУЛЕТКА (8) =====
app.post('/api/roulette/spin', (req, res) => {
    const { userId } = req.body;
    if (isBanned(userId)) return res.status(403).json({ error: 'Забанен' });
    const u = getUser(userId);
    if (!u || u.ton_balance < ROULETTE_COST) return res.status(400).json({ error: `Нужно ${ROULETTE_COST} TON` });
    const isOwner = u.role === 'super';
    const roll = Math.random() * 100;
    let prize;
    if (isOwner) {
        prize = roll < 90 ? 20 : (roll < 95 ? 5 : (roll < 99 ? 3 : 1));
    } else {
        prize = roll < 60 ? 1 : (roll < 90 ? 3 : (roll < 99 ? 5 : 20));
    }
    const trx = db.transaction(() => {
        db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(ROULETTE_COST, userId);
        db.prepare('UPDATE users SET ton_balance = ton_balance + ? WHERE id = ?').run(prize, userId);
        const ownerCut = ROULETTE_COST - prize;
        if (ownerCut > 0) payOwner(ownerCut, 'TON'); else payOwner(0, 'TON');
        db.prepare('INSERT INTO roulette_spins (user_id, cost, prize, pool) VALUES (?,?,?,?)').run(userId, ROULETTE_COST, prize, isOwner ? 'owner' : 'public');
    });
    try { trx(); res.json({ success: true, prize }); }
    catch(e) { console.error(e); res.status(500).json({ error: 'Ошибка' }); }
});
app.get('/api/roulette/history/:userId', (req, res) => {
    res.json(db.prepare('SELECT * FROM roulette_spins WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(req.params.userId));
});

// ===== ВЕРИФИКАЦИЯ (15) =====
app.post('/api/verify', (req, res) => {
    const { userId } = req.body;
    if (isBanned(userId)) return res.status(403).json({ error: 'Забанен' });
    const u = getUser(userId);
    if (!u) return res.status(404).json({ error: 'Нет' });
    if (u.is_verified) return res.status(400).json({ error: 'Уже верифицирован' });
    if (u.ton_balance < VERIFY_PRICE) return res.status(400).json({ error: `Нужно ${VERIFY_PRICE} TON` });
    const trx = db.transaction(() => {
        db.prepare('UPDATE users SET ton_balance = ton_balance - ?, is_verified = 1 WHERE id = ?').run(VERIFY_PRICE, userId);
        payOwner(VERIFY_PRICE, 'TON');
        db.prepare('INSERT OR IGNORE INTO verifications (user_id, paid) VALUES (?,?)').run(userId, VERIFY_PRICE);
    });
    try { trx(); res.json({ success: true }); } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});

// ===== ПРИМЕРКА NFT (21) =====
app.post('/api/nft/trial', (req, res) => {
    const { userId, slug, name, emoji } = req.body;
    const u = getUser(userId);
    if (!u || u.ton_balance < NFT_TRIAL_PRICE) return res.status(400).json({ error: `Нужно ${NFT_TRIAL_PRICE} TON` });
    const trx = db.transaction(() => {
        db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(NFT_TRIAL_PRICE, userId);
        payOwner(NFT_TRIAL_PRICE, 'TON');
        db.prepare('INSERT INTO nft_trials (user_id, nft_slug, nft_name, nft_emoji, expires_at) VALUES (?,?,?,?,?)').run(userId, slug, name, emoji, Date.now() + 24*3600*1000);
    });
    try { trx(); res.json({ success: true }); } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});
app.get('/api/nft/trials/:userId', (req, res) => {
    res.json(db.prepare('SELECT * FROM nft_trials WHERE user_id = ? AND expires_at > ?').all(req.params.userId, Date.now()));
});

// ===== ОЦЕНКА NFT (23) =====
app.post('/api/nft/evaluate', (req, res) => {
    const { userId, slug, name } = req.body;
    const u = getUser(userId);
    if (!u || u.ton_balance < EVALUATION_PRICE) return res.status(400).json({ error: `Нужно ${EVALUATION_PRICE} TON` });
    const result = (Math.random() * 50 + 5).toFixed(2) + ' TON (оценка админа)';
    const trx = db.transaction(() => {
        db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(EVALUATION_PRICE, userId);
        payOwner(EVALUATION_PRICE, 'TON');
        db.prepare('INSERT INTO evaluations (user_id, nft_slug, nft_name, result) VALUES (?,?,?,?)').run(userId, slug, name, result);
    });
    try { trx(); res.json({ success: true, result }); } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});

// ===== ПАКЕТ ЛОТОВ (28) =====
app.post('/api/bundles', (req, res) => {
    const { userId, items, currency } = req.body;
    const price = num(req.body.price, 0.000001, 1e9);
    if (!price || !items || !items.length) return res.status(400).json({ error: 'Параметры' });
    if (isBanned(userId)) return res.status(403).json({ error: 'Забанен' });
    if (items.length < 3) return res.status(400).json({ error: 'Мин. 3 NFT' });
    const owned = db.prepare(`SELECT * FROM inventory WHERE user_id = ? AND nft_slug IN (${items.map(()=>'?').join(',')})`).all(userId, ...items);
    if (owned.length !== items.length) return res.status(400).json({ error: 'Не все NFT найдены' });
    const info = db.prepare('INSERT INTO bundles (seller_id, price, currency) VALUES (?,?,?)').run(userId, price, currency || 'TON');
    const bundleId = info.lastInsertRowid;
    const trx = db.transaction(() => {
        for (const it of owned) {
            db.prepare('INSERT INTO listings (seller_id, nft_slug, nft_name, nft_emoji, price, currency, bundle_id) VALUES (?,?,?,?,?,?,?)').run(userId, it.nft_slug, it.nft_name, it.nft_emoji, +(price/items.length).toFixed(6), currency || 'TON', bundleId);
            db.prepare('DELETE FROM inventory WHERE id = ?').run(it.id);
        }
    });
    try { trx(); res.json({ success: true, bundleId }); } catch(e) { console.error(e); res.status(500).json({ error: 'Ошибка' }); }
});
app.post('/api/bundles/:id/buy', (req, res) => {
    const { buyerId } = req.body;
    const b = db.prepare("SELECT * FROM bundles WHERE id = ? AND status = 'active'").get(req.params.id);
    if (!b) return res.status(404).json({ error: 'Нет' });
    if (b.seller_id === Number(buyerId)) return res.status(400).json({ error: 'Свой' });
    const buyer = getUser(buyerId);
    const bf = b.currency === 'TON' ? 'ton_balance' : 'stars_balance';
    if (!buyer || buyer[bf] < b.price) return res.status(400).json({ error: 'Мало ' + b.currency });
    const listings = db.prepare("SELECT * FROM listings WHERE bundle_id = ? AND status = 'active'").all(b.id);
    const trx = db.transaction(() => {
        db.prepare(`UPDATE users SET ${bf} = ${bf} - ? WHERE id = ?`).run(b.price, buyerId);
        recordSale(b.seller_id, buyerId, { nft_slug: 'bundle', nft_name: 'Пакет #'+b.id, nft_emoji: '📦' }, b.price, b.currency, 'bundle', BUNDLE_FEE);
        for (const l of listings) {
            db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)').run(buyerId, l.nft_slug, l.nft_name, l.nft_emoji);
            db.prepare("UPDATE listings SET status = 'sold' WHERE id = ?").run(l.id);
        }
        db.prepare("UPDATE bundles SET status = 'sold' WHERE id = ?").run(b.id);
    });
    try { trx(); notify(b.seller_id, '📦 Пакет продан', 'Пакет #'+b.id); res.json({ success: true }); }
    catch(e) { console.error(e); res.status(500).json({ error: 'Ошибка' }); }
});

// ===== НАСЛЕДИЕ (29) =====
app.post('/api/heir', (req, res) => {
    const { userId, heirId } = req.body;
    const u = getUser(userId);
    if (!u || u.ton_balance < HEIR_PRICE) return res.status(400).json({ error: `Нужно ${HEIR_PRICE} TON` });
    if (!getUser(heirId)) return res.status(400).json({ error: 'Наследник не найден' });
    const trx = db.transaction(() => {
        db.prepare('UPDATE users SET ton_balance = ton_balance - ?, heir_id = ? WHERE id = ?').run(HEIR_PRICE, heirId, userId);
        payOwner(HEIR_PRICE, 'TON');
    });
    try { trx(); res.json({ success: true }); } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});

// ===== ЭКСКЛЮЗИВ (30) =====
app.post('/api/listings/:id/exclusive', (req, res) => {
    const { userId } = req.body;
    const l = db.prepare("SELECT * FROM listings WHERE id = ? AND status = 'active'").get(req.params.id);
    if (!l) return res.status(404).json({ error: 'Нет' });
    if (l.seller_id !== Number(userId)) return res.status(403).json({ error: 'Нет доступа' });
    db.prepare('UPDATE listings SET is_exclusive = 1 WHERE id = ?').run(l.id);
    res.json({ success: true });
});

// ===== ТОП / ИСТОРИЯ / УВЕДОМЛЕНИЯ =====
app.get('/api/top-sellers', (req, res) => res.json(db.prepare(`SELECT u.username, COUNT(s.id) as sold, COALESCE(SUM(s.price),0) as total FROM users u LEFT JOIN sales_history s ON s.seller_id = u.id GROUP BY u.id HAVING sold > 0 ORDER BY sold DESC LIMIT 10`).all()));
app.get('/api/history/sales/:userId', (req, res) => res.json(db.prepare(`SELECT s.*, su.username as seller_name, bu.username as buyer_name FROM sales_history s LEFT JOIN users su ON s.seller_id = su.id LEFT JOIN users bu ON s.buyer_id = bu.id WHERE s.seller_id = ? OR s.buyer_id = ? ORDER BY s.id DESC LIMIT 50`).all(req.params.userId, req.params.userId)));
app.get('/api/notifications/:userId', (req, res) => res.json(db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 30').all(req.params.userId)));
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
    const fees = db.prepare("SELECT COALESCE(SUM(fee),0) as v FROM
