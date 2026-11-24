const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const ADMIN_USERNAME = 'admin'; // ← ВПИШИ СВОЙ НИК

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

// ========== ВХОД / РЕГИСТРАЦИЯ ==========
app.post('/api/login', (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Введите ник' });
    let user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
        const isAdmin = username === ADMIN_USERNAME ? 1 : 0;
        const info = db.prepare('INSERT INTO users (username, is_admin) VALUES (?, ?)').run(username, isAdmin);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    } else {
        if (username === ADMIN_USERNAME && user.is_admin !== 1) {
            db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
            user.is_admin = 1;
        }
    }
    if (user.is_banned) return res.status(403).json({ error: 'Вы забанены' });
    res.json(user);
});

app.get('/api/user/:id', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'Нет пользователя' });
    res.json(user);
});

// ========== ИНВЕНТАРЬ ==========
app.get('/api/inventory/:userId', (req, res) => {
    res.json(db.prepare('SELECT * FROM inventory WHERE user_id = ?').all(req.params.userId));
});

app.post('/api/give-nft', (req, res) => {
    const { userId, slug, name, emoji } = req.body;
    db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)')
      .run(userId, slug, name, emoji);
    res.json({ success: true });
});

// ========== ЛОТЫ ==========
app.get('/api/listings', (req, res) => {
    const listings = db.prepare(`
        SELECT l.*, u.username as seller_name
        FROM listings l JOIN users u ON l.seller_id = u.id
        WHERE l.status = 'active' ORDER BY l.id DESC
    `).all();
    res.json(listings);
});

app.post('/api/listings', (req, res) => {
    const { userId, nft_slug, nft_name, nft_emoji, price_ton } = req.body;
    const item = db.prepare('SELECT * FROM inventory WHERE user_id = ? AND nft_slug = ?').get(userId, nft_slug);
    if (!item) return res.status(400).json({ error: 'NFT не найден в инвентаре' });
    const already = db.prepare("SELECT id FROM listings WHERE seller_id = ? AND nft_slug = ? AND status = 'active'").get(userId, nft_slug);
    if (already) return res.status(400).json({ error: 'Этот NFT уже выставлен' });
    db.prepare('INSERT INTO listings (seller_id, nft_slug, nft_name, nft_emoji, price_ton) VALUES (?,?,?,?,?)')
      .run(userId, nft_slug, nft_name, nft_emoji, price_ton);
    db.prepare('DELETE FROM inventory WHERE id = ?').run(item.id);
    res.json({ success: true });
});

app.delete('/api/listings/:id', (req, res) => {
    const { userId } = req.query;
    const listing = db.prepare("SELECT * FROM listings WHERE id = ? AND status = 'active'").get(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Лот не найден' });
    if (listing.seller_id !== Number(userId)) return res.status(403).json({ error: 'Не ваш лот' });
    db.prepare("UPDATE listings SET status = 'cancelled' WHERE id = ?").run(req.params.id);
    db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)')
      .run(listing.seller_id, listing.nft_slug, listing.nft_name, listing.nft_emoji);
    res.json({ success: true });
});

app.post('/api/listings/:id/buy', (req, res) => {
    const { buyerId } = req.body;
    const listing = db.prepare("SELECT * FROM listings WHERE id = ? AND status = 'active'").get(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Лот не найден' });
    if (listing.seller_id === buyerId) return res.status(400).json({ error: 'Нельзя купить свой лот' });
    const buyer = db.prepare('SELECT * FROM users WHERE id = ?').get(buyerId);
    if (!buyer || buyer.ton_balance < listing.price_ton) return res.status(400).json({ error: 'Недостаточно TON' });

    const trx = db.transaction(() => {
        db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(listing.price_ton, buyerId);
        db.prepare('UPDATE users SET ton_balance = ton_balance + ? WHERE id = ?').run(listing.price_ton, listing.seller_id);
        db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)')
          .run(buyerId, listing.nft_slug, listing.nft_name, listing.nft_emoji);
        db.prepare("UPDATE listings SET status = 'sold' WHERE id = ?").run(listing.id);
        db.prepare('INSERT INTO sales_history (seller_id, buyer_id, nft_slug, nft_name, nft_emoji, price_ton, sale_type) VALUES (?,?,?,?,?,?,?)')
          .run(listing.seller_id, buyerId, listing.nft_slug, listing.nft_name, listing.nft_emoji, listing.price_ton, 'listing');
    });
    try { trx(); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: 'Ошибка транзакции' }); }
});

// ========== ОФФЕРЫ ==========
app.get('/api/offers/listing/:listingId', (req, res) => {
    res.json(db.prepare(`
        SELECT o.*, u.username as buyer_name
        FROM offers o JOIN users u ON o.buyer_id = u.id
        WHERE o.listing_id = ? ORDER BY o.price_ton DESC
    `).all(req.params.listingId));
});

app.get('/api/offers/incoming/:userId', (req, res) => {
    res.json(db.prepare(`
        SELECT o.*, u.username as buyer_name, l.nft_name, l.nft_emoji
        FROM offers o
        JOIN listings l ON o.listing_id = l.id
        JOIN users u ON o.buyer_id = u.id
        WHERE l.seller_id = ? AND o.status = 'pending' AND l.status = 'active'
        ORDER BY o.created_at DESC
    `).all(req.params.userId));
});

app.post('/api/offers', (req, res) => {
    const { listingId, buyerId, price } = req.body;
    if (!price || price <= 0) return res.status(400).json({ error: 'Введите цену' });
    const listing = db.prepare("SELECT * FROM listings WHERE id = ? AND status = 'active'").get(listingId);
    if (!listing) return res.status(404).json({ error: 'Лот не найден' });
    if (listing.seller_id === buyerId) return res.status(400).json({ error: 'Свой лот' });
    const buyer = db.prepare('SELECT * FROM users WHERE id = ?').get(buyerId);
    if (!buyer || buyer.ton_balance < price) return res.status(400).json({ error: 'Недостаточно TON' });
    const info = db.prepare('INSERT INTO offers (listing_id, buyer_id, price_ton) VALUES (?,?,?)').run(listingId, buyerId, price);
    res.json({ success: true, offerId: info.lastInsertRowid });
});

app.post('/api/offers/:id/accept', (req, res) => {
    const { sellerId } = req.body;
    const offer = db.prepare("SELECT * FROM offers WHERE id = ? AND status = 'pending'").get(req.params.id);
    if (!offer) return res.status(404).json({ error: 'Оффер не найден' });
    const listing = db.prepare("SELECT * FROM listings WHERE id = ? AND status = 'active'").get(offer.listing_id);
    if (!listing || listing.seller_id !== sellerId) return res.status(403).json({ error: 'Нет доступа' });
    const buyer = db.prepare('SELECT * FROM users WHERE id = ?').get(offer.buyer_id);
    if (!buyer || buyer.ton_balance < offer.price_ton) return res.status(400).json({ error: 'У покупателя мало TON' });

    const trx = db.transaction(() => {
        db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(offer.price_ton, offer.buyer_id);
        db.prepare('UPDATE users SET ton_balance = ton_balance + ? WHERE id = ?').run(offer.price_ton, sellerId);
        db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)')
          .run(offer.buyer_id, listing.nft_slug, listing.nft_name, listing.nft_emoji);
        db.prepare("UPDATE listings SET status = 'sold' WHERE id = ?").run(listing.id);
        db.prepare("UPDATE offers SET status = 'accepted' WHERE id = ?").run(offer.id);
        db.prepare("UPDATE offers SET status = 'rejected' WHERE listing_id = ? AND id != ?").run(listing.id, offer.id);
        db.prepare('INSERT INTO sales_history (seller_id, buyer_id, nft_slug, nft_name, nft_emoji, price_ton, sale_type) VALUES (?,?,?,?,?,?,?)')
          .run(sellerId, offer.buyer_id, listing.nft_slug, listing.nft_name, listing.nft_emoji, offer.price_ton, 'offer');
    });
    try { trx(); res.json({ success: true }); }
    catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/offers/:id/reject', (req, res) => {
    const { sellerId } = req.body;
    const offer = db.prepare("SELECT * FROM offers WHERE id = ? AND status = 'pending'").get(req.params.id);
    if (!offer) return res.status(404).json({ error: 'Нет оффера' });
    const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(offer.listing_id);
    if (!listing || listing.seller_id !== sellerId) return res.status(403).json({ error: 'Нет доступа' });
    db.prepare("UPDATE offers SET status = 'rejected' WHERE id = ?").run(req.params.id);
    res.json({ success: true });
});

// ========== АУКЦИОНЫ ==========
app.get('/api/auctions', (req, res) => {
    const now = Date.now();
    db.prepare("UPDATE auctions SET status = 'ended' WHERE end_time < ? AND status = 'active'").run(now);
    res.json(db.prepare(`
        SELECT a.*, u.username as seller_name
        FROM auctions a JOIN users u ON a.seller_id = u.id
        WHERE a.status = 'active' ORDER BY a.end_time ASC
    `).all());
});

app.post('/api/auctions', (req, res) => {
    const { userId, nft_slug, nft_name, nft_emoji, start_price, hours } = req.body;
    const item = db.prepare('SELECT * FROM inventory WHERE user_id = ? AND nft_slug = ?').get(userId, nft_slug);
    if (!item) return res.status(400).json({ error: 'NFT не найден' });
    const endTime = Date.now() + hours * 3600 * 1000;
    db.prepare('INSERT INTO auctions (seller_id, nft_slug, nft_name, nft_emoji, start_price, current_bid, end_time) VALUES (?,?,?,?,?,?,?)')
      .run(userId, nft_slug, nft_name, nft_emoji, start_price, start_price, endTime);
    db.prepare('DELETE FROM inventory WHERE id = ?').run(item.id);
    res.json({ success: true });
});

app.post('/api/auctions/:id/bid', (req, res) => {
    const { bidderId, amount } = req.body;
    const auc = db.prepare("SELECT * FROM auctions WHERE id = ? AND status = 'active'").get(req.params.id);
    if (!auc) return res.status(404).json({ error: 'Аукцион не найден' });
    if (Date.now() > auc.end_time) return res.status(400).json({ error: 'Аукцион завершён' });
    if (auc.seller_id === bidderId) return res.status(400).json({ error: 'Свой аукцион' });
    if (amount <= auc.current_bid) return res.status(400).json({ error: 'Ставка должна быть выше' });
    const bidder = db.prepare('SELECT * FROM users WHERE id = ?').get(bidderId);
    if (!bidder || bidder.ton_balance < amount) return res.status(400).json({ error: 'Мало TON' });
    db.prepare('UPDATE auctions SET current_bid = ?, current_bidder_id = ? WHERE id = ?').run(amount, bidderId, auc.id);
    db.prepare('INSERT INTO bids (auction_id, bidder_id, amount) VALUES (?,?,?)').run(auc.id, bidderId, amount);
    res.json({ success: true });
});

app.post('/api/auctions/:id/finish', (req, res) => {
    const auc = db.prepare("SELECT * FROM auctions WHERE id = ? AND status = 'active'").get(req.params.id);
    if (!auc) return res.status(404).json({ error: 'Нет аукциона' });
    if (!auc.current_bidder_id) {
        db.prepare("UPDATE auctions SET status = 'ended' WHERE id = ?").run(auc.id);
        db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)')
          .run(auc.seller_id, auc.nft_slug, auc.nft_name, auc.nft_emoji);
        return res.json({ success: true, sold: false });
    }
    const buyer = db.prepare('SELECT * FROM users WHERE id = ?').get(auc.current_bidder_id);
    if (!buyer || buyer.ton_balance < auc.current_bid) return res.status(400).json({ error: 'Покупатель не может оплатить' });
    const trx = db.transaction(() => {
        db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(auc.current_bid, auc.current_bidder_id);
        db.prepare('UPDATE users SET ton_balance = ton_balance + ? WHERE id = ?').run(auc.current_bid, auc.seller_id);
        db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)')
          .run(auc.current_bidder_id, auc.nft_slug, auc.nft_name, auc.nft_emoji);
        db.prepare("UPDATE auctions SET status = 'sold' WHERE id = ?").run(auc.id);
        db.prepare('INSERT INTO sales_history (seller_id, buyer_id, nft_slug, nft_name, nft_emoji, price_ton, sale_type) VALUES (?,?,?,?,?,?,?)')
          .run(auc.seller_id, auc.current_bidder_id, auc.nft_slug, auc.nft_name, auc.nft_emoji, auc.current_bid, 'auction');
    });
    try { trx(); res.json({ success: true, sold: true }); }
    catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

// ========== ОБМЕН NFT ==========
app.post('/api/swap', (req, res) => {
    const { userId, mySlug, targetSlug, targetName, targetEmoji, targetTon } = req.body;
    const mine = db.prepare('SELECT * FROM inventory WHERE user_id = ? AND nft_slug = ?').get(userId, mySlug);
    if (!mine) return res.status(400).json({ error: 'Ваш NFT не найден' });
    const myTon = 10;
    const diff = targetTon - myTon;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (diff > 0 && user.ton_balance < diff) return res.status(400).json({ error: 'Мало TON для доплаты' });
    const trx = db.transaction(() => {
        db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(diff > 0 ? diff : 0, userId);
        db.prepare('UPDATE users SET ton_balance = ton_balance + ? WHERE id = ?').run(diff < 0 ? -diff : 0, userId);
        db.prepare('DELETE FROM inventory WHERE id = ?').run(mine.id);
        db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)')
          .run(userId, targetSlug, targetName, targetEmoji);
    });
    try { trx(); res.json({ success: true, diff }); }
    catch (e) { res.status(500).json({ error: 'Ошибка' }); }
});

// ========== ИСТОРИЯ ПРОДАЖ ==========
app.get('/api/history/sales/:userId', (req, res) => {
    res.json(db.prepare(`
        SELECT s.*, su.username as seller_name, bu.username as buyer_name
        FROM sales_history s
        LEFT JOIN users su ON s.seller_id = su.id
        LEFT JOIN users bu ON s.buyer_id = bu.id
        WHERE s.seller_id = ? OR s.buyer_id = ?
        ORDER BY s.id DESC LIMIT 50
    `).all(req.params.userId, req.params.userId));
});

// ========== АДМИН ==========
function checkAdmin(adminId) {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(adminId);
    return u && u.is_admin === 1;
}

app.get('/api/admin/users', (req, res) => {
    if (!checkAdmin(req.query.adminId)) return res.status(403).json({ error: 'Нет доступа' });
    res.json(db.prepare('SELECT id, username, ton_balance, is_admin, is_banned FROM users').all());
});

app.get('/api/admin/stats', (req, res) => {
    if (!checkAdmin(req.query.adminId)) return res.status(403).json({ error: 'Нет доступа' });
    const users = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
    const listings = db.prepare("SELECT COUNT(*) as c FROM listings WHERE status = 'active'").get().c;
    const sales = db.prepare('SELECT COUNT(*) as c, COALESCE(SUM(price_ton),0) as vol FROM sales_history').get();
    res.json({ users, listings, sales: sales.c, volume: sales.vol });
});

app.post('/api/admin/ban', (req, res) => {
    const { adminId, userId, ban } = req.body;
    if (!checkAdmin(adminId)) return res.status(403).json({ error: 'Нет доступа' });
    if (userId === adminId) return res.status(400).json({ error: 'Себя нельзя' });
    db.prepare('UPDATE users SET is_banned = ? WHERE id = ?').run(ban ? 1 : 0, userId);
    res.json({ success: true });
});

app.post('/api/admin/give-nft', (req, res) => {
    const { adminId, userId, slug, name, emoji } = req.body;
    if (!checkAdmin(adminId)) return res.status(403).json({ error: 'Нет доступа' });
    db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)')
      .run(userId, slug, name, emoji);
    res.json({ success: true });
});

app.delete('/api/admin/listings/:id', (req, res) => {
    if (!checkAdmin(req.query.adminId)) return res.status(403).json({ error: 'Нет доступа' });
    db.prepare("UPDATE listings SET status = 'cancelled' WHERE id = ?").run(req.params.id);
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Сервер на порту ' + PORT));
