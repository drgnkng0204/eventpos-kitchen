// Firestore 上の単一ドキュメント eventpos/state に全状態を保存し、トランザクションで更新する
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getFirestore, doc, onSnapshot, runTransaction } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import cfg from './firebase-config.js';

export const configured = !cfg.apiKey.startsWith('YOUR_');
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

function apply(S, type, a) {
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
        lines.forEach((l) => { if (prod(l.product_id).managed) inv(l.product_id).store -= l.qty; });
      }
      if (donation && donation.amount > 0) {
        const anon = !!(donation.anon || !donation.name);
        S.donations.push({ donation_id: nid('D'), order_id: orderId, amount: donation.amount | 0,
          donor_name: anon ? '匿名' : donation.name, anonymous: anon, note: donation.note || '', timestamp: Date.now() });
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
    request({ product_id, qty }) { S.requests.push({ id: nid('R'), product_id, qty: qty | 0, status: 'requested', created_at: Date.now() }); },
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
    closeRegister({ closing }) { S.register.closing = closing | 0; S.register.closedAt = Date.now(); },
    reopenRegister() { S.register.closing = null; S.register.closedAt = null; },
    reset() { Object.keys(S).forEach((k) => delete S[k]); Object.assign(S, initial()); },
  };
  if (!A[type]) throw new Error('unknown action ' + type);
  A[type](a);
}

let ref;
if (configured) ref = doc(getFirestore(initializeApp(cfg)), 'eventpos', 'state');

window.fbWatch = (cb, status) => {
  if (!configured) { status('config'); return; }
  onSnapshot(ref, { includeMetadataChanges: true }, async (snap) => {
    if (!snap.exists()) { // 初回のみ初期状態を作成
      await runTransaction(ref.firestore, async (t) => { if (!(await t.get(ref)).exists()) t.set(ref, { json: JSON.stringify(initial()) }); });
      return;
    }
    status(snap.metadata.fromCache ? 'offline' : 'online');
    cb(JSON.parse(snap.data().json));
  }, () => status('offline'));
};
window.fbAct = (type, a) => runTransaction(ref.firestore, async (t) => {
  const snap = await t.get(ref);
  const S = snap.exists() ? JSON.parse(snap.data().json) : initial();
  apply(S, type, a);
  t.set(ref, { json: JSON.stringify(S) });
});
window.dispatchEvent(new Event('fb-ready'));
