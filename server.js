const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/login', (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Введите ник' });
    let user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user) {
        const info = db.prepare('INSERT INTO users (username) VALUES (?)').run(username);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    }
    res.json(user);
});

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
    if (!item) return res.status(400).json({ error: 'NFT не найден' });
    db.prepare('INSERT INTO listings (seller_id, nft_slug, nft_name, nft_emoji, price_ton) VALUES (?,?,?,?,?)')
      .run(userId, nft_slug, nft_name, nft_emoji, price_ton);
    db.prepare('DELETE FROM inventory WHERE id = ?').run(item.id);
    res.json({ success: true });
});

app.post('/api/listings/:id/buy', (req, res) => {
    const { buyerId } = req.body;
    const listing = db.prepare('SELECT * FROM listings WHERE id = ? AND status = ?').get(req.params.id, 'active');
    if (!listing) return res.status(404).json({ error: 'Лот не найден' });
    const buyer = db.prepare('SELECT * FROM users WHERE id = ?').get(buyerId);
    if (!buyer || buyer.ton_balance < listing.price_ton) return res.status(400).json({ error: 'Мало TON' });

    const transaction = db.transaction(() => {
        db.prepare('UPDATE users SET ton_balance = ton_balance - ? WHERE id = ?').run(listing.price_ton, buyerId);
        db.prepare('UPDATE users SET ton_balance = ton_balance + ? WHERE id = ?').run(listing.price_ton, listing.seller_id);
        db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)')
          .run(buyerId, listing.nft_slug, listing.nft_name, listing.nft_emoji);
        db.prepare('UPDATE listings SET status = ? WHERE id = ?').run('sold', listing.id);
    });
    try { transaction(); res.json({ success: true }); }
    catch(e) { res.status(500).json({ error: 'Ошибка транзакции' }); }
});

app.get('/api/inventory/:userId', (req, res) => {
    const items = db.prepare('SELECT * FROM inventory WHERE user_id = ?').all(req.params.userId);
    res.json(items);
});

app.post('/api/give-nft', (req, res) => {
    const { userId, slug, name, emoji } = req.body;
    db.prepare('INSERT INTO inventory (user_id, nft_slug, nft_name, nft_emoji) VALUES (?,?,?,?)')
      .run(userId, slug, name, emoji);
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Сервер на порту ' + PORT));
