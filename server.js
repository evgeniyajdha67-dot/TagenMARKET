const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

const ADMIN_USERNAME = 'tagen'; // ← ТВОЙ НИК

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

// ========== ВХОД ==========
app.post('/api/login', (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Введите ник' });
    let user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
        const isAdmin = username === ADMIN_USERNAME ? 1 : 0;
        const info = db.prepare('INSERT INTO users (username, is_admin) VALUES (?, ?)').run(username, isAdmin);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    } else if (username === ADMIN_USERNAME && user.is_admin !== 1) {
        db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
        user.is_admin = 1;
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
    res.json(db.prepare(`
        SELECT l.*, u.username as seller_name
        FROM listings l JOIN users u ON l.seller_id = u.id
        WHERE l.status = 'active' ORDER BY l.id DESC
    `).all());
});

app.post('/api/listings', (req, res) => {
    const { userId, nft_slug, nft_name, nft_emoji, price_ton } = req.body;
    const item = db.prepare('SELECT * FROM inventory WHERE user_id = ? AND nft_slug = ?').get(userId, nft_slug);
    if (!item) return res.status(400).json({ error: 'NFT не найден' });
    const already = db.prepare("SELECT id FROM listings WHERE seller_id = ? AND nft_slug = ? AND status = 'active'").get(userId, nft_slug);
    if (already) return res.status(400).json({ error: 'Уже выставлен' });
    db.prepare('INSERT INTO listings (seller_id, nft_slug, nft_name, nft_emoji, price_ton) VALUES (?,?,?,?,?)')
      .run(userId, nft_slug, nft_name, nft_emoji, price_ton);
    db.prepare('DELETE FROM inventory WHERE id = ?').run(item.id);
    res.json({ success: true });
});

app.delete('/api/listings/:id', (req, res) => {
    const { userId } = req.query;
    const l = db.prepare("SELECT * FROM listings WHERE id = ? AND status = 'active'").get(req.params.id);
    if (!l) return res.status(404).json({ error: 'Нет лота' });
    if (l.seller_id !== Number(userId)) return res.status(403).json({ error: 'Не ваш' });
    db.prepare("UPDATE listings SET status = 'cancelled' WHERE id = ?").run(req.params.id);
    db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)')
      .run(l.seller_id, l.nft_slug, l.nft_name, l.nft_emoji);
    res.json({ success: true });
});

app.post('/api/listings/:id/buy', (req, res) => {
    const { buyerId } = req.body;
    const l = db.prepare("SELECT * FROM listings WHERE id = ? AND status = 'active'").get(req.params.id);
    if (!l) return res.status(404).json({ error: 'Нет лота' });
    if (l.seller_id === buyerId) return res.status(400).json({ error: 'Свой лот' });
    const buyer = db.prepare('SELECT * FROM users WHERE id = ?').get(buyerId);
    if (!buyer || buyer.ton_balance < l.price_ton) return res.status(400).json({ error: 'Мало TON' });
    const trx = db.transaction(() => {
        db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(l.price_ton, buyerId);
        db.prepare('UPDATE users SET ton_balance = ton_balance + ? WHERE id = ?').run(l.price_ton, l.seller_id);
        db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)')
          .run(buyerId, l.nft_slug, l.nft_name, l.nft_emoji);
        db.prepare("UPDATE listings SET status = 'sold' WHERE id = ?").run(l.id);
        db.prepare('INSERT INTO sales_history (seller_id, buyer_id, nft_slug, nft_name, nft_emoji, price_ton, sale_type) VALUES (?,?,?,?,?,?,?)')
          .run(l.seller_id, buyerId, l.nft_slug, l.nft_name, l.nft_emoji, l.price_ton, 'listing');
    });
    try { trx(); res.json({ success: true }); } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});

// ========== ОФФЕРЫ ==========
app.post('/api/offers', (req, res) => {
    const { listingId, buyerId, price } = req.body;
    if (!price || price <= 0) return res.status(400).json({ error: 'Цена' });
    const l = db.prepare("SELECT * FROM listings WHERE id = ? AND status = 'active'").get(listingId);
    if (!l) return res.status(404).json({ error: 'Лот не найден' });
    if (l.seller_id === buyerId) return res.status(400).json({ error: 'Свой лот' });
    const buyer = db.prepare('SELECT * FROM users WHERE id = ?').get(buyerId);
    if (!buyer || buyer.ton_balance < price) return res.status(400).json({ error: 'Мало TON' });
    const info = db.prepare('INSERT INTO offers (listing_id, buyer_id, price_ton) VALUES (?,?,?)').run(listingId, buyerId, price);
    res.json({ success: true, id: info.lastInsertRowid });
});

app.get('/api/offers/incoming/:userId', (req, res) => {
    res.json(db.prepare(`
        SELECT o.*, u.username as buyer_name, l.nft_name, l.nft_emoji
        FROM offers o
        JOIN listings l ON o.listing_id = l.id
        JOIN users u ON o.buyer_id = u.id
        WHERE l.seller_id = ? AND o.status = 'pending' AND l.status = 'active'
        ORDER BY o.id DESC
    `).all(req.params.userId));
});

app.post('/api/offers/:id/accept', (req, res) => {
    const { sellerId } = req.body;
    const o = db.prepare("SELECT * FROM offers WHERE id = ? AND status = 'pending'").get(req.params.id);
    if (!o) return res.status(404).json({ error: 'Оффер не найден' });
    const l = db.prepare("SELECT * FROM listings WHERE id = ? AND status = 'active'").get(o.listing_id);
    if (!l || l.seller_id !== sellerId) return res.status(403).json({ error: 'Нет доступа' });
    const buyer = db.prepare('SELECT * FROM users WHERE id = ?').get(o.buyer_id);
    if (!buyer || buyer.ton_balance < o.price_ton) return res.status(400).json({ error: 'У покупателя мало TON' });
    const trx = db.transaction(() => {
        db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(o.price_ton, o.buyer_id);
        db.prepare('UPDATE users SET ton_balance = ton_balance + ? WHERE id = ?').run(o.price_ton, sellerId);
        db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)')
          .run(o.buyer_id, l.nft_slug, l.nft_name, l.nft_emoji);
        db.prepare("UPDATE listings SET status = 'sold' WHERE id = ?").run(l.id);
        db.prepare("UPDATE offers SET status = 'accepted' WHERE id = ?").run(o.id);
        db.prepare("UPDATE offers SET status = 'rejected' WHERE listing_id = ? AND id != ?").run(l.id, o.id);
        db.prepare('INSERT INTO sales_history (seller_id, buyer_id, nft_slug, nft_name, nft_emoji, price_ton, sale_type) VALUES (?,?,?,?,?,?,?)')
          .run(sellerId, o.buyer_id, l.nft_slug, l.nft_name, l.nft_emoji, o.price_ton, 'offer');
    });
    try { trx(); res.json({ success: true }); } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});

app.post('/api/offers/:id/reject', (req, res) => {
    const { sellerId } = req.body;
    const o = db.prepare("SELECT * FROM offers WHERE id = ? AND status = 'pending'").get(req.params.id);
    if (!o) return res.status(404).json({ error: 'Нет оффера' });
    const l = db.prepare('SELECT * FROM listings WHERE id = ?').get(o.listing_id);
    if (!l || l.seller_id !== sellerId) return res.status(403).json({ error: 'Нет доступа' });
    db.prepare("UPDATE offers SET status = 'rejected' WHERE id = ?").run(req.params.id);
    res.json({ success: true });
});

// ========== АУКЦИОНЫ ==========
app.get('/api/auctions', (req, res) => {
    const now = Date.now();
    // Автозавершение просроченных
    const expired = db.prepare("SELECT * FROM auctions WHERE end_time < ? AND status = 'active'").all(now);
    for (const a of expired) {
        if (a.current_bidder_id) {
            const buyer = db.prepare('SELECT * FROM users WHERE id = ?').get(a.current_bidder_id);
            if (buyer && buyer.ton_balance >= a.current_bid) {
                const trx = db.transaction(() => {
                    db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(a.current_bid, a.current_bidder_id);
                    db.prepare('UPDATE users SET ton_balance = ton_balance + ? WHERE id = ?').run(a.current_bid, a.seller_id);
                    db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)')
                      .run(a.current_bidder_id, a.nft_slug, a.nft_name, a.nft_emoji);
                    db.prepare("UPDATE auctions SET status = 'sold' WHERE id = ?").run(a.id);
                    db.prepare('INSERT INTO sales_history (seller_id, buyer_id, nft_slug, nft_name, nft_emoji, price_ton, sale_type) VALUES (?,?,?,?,?,?,?)')
                      .run(a.seller_id, a.current_bidder_id, a.nft_slug, a.nft_name, a.nft_emoji, a.current_bid, 'auction');
                });
                try { trx(); } catch(e) {}
            } else {
                db.prepare("UPDATE auctions SET status = 'ended' WHERE id = ?").run(a.id);
                db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)')
                  .run(a.seller_id, a.nft_slug, a.nft_name, a.nft_emoji);
            }
        } else {
            db.prepare("UPDATE auctions SET status = 'ended' WHERE id = ?").run(a.id);
            db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)')
              .run(a.seller_id, a.nft_slug, a.nft_name, a.nft_emoji);
        }
    }
    res.json(db.prepare(`
        SELECT a.*, u.username as seller_name,
               (SELECT COUNT(*) FROM bids WHERE auction_id = a.id) as bids_count
        FROM auctions a JOIN users u ON a.seller_id = u.id
        WHERE a.status = 'active' ORDER BY a.end_time ASC
    `).all());
});

app.post('/api/auctions', (req, res) => {
    const { userId, nft_slug, nft_name, nft_emoji, start_price, hours } = req.body;
    if (!start_price || start_price <= 0 || !hours || hours <= 0) return res.status(400).json({ error: 'Параметры' });
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
    const a = db.prepare("SELECT * FROM auctions WHERE id = ? AND status = 'active'").get(req.params.id);
    if (!a) return res.status(404).json({ error: 'Нет аукциона' });
    if (Date.now() > a.end_time) return res.status(400).json({ error: 'Аукцион завершён' });
    if (a.seller_id === bidderId) return res.status(400).json({ error: 'Свой аукцион' });
    if (amount <= a.current_bid) return res.status(400).json({ error: 'Ставка должна быть выше текущей' });
    const bidder = db.prepare('SELECT * FROM users WHERE id = ?').get(bidderId);
    if (!bidder || bidder.ton_balance < amount) return res.status(400).json({ error: 'Мало TON' });
    db.prepare('UPDATE auctions SET current_bid = ?, current_bidder_id = ? WHERE id = ?').run(amount, bidderId, a.id);
    db.prepare('INSERT INTO bids (auction_id, bidder_id, amount) VALUES (?,?,?)').run(a.id, bidderId, amount);
    res.json({ success: true });
});

app.get('/api/auctions/:id/bids', (req, res) => {
    res.json(db.prepare(`
        SELECT b.*, u.username as bidder_name
        FROM bids b JOIN users u ON b.bidder_id = u.id
        WHERE b.auction_id = ? ORDER BY b.id DESC LIMIT 20
    `).all(req.params.id));
});

// ========== ОБМЕН ==========
app.post('/api/swap', (req, res) => {
    const { userId, mySlug, targetSlug, targetName, targetEmoji, targetTon } = req.body;
    const mine = db.prepare('SELECT * FROM inventory WHERE user_id = ? AND nft_slug = ?').get(userId, mySlug);
    if (!mine) return res.status(400).json({ error: 'Ваш NFT не найден' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const myTon = 10; // базовая оценка
    const diff = targetTon - myTon;
    if (diff > 0 && user.ton_balance < diff) return res.status(400).json({ error: 'Мало TON для доплаты' });
    const trx = db.transaction(() => {
        if (diff > 0) db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(diff, userId);
        else if (diff < 0) db.prepare('UPDATE users SET ton_balance = ton_balance + ? WHERE id = ?').run(-diff, userId);
        db.prepare('DELETE FROM inventory WHERE id = ?').run(mine.id);
        db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)')
          .run(userId, targetSlug, targetName, targetEmoji);
    });
    try { trx(); res.json({ success: true, diff }); } catch(e) { res.status(500).json({ error: 'Ошибка' }); }
});

// ========== ИСТОРИЯ ==========
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
function checkAdmin(id) {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
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
    const auctions = db.prepare("SELECT COUNT(*) as c FROM auctions WHERE status = 'active'").get().c;
    const sales = db.prepare('SELECT COUNT(*) as c, COALESCE(SUM(price_ton),0) as vol FROM sales_history').get();
    res.json({ users, listings, auctions, sales: sales.c, volume: sales.vol });
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
