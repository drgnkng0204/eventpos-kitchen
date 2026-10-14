// EventPOS & Kitchen — 依存なしのリアルタイム同期サーバー
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_FILE || path.join(__dirname, 'data.json');

const initial = () => ({
  products: [
    { id: 'niku', name: '小肉まん', price: 300, managed: true },
    { id: 'an', name: '小あんまん', price: 400, managed: true },
    { id: 'wanage', name: '輪投げ', price: 200, managed: false },
  ],
  inventory: { niku: { store: 0, kitchen: 0, transit: 0 }, an: { store: 0, kitchen: 0, transit: 0 } },
  orders: [], donations: [], requests: [],
  register: { opening: 0, closing: null, closedAt: null },
  seq: 1,
});
let S = fs.existsSync(DATA) ? JSON.parse(fs.readFileSync(DATA, 'utf8')) : initial();
const save = () => fs.writeFileSync(DATA, JSON.stringify(S));
const nid = (p) => `${p}${S.seq++}`;
const prod = (id) => S.products.find((p) => p.id === id);
const inv = (id) => (S.inventory[id] ||= { store: 0, kitchen: 0, transit: 0 });

const A = {
  sale({ items, donation, cashReceived }) {
    const lines = (items || []).filter((i) => i.qty > 0 && prod(i.id)).map((i) => ({
      product_id: i.id, name: prod(i.id).name, qty: i.qty | 0, unit_price: prod(i.id).price, // 購入時点単価を固定
    }));
    let orderId = null;
    if (lines.length) {
      orderId = nid('O');
      const total = lines.reduce((s, l) => s + l.unit_price * l.qty, 0);
      S.orders.push({ order_id: orderId, created_at: Date.now(), items: lines, total_sales: total, cash_received: cashReceived ?? null, cancelled: false });
      lines.forEach((l) => { if (prod(l.product_id).managed) inv(l.product_id).store -= l.qty; }); // マイナス在庫許容
    }
    if (donation && donation.amount > 0) {
      S.donations.push({ donation_id: nid('D'), order_id: orderId, amount: donation.amount | 0,
        donor_name: donation.anon || !donation.name ? '匿名' : donation.name, anonymous: !!(donation.anon || !donation.name),
        note: donation.note || '', timestamp: Date.now() });
    }
  },
  cancelOrder({ id }) {
    const o = S.orders.find((x) => x.order_id === id);
    if (!o || o.cancelled) return;
    o.cancelled = true;
    o.items.forEach((l) => { if (prod(l.product_id)?.managed) inv(l.product_id).store += l.qty; });
    S.donations = S.donations.filter((d) => d.order_id !== id);
  },
  cancelDonation({ id }) { S.donations = S.donations.filter((d) => d.donation_id !== id); },
  request({ product_id, qty }) {
    S.requests.push({ id: nid('R'), product_id, qty: qty | 0, status: 'requested', created_at: Date.now() });
  },
  deliver({ id }) {
    const r = S.requests.find((x) => x.id === id);
    if (!r || r.status !== 'requested') return;
    r.status = 'delivering'; const i = inv(r.product_id); i.kitchen -= r.qty; i.transit += r.qty;
  },
  receive({ id }) {
    const r = S.requests.find((x) => x.id === id);
    if (!r || r.status !== 'delivering') return;
    r.status = 'received'; const i = inv(r.product_id); i.transit -= r.qty; i.store += r.qty;
  },
  addKitchen({ product_id, qty }) { inv(product_id).kitchen += qty | 0; },
  setPrice({ id, price }) { const p = prod(id); if (p && price >= 0) p.price = price | 0; },
  adjustStore({ product_id, qty }) { inv(product_id).store = qty | 0; },
  setOpening({ amount }) { S.register.opening = amount | 0; },
  closeRegister({ closing }) {
    S.register.closing = closing | 0; S.register.closedAt = Date.now();
  },
  reopenRegister() { S.register.closing = null; S.register.closedAt = null; },
  reset() { S = initial(); },
};

const clients = new Set();
const broadcast = () => { const m = `data: ${JSON.stringify(S)}\n\n`; clients.forEach((c) => c.write(m)); };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

http.createServer((req, res) => {
  if (req.url === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(S)}\n\n`);
    clients.add(res); req.on('close', () => clients.delete(res)); return;
  }
  if (req.url === '/api/state') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(S)); }
  if (req.url === '/api/action' && req.method === 'POST') {
    let b = ''; req.on('data', (d) => (b += d));
    req.on('end', () => {
      try {
        const { type, ...args } = JSON.parse(b);
        if (!A[type]) throw new Error('unknown action');
        A[type](args); save(); broadcast();
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
      } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    });
    return;
  }
  const f = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : path.normalize(req.url).replace(/^(\.\.[/\\])+/, ''));
  if (f.startsWith(path.join(__dirname, 'public')) && fs.existsSync(f) && fs.statSync(f).isFile()) {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  } else { res.writeHead(404); res.end('not found'); }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`EventPOS 起動: http://localhost:${PORT}`);
  Object.values(os.networkInterfaces()).flat().filter((n) => n.family === 'IPv4' && !n.internal)
    .forEach((n) => console.log(`  同一Wi-Fiの端末から: http://${n.address}:${PORT}`));
});
