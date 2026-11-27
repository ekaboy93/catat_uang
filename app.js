'use strict';

window.__DOMPET_V = '9'; // dicek oleh index.html untuk mendeteksi app.js versi lama

/* ================= KONSTANTA ================= */
const STORE = { CONN: 'dompet.conn.v1', QUEUE: 'dompet.queue.v1', CACHE: 'dompet.cache.' };
const FUND = { KAS: 'Kas Harian', VAULT: 'Brankas Darurat' };
const NONEARN = 'Pelunasan Piutang Pinjaman'; // uang kembali, bukan penghasilan
const CATS = {
  Income: ['Jasa', 'Gaji', 'Penjualan', 'Lainnya'],
  Expense: ['Makan', 'Transport', 'Tagihan', 'Belanja', 'Lainnya'],
  Transfer: []
};
const TABS = ['beranda', 'histori', 'statistik', 'buku'];

/* ================= HELPER ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const pad = n => String(n).padStart(2, '0');
const dateStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = d => dateStr(d).slice(0, 7);
const daysIn = (y, m) => new Date(y, m + 1, 0).getDate();
const rp = n => (n < 0 ? '-' : '') + 'Rp ' + Math.abs(Math.round(n)).toLocaleString('id-ID');
const sum = arr => arr.reduce((s, t) => s + t.nominal, 0);
const parseRp = s => Number(String(s).replace(/\D/g, '')) || 0;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const longDate = ds => new Date(ds + 'T00:00:00').toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const shortDate = d => d.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short' });
const pct = (a, b) => (b > 0 ? ((a - b) / b) * 100 : null);
const fmtPct = d => (d == null ? '-' : (d >= 0 ? '+' : '') + Math.round(d) + '%');
const show = id => { const m = $(id); m.classList.remove('hidden'); m.classList.add('flex'); };
const hide = id => { const m = $(id); m.classList.add('hidden'); m.classList.remove('flex'); };
const readJSON = (k, def) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? def : v; } catch (e) { return def; } };
const hashStr = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return (h >>> 0).toString(36); };
const newClientId = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const otherFund = f => (f === FUND.KAS ? FUND.VAULT : FUND.KAS);

/* ---- input nominal: pemisah ribuan otomatis (1.500.000) ---- */
const fmtNum = n => (Number(n) > 0 ? Number(n).toLocaleString('id-ID') : '');
const setMoney = (el, n) => { el.value = fmtNum(n); };
function formatMoneyInput(el) {
  const pos = el.selectionStart == null ? el.value.length : el.selectionStart;
  const digitsBefore = el.value.slice(0, pos).replace(/\D/g, '').length;
  const digits = el.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '').slice(0, 12);
  const out = digits ? Number(digits).toLocaleString('id-ID') : '';
  el.value = out;
  let p = 0, c = 0; // kembalikan posisi kursor setelah titik disisipkan
  while (p < out.length && c < digitsBefore) { if (/\d/.test(out[p])) c++; p++; }
  try { el.setSelectionRange(p, p); } catch (e) { /* abaikan */ }
}
function initMoneyInputs() { // beri awalan "Rp" pada setiap kolom nominal
  $$('input.money').forEach(el => {
    const w = document.createElement('div');
    w.className = 'relative';
    [...el.classList].filter(c => c.startsWith('col-span')).forEach(c => { el.classList.remove(c); w.classList.add(c); });
    el.replaceWith(w);
    w.appendChild(el);
    const tag = document.createElement('span');
    tag.textContent = 'Rp';
    tag.className = 'pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs font-bold text-ink/50';
    w.appendChild(tag);
    el.classList.add('!pl-9');
  });
}
document.addEventListener('input', e => { if (e.target.classList && e.target.classList.contains('money')) formatMoneyInput(e.target); });
const cleanCat = v => { const t = String(v || '').replace(/\s+/g, ' ').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };

const isEarn = t => t.type === 'Income' && t.category !== NONEARN; // penghasilan sungguhan
const isOut = t => t.type === 'Expense';
function applyBal(b, t) { // dampak satu transaksi pada saldo tiap brankas
  if (t.type === 'Transfer') { b[t.sumber] = (b[t.sumber] || 0) - t.nominal; b[t.tujuan] = (b[t.tujuan] || 0) + t.nominal; }
  else b[t.sumber] = (b[t.sumber] || 0) + (t.type === 'Income' ? t.nominal : -t.nominal);
}

let conn = readJSON(STORE.CONN, null); // { url, token } milik pengguna ini
const cacheKey = () => STORE.CACHE + hashStr(conn.url);
const getQueue = () => readJSON(STORE.QUEUE, []);
const setQueue = q => localStorage.setItem(STORE.QUEUE, JSON.stringify(q));

const emptyData = () => ({ transactions: [], hutang: [], bills: [], settings: {}, meta: { windowStart: '0000-00-00', opening: {}, serverVersion: 0 } });
const state = { data: emptyData(), extra: {}, tab: 'beranda', type: 'Expense', statMonth: monthKey(new Date()), budgetPeriod: 'harian', fund: { f: FUND.KAS, e: FUND.KAS }, editType: null };
const picker = { f: { cat: '', adding: false }, e: { cat: '', adding: false }, b: { cat: '', adding: false } }; // pilihan kategori (form, edit, anggaran) // extra: transaksi bulan lama yang dimuat on-demand

const nTx = t => ({ ...t, nominal: Number(t.nominal) || 0, tujuan: t.tujuan || '', refId: t.refId || '', deskripsi: t.deskripsi || '' });
const nHutang = h => ({ ...h, nominal: Number(h.nominal) || 0, terbayar: Number(h.terbayar) || 0 });
const nBill = b => ({ ...b, nominal: Number(b.nominal) || 0, tgl: Number(b.tgl) || 1 });

function normalize(d) {
  d = d || {};
  const meta = d.meta || {};
  const out = {
    transactions: (d.transactions || []).map(nTx),
    hutang: (d.hutang || []).filter(h => h.status === 'Pending').map(nHutang),
    bills: (d.bills || []).map(nBill),
    settings: d.settings || {},
    meta: { windowStart: meta.windowStart || '0000-00-00', opening: meta.opening || {}, serverVersion: meta.serverVersion || 0 }
  };
  const ids = new Set(out.transactions.map(t => t.id));
  getQueue().forEach(q => { // transaksi offline yang belum terkirim tetap terlihat
    if (q.action === 'addTransaction' && !ids.has(q.payload.id)) out.transactions.push({ ...nTx(q.payload), pending: true });
  });
  return out;
}
const parseBudgets = () => { try { return JSON.parse(state.data.settings.Budgets || '{}') || {}; } catch (e) { return {}; } };

/* ---- batas pengeluaran: tarif per hari, jatah menumpuk tiap hari ---- */
const PERIODS = ['harian', 'mingguan', 'bulanan'];
function getBudgets() { // { kategori: {a, p} }; angka polos (format lama) = bulanan
  const out = {};
  Object.entries(parseBudgets()).forEach(([k, v]) => {
    const isObj = v && typeof v === 'object';
    const a = Number(isObj ? v.a : v);
    if (a > 0) out[k] = { a, p: isObj && PERIODS.includes(v.p) ? v.p : 'bulanan' };
  });
  return out;
}
const rateOn = (b, d) => (b.p === 'harian' ? b.a : b.p === 'mingguan' ? b.a / 7 : b.a / daysIn(d.getFullYear(), d.getMonth()));
function budgetEquiv(b, dim) {
  const day = b.p === 'harian' ? b.a : b.p === 'mingguan' ? b.a / 7 : b.a / dim;
  return { day, week: day * 7, month: b.p === 'bulanan' ? b.a : day * dim };
}
const monthLimitFor = (b, y, m) => budgetEquiv(b, daysIn(y, m)).month;

/**
 * Saldo jatah: tiap hari bertambah sebesar tarif harian, dikurangi pengeluaran kategori itu.
 * Saldo positif = boleh belanja segitu. Saldo negatif = sudah dibayar di muka untuk hari-hari ke depan.
 * Sisa jatah (positif) tidak dibawa ke bulan berikutnya; bayar di muka (negatif) dibawa.
 */
function budgetStatus(cat, b, now, tx) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayS = dateStr(today);
  const start = new Date(today.getFullYear(), today.getMonth() - 1, 1); // telusuri sejak awal bulan lalu
  const startS = dateStr(start);
  const catTx = tx.filter(t => isOut(t) && t.category === cat && t.tanggal <= todayS);
  const byDay = {};
  catTx.forEach(t => { if (t.tanggal >= startS) byDay[t.tanggal] = (byDay[t.tanggal] || 0) + t.nominal; });
  let bal = 0;
  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    if (d.getDate() === 1) bal = Math.min(0, bal);
    bal += rateOn(b, d) - (byDay[dateStr(d)] || 0);
  }
  if (Math.abs(bal) < 0.5) bal = 0;
  const rate = rateOn(b, today);
  const weekStartS = dateStr(new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7))); // minggu mulai Senin
  const weekSpent = sum(catTx.filter(t => t.tanggal >= weekStartS));
  const monthSpent = sum(catTx.filter(t => t.tanggal.startsWith(monthKey(today))));
  const monthLimit = b.p === 'bulanan' ? b.a : rate * daysIn(today.getFullYear(), today.getMonth());
  const weekLimit = rate * 7;
  const back = new Date(today);
  if (bal < 0) back.setDate(back.getDate() + Math.floor(-bal / rate) + 1); // hari pertama saldo kembali positif
  return { cat, b, rate, bal, todaySpent: byDay[todayS] || 0, weekSpent, weekLimit, monthSpent, monthLimit,
    ratioW: weekSpent / weekLimit, ratioM: monthSpent / monthLimit, aheadDays: bal < 0 ? -bal / rate : 0, backDate: back };
}

/* ================= UI KECIL ================= */
function toast(msg, kind) {
  const el = document.createElement('div');
  el.className = 'rounded-xl px-4 py-2 text-sm font-semibold text-white shadow-lg ' + (kind === 'error' ? 'bg-rust' : 'bg-ink');
  el.textContent = msg;
  $('#toast').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
let busyCount = 0;
function setBusy(on) {
  busyCount = Math.max(0, busyCount + (on ? 1 : -1));
  $('#busy').style.transform = busyCount > 0 ? 'scaleX(.85)' : 'scaleX(0)';
  $$('button[type=submit]:not([data-guard])').forEach(b => (b.disabled = busyCount > 0));
}

/* ================= API ================= */
async function call(action, payload) {
  const res = await fetch(conn.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // tanpa preflight CORS
    body: JSON.stringify({ action, token: conn.token, payload: payload || {} })
  });
  if (!res.ok) throw new Error('Server error ' + res.status);
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Permintaan gagal');
  return json.data;
}
const isNetErr = e => e instanceof TypeError;
const monthStart = off => { const d = new Date(); return dateStr(new Date(d.getFullYear(), d.getMonth() - off, 1)); };

/** Simpan salinan offline. Bila penyimpanan penuh, data lama dilipat ke saldo awal (hanya 3 bulan terakhir disimpan). */
function saveCache() {
  const d = state.data;
  const attempt = cut => {
    let tx = d.transactions.filter(t => !t.pending);
    const opening = { ...d.meta.opening };
    if (cut) { tx.filter(t => t.tanggal < cut).forEach(t => applyBal(opening, t)); tx = tx.filter(t => t.tanggal >= cut); }
    localStorage.setItem(cacheKey(), JSON.stringify({ ...d, transactions: tx, meta: { ...d.meta, windowStart: cut || d.meta.windowStart, opening } }));
  };
  try { attempt(); } catch (e) { try { attempt(monthStart(2)); } catch (e2) { /* abaikan */ } }
}

/** Terapkan perubahan kecil dari server tanpa memuat ulang semua data. */
function applyPatch(p) {
  if (!p) return;
  const d = state.data;
  const upsert = (arr, items, norm) => (items || []).forEach(x => {
    const n = norm(x), i = arr.findIndex(y => y.id === n.id);
    if (i >= 0) arr[i] = n; else arr.push(n);
  });
  const remove = (arr, ids) => (ids || []).forEach(id => { const i = arr.findIndex(y => y.id === id); if (i >= 0) arr.splice(i, 1); });
  if (p.tx) { upsert(d.transactions, p.tx.upsert, nTx); remove(d.transactions, p.tx.remove); }
  if (p.hutang) {
    (p.hutang.upsert || []).forEach(h => { if (h.status === 'Pending') upsert(d.hutang, [h], nHutang); else remove(d.hutang, [h.id]); });
    remove(d.hutang, p.hutang.remove);
  }
  if (p.bills) { upsert(d.bills, p.bills.upsert, nBill); remove(d.bills, p.bills.remove); }
  if (p.settings) d.settings = p.settings;
}

async function flushQueue() {
  const q = getQueue();
  if (!q.length || !navigator.onLine) return;
  const rest = [];
  for (const item of q) {
    try { applyPatch(await call(item.action, item.payload)); }
    catch (e) {
      if (isNetErr(e)) rest.push(item);
      else toast('Catatan offline ditolak server: ' + e.message, 'error');
    }
  }
  setQueue(rest);
}

async function loadData() {
  if (!conn) return;
  setBusy(true);
  try {
    await flushQueue();
    state.data = normalize(await call('getAll'));
    saveCache();
    $('#offline-banner').classList.add('hidden');
  } catch (e) {
    if (String(e.message).includes('Token tidak valid')) showConnect('Token ditolak. Periksa kembali token Anda.');
    const cached = readJSON(cacheKey(), null);
    if (cached) { state.data = normalize(cached); $('#offline-banner').classList.remove('hidden'); }
    else toast(e.message, 'error');
  } finally {
    setBusy(false);
    render();
  }
}

async function mutate(action, payload, okMsg) {
  if (action === 'addTransaction' && !payload.id) payload = { ...payload, id: newClientId() };
  const queueIt = () => {
    setQueue([...getQueue(), { action, payload }]);
    state.data.transactions.push({ ...nTx(payload), pending: true });
    render();
    toast('Disimpan offline, akan disinkronkan saat online');
    return true;
  };
  if (!navigator.onLine) {
    if (action === 'addTransaction') return queueIt();
    toast('Tidak ada koneksi. Aksi ini butuh internet.', 'error');
    return false;
  }
  setBusy(true);
  try {
    await flushQueue();
    applyPatch(await call(action, payload));
    saveCache();
    $('#offline-banner').classList.add('hidden');
    if (okMsg) toast(okMsg);
    try { render(); } catch (err) { setTimeout(() => { throw err; }); } // galat tampilan tidak boleh menutupi keberhasilan aksi
    return true;
  } catch (e) {
    if (action === 'addTransaction' && isNetErr(e)) return queueIt();
    toast(e.message, 'error');
    return false;
  } finally {
    setBusy(false);
  }
}

/* ================= PERHITUNGAN ================= */
function compute() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth();
  const totalDays = daysIn(y, m);
  const dayNow = now.getDate();
  const sisaHari = Math.max(1, totalDays - dayNow + 1); // termasuk hari ini
  const today = dateStr(now);
  const prefix = monthKey(now);
  const { transactions: tx, bills, settings } = state.data;

  const monthTx = tx.filter(t => t.tanggal.startsWith(prefix));
  const incomeBefore = sum(monthTx.filter(t => isEarn(t) && t.tanggal < today));
  const incomeToday = sum(tx.filter(t => isEarn(t) && t.tanggal === today));

  const bal = { ...(state.data.meta.opening || {}) }; // saldo awal (transaksi lama) + transaksi di jendela data
  tx.forEach(t => applyBal(bal, t));
  const kas = bal[FUND.KAS] || 0;
  const vault = bal[FUND.VAULT] || 0;

  const living = Number(settings.MonthlyLivingCost) || 0;
  const emergMonths = settings.EmergencyMonths === '' || settings.EmergencyMonths == null ? 6 : Number(settings.EmergencyMonths);
  const vaultMonths = living > 0 ? vault / living : null;
  const vaultPct = living > 0 && emergMonths > 0 ? Math.max(0, Math.min(100, (vault / (living * emergMonths)) * 100)) : 0;

  const billRows = bills.map(b => { // lunas bila ada pengeluaran bulan ini yang menautkan RefID tagihan
    const paid = sum(monthTx.filter(t => isOut(t) && t.refId === b.id));
    const due = Math.min(b.tgl, totalDays);
    return { ...b, paid, remaining: Math.max(0, b.nominal - paid), due, daysLeft: due - dayNow };
  });
  const totalBills = sum(bills);
  const sisaTagihan = billRows.reduce((s, b) => s + b.remaining, 0);

  const targetBulan = living + totalBills;
  const lowerBound = targetBulan / totalDays;
  const resetOn = settings.ResetMode === 'ON';
  const deficit = Math.max(0, (targetBulan * (dayNow - 1)) / totalDays - incomeBefore); // kekurangan dibanding jalur linear

  let daily;
  if (resetOn) daily = sisaTagihan / sisaHari + living / totalDays; // amnesti defisit
  else daily = Math.max((targetBulan - incomeBefore) / sisaHari, lowerBound);
  daily = Math.ceil(Math.max(0, daily));

  const [rcMonth, rcN] = String(settings.ResetCount || '').split('|');
  const resetCount = rcMonth === prefix ? Number(rcN) || 0 : 0;

  const budgetRows = Object.entries(getBudgets()).map(([cat, b]) => budgetStatus(cat, b, now, tx));

  return {
    totalDays, sisaHari, kas, vault, living, emergMonths, vaultMonths, vaultPct, billRows, totalBills, sisaTagihan, targetBulan, lowerBound,
    resetOn, resetCount, deficit, daily, incomeToday, budgetRows,
    safeSpend: Math.max(0, (kas - sisaTagihan) / sisaHari),
    progress: daily > 0 ? Math.min(100, (incomeToday / daily) * 100) : 100
  };
}

const winMonth = () => (state.data.meta.windowStart || '0000-00').slice(0, 7);
function txOfMonth(key) {
  return key >= winMonth() ? state.data.transactions.filter(t => t.tanggal.startsWith(key)) : (state.extra[key] || []);
}
/** Muat bulan lama (di luar jendela 12 bulan) bila dipilih di Statistik. */
async function ensureStatData() {
  const [y, m] = state.statMonth.split('-').map(Number);
  const keys = [state.statMonth, monthKey(new Date(y, m - 2, 1))].filter(k => k < winMonth() && !state.extra[k]);
  if (!keys.length) return;
  setBusy(true);
  try {
    const res = await call('getMonths', { months: keys });
    Object.entries(res.months).forEach(([k, v]) => { state.extra[k] = v.map(nTx); });
  } catch (e) { toast('Gagal memuat data bulan lama: ' + e.message, 'error'); }
  finally { setBusy(false); }
  renderStatistik(compute());
}

function aggMonth(key) {
  const tx = txOfMonth(key).filter(t => t.type !== 'Transfer');
  const cats = {};
  let inn = 0, out = 0, noearn = 0;
  tx.forEach(t => {
    if (t.type === 'Income') { if (isEarn(t)) inn += t.nominal; else noearn += t.nominal; }
    else { out += t.nominal; cats[t.category] = (cats[t.category] || 0) + t.nominal; }
  });
  return { inn, out, noearn, cats };
}

/* ================= RENDER ================= */
function render() {
  const c = compute();
  $('#today-label').textContent = longDate(dateStr(new Date())) + ' \u00b7 v' + window.__DOMPET_V;
  renderBeranda(c);
  renderBudgetCard(c);
  renderHistori();
  renderStatistik(c);
  renderBuku();
  renderSettings();
  renderTabs();
}

function renderBeranda(c) {
  $('#bal-kas').textContent = rp(c.kas);
  $('#bal-vault').textContent = rp(c.vault);
  $('#vault-bar').style.width = c.vaultPct + '%';
  $('#vault-note').textContent = c.vaultMonths == null
    ? 'Isi biaya hidup di Pengaturan untuk melihat ketahanan dana.'
    : `Cukup ${c.vaultMonths.toFixed(1)} bulan hidup, target ${c.emergMonths} bulan`;
  $('#safe-spend').textContent = rp(c.safeSpend);
  $('#safe-note').textContent = `Saldo Kas Harian dikurangi sisa tagihan, dibagi ${c.sisaHari} hari tersisa.`;

  $('#target-badge').textContent = rp(c.daily);
  $('#target-mode').textContent = c.resetOn ? 'Mode reset: kekurangan masa lalu diabaikan.' : `Mode standar, batas bawah ${rp(c.lowerBound)} per hari.`;
  const notes = [];
  if (c.deficit > 0) notes.push(`Defisit target terkumpul ${rp(c.deficit)}${c.resetOn ? ' (diabaikan oleh reset)' : ' (ditutup lewat target harian)'}.`);
  if (c.resetCount > 0) notes.push(`Reset diaktifkan ${c.resetCount}x bulan ini.`);
  $('#debt-note').textContent = notes.join(' ');
  $('#reset-label').textContent = c.resetOn ? 'Reset aktif' : 'Standar';
  $('#reset-toggle').setAttribute('aria-pressed', String(c.resetOn));
  $('#reset-track').className = 'relative inline-block h-5 w-9 rounded-full transition ' + (c.resetOn ? 'bg-saffron' : 'bg-mist');
  $('#reset-knob').style.transform = c.resetOn ? 'translateX(16px)' : 'translateX(0)';
  $('#progress-bar').style.width = c.progress + '%';
  $('#progress-text').textContent = `${rp(c.incomeToday)} dari ${rp(c.daily)} (${Math.round(c.progress)}%)`;

  const alerts = [];
  c.billRows.filter(b => b.remaining > 0 && b.daysLeft <= 3).sort((a, b) => a.daysLeft - b.daysLeft).forEach(b => {
    const when = b.daysLeft < 0 ? `terlambat ${-b.daysLeft} hari` : b.daysLeft === 0 ? 'jatuh tempo hari ini' : `jatuh tempo ${b.daysLeft} hari lagi`;
    alerts.push({ k: b.daysLeft < 0 ? 'border-rust' : 'border-saffron', t: `${b.nama} ${when} (${rp(b.remaining)})` });
  });
  c.budgetRows.forEach(r => {
    if (r.ratioM >= 0.8) alerts.push({ k: r.ratioM >= 1 ? 'border-rust' : 'border-saffron', t: `Batas ${r.cat} bulan ini ${Math.round(r.ratioM * 100)}% terpakai (${rp(r.monthSpent)} dari ${rp(r.monthLimit)})` });
    else if (r.ratioW >= 1) alerts.push({ k: 'border-rust', t: `Batas ${r.cat} minggu ini terlampaui (${rp(r.weekSpent)} dari ${rp(r.weekLimit)})` });
  });
  const nq = getQueue().length;
  if (nq) alerts.push({ k: 'border-ink/40', t: `${nq} transaksi menunggu sinkron` });
  $('#alerts').innerHTML = alerts.map(a => `<div class="rounded-xl border-l-4 ${a.k} bg-white px-3 py-2 text-xs font-semibold shadow-sm">${esc(a.t)}</div>`).join('');

  const open = c.billRows.filter(b => b.remaining > 0).sort((a, b) => a.daysLeft - b.daysLeft);
  $('#bill-list').innerHTML = open.length
    ? open.map(b => {
        const late = b.daysLeft < 0;
        const label = b.daysLeft === 0 ? 'Jatuh tempo hari ini' : late ? `Terlambat ${-b.daysLeft} hari` : `${b.daysLeft} hari lagi (tgl ${b.due})`;
        return `<li class="flex items-center justify-between gap-3 border-b border-mist py-3 last:border-0">
          <div><p class="font-semibold">${esc(b.nama)}</p><p class="text-xs ${late ? 'font-semibold text-rust' : 'text-ink/60'}">${label}${b.paid > 0 ? ' - sudah dibayar ' + rp(b.paid) : ''}</p></div>
          <div class="text-right"><p class="font-bold">${rp(b.remaining)}</p>
            <button data-act="pay-bill" data-id="${esc(b.id)}" class="text-xs font-semibold text-kas">Bayar</button></div></li>`;
      }).join('')
    : `<li class="py-3 text-sm text-ink/60">${c.billRows.length ? 'Semua tagihan bulan ini sudah lunas.' : 'Belum ada tagihan. Tambahkan lewat Pengaturan.'}</li>`;
}

function renderBudgetCard(c) {
  const bar = (label, spent, limit, ratio) => `<div><div class="flex justify-between text-[11px]"><span class="text-ink/60">${label}</span><span class="font-semibold">${rp(spent)} / ${rp(limit)}</span></div>
    <div class="mt-0.5 h-1.5 overflow-hidden rounded-full bg-mist"><div class="h-full rounded-full ${ratio >= 1 ? 'bg-rust' : ratio >= 0.8 ? 'bg-saffron' : 'bg-kas'}" style="width:${Math.min(100, ratio * 100)}%"></div></div></div>`;
  const dateLbl = d => d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
  $('#budget-list').innerHTML = c.budgetRows.length ? c.budgetRows.map(r => {
    const daily = r.bal >= 0
      ? `<p class="mt-1 text-xs font-semibold text-kas">Hari ini aman, tersedia ${rp(r.bal)}${r.todaySpent > 0 ? ` <span class="font-normal text-ink/60">(terpakai ${rp(r.todaySpent)})</span>` : ''}</p>`
      : `<p class="mt-1 text-xs font-semibold text-ink">Terbayar di muka ${rp(-r.bal)} <span class="font-normal text-ink/60">(setara ${r.aheadDays.toLocaleString('id-ID', { maximumFractionDigits: 1 })} hari)</span>. Jatah tersedia lagi ${dateLbl(r.backDate)}.</p>`;
    return `<div><div class="flex items-baseline justify-between"><p class="text-sm font-bold">${esc(r.cat)}</p><p class="text-xs text-ink/60">${rp(r.rate)}/hari</p></div>${daily}
      <div class="mt-2 space-y-1.5">${bar('Minggu ini', r.weekSpent, r.weekLimit, r.ratioW)}${bar('Bulan ini', r.monthSpent, r.monthLimit, r.ratioM)}</div></div>`;
  }).join('') : '<p class="text-sm text-ink/60">Belum ada batas. Tekan Atur, misalnya Bensin Rp 15.000 per hari. Beli sekaligus untuk beberapa hari tetap aman.</p>';
}

function txRow(t) {
  if (t.type === 'Transfer') {
    return `<li class="flex items-center justify-between gap-3 border-b border-mist py-3 last:border-0">
      <div class="min-w-0"><p class="truncate text-sm font-semibold">Transfer${t.deskripsi ? ' <span class="font-normal text-ink/60">- ' + esc(t.deskripsi) + '</span>' : ''}</p>
        <p class="text-xs font-semibold text-ink/60">${esc(t.sumber)} ke ${esc(t.tujuan)}</p></div>
      <div class="shrink-0 text-right"><p class="text-sm font-bold text-ink/70">${rp(t.nominal)}</p>${rowButtons(t)}</div></li>`;
  }
  const inc = t.type === 'Income';
  const tag = !isEarn(t) && inc ? ' <span class="rounded bg-mist px-1 text-[10px] font-semibold text-ink/70">bukan penghasilan</span>' : '';
  const pend = t.pending ? ' <span class="rounded bg-saffron/20 px-1 text-[10px] font-semibold">menunggu sinkron</span>' : '';
  return `<li class="flex items-center justify-between gap-3 border-b border-mist py-3 last:border-0">
    <div class="min-w-0"><p class="truncate text-sm font-semibold">${esc(t.category)}${t.deskripsi ? ' <span class="font-normal text-ink/60">- ' + esc(t.deskripsi) + '</span>' : ''}</p>
      <p class="text-xs"><span class="${t.sumber === FUND.KAS ? 'text-kas' : 'text-vault'} font-semibold">${esc(t.sumber)}</span>${tag}${pend}</p></div>
    <div class="shrink-0 text-right"><p class="text-sm font-bold ${inc ? 'text-kas' : 'text-rust'}">${inc ? '+' : '-'}${rp(t.nominal)}</p>${rowButtons(t)}</div></li>`;
}
const rowButtons = t => `<div class="flex justify-end gap-3 text-xs text-ink/50">
  <button data-act="edit-tx" data-id="${esc(t.id)}">Edit</button><button data-act="del-tx" data-id="${esc(t.id)}">Hapus</button></div>`;

function renderHistori() {
  const list = [...state.data.transactions].map((t, i) => ({ ...t, _i: i }))
    .sort((a, b) => (a.tanggal < b.tanggal ? 1 : a.tanggal > b.tanggal ? -1 : b._i - a._i)).slice(0, 100);
  if (!list.length) { $('#history-list').innerHTML = '<div class="card text-sm text-ink/60">Belum ada transaksi. Catat yang pertama di Beranda.</div>'; return; }
  const groups = {};
  list.forEach(t => (groups[t.tanggal] = groups[t.tanggal] || []).push(t));
  $('#history-list').innerHTML = Object.keys(groups).sort().reverse().map(d => {
    const items = groups[d];
    const inn = sum(items.filter(isEarn)), out = sum(items.filter(isOut)), net = inn - out;
    return `<div class="card !p-0 overflow-hidden">
      <div class="bg-ink px-4 py-2.5 text-white">
        <p class="text-sm font-bold">${esc(longDate(d))}</p>
        <div class="mt-1 flex justify-between text-xs text-white/80"><span>In ${rp(inn)}</span><span>Out ${rp(out)}</span>
          <span class="font-bold ${net < 0 ? 'text-[#F4B1A6]' : 'text-[#9AE0D6]'}">Net ${rp(net)}</span></div>
      </div>
      <ul class="px-4">${items.map(txRow).join('')}</ul></div>`;
  }).join('');
}

function renderStatistik(c) {
  const mInput = $('#stat-month');
  if (mInput.value !== state.statMonth) mInput.value = state.statMonth;
  const cur = aggMonth(state.statMonth);
  const [sy, sm] = state.statMonth.split('-').map(Number);
  const prev = aggMonth(monthKey(new Date(sy, sm - 2, 1)));
  const net = cur.inn - cur.out;
  const tp = c.targetBulan > 0 ? (cur.inn / c.targetBulan) * 100 : null;

  $('#stat-cards').innerHTML = `
    <div class="grid grid-cols-3 gap-2 text-center">
      <div class="rounded-xl bg-paper p-2.5"><p class="text-[11px] text-ink/60">Total In</p><p class="text-sm font-extrabold text-kas">${rp(cur.inn)}</p></div>
      <div class="rounded-xl bg-paper p-2.5"><p class="text-[11px] text-ink/60">Total Out</p><p class="text-sm font-extrabold text-rust">${rp(cur.out)}</p></div>
      <div class="rounded-xl bg-paper p-2.5"><p class="text-[11px] text-ink/60">Net bersih</p><p class="text-sm font-extrabold ${net < 0 ? 'text-rust' : 'text-ink'}">${rp(net)}</p></div>
    </div>
    <div class="mt-3"><div class="mb-1 flex justify-between text-xs"><span class="text-ink/60">Pencapaian target bulanan (${rp(c.targetBulan)})</span><span class="font-bold">${tp == null ? '-' : Math.round(tp) + '%'}</span></div>
      <div class="h-2.5 overflow-hidden rounded-full bg-mist"><div class="h-full rounded-full bg-saffron transition-all duration-500" style="width:${tp == null ? 0 : Math.min(100, tp)}%"></div></div></div>`;

  const dIn = pct(cur.inn, prev.inn), dOut = pct(cur.out, prev.out);
  $('#stat-compare').innerHTML = `
    <p class="text-ink/70">Dibanding bulan lalu: pemasukan <b class="${dIn != null && dIn < 0 ? 'text-rust' : 'text-kas'}">${fmtPct(dIn)}</b>, pengeluaran <b class="${dOut != null && dOut > 0 ? 'text-rust' : 'text-kas'}">${fmtPct(dOut)}</b></p>
    ${cur.noearn > 0 ? `<p class="text-ink/60">Di luar Total In: pelunasan pinjaman ${rp(cur.noearn)} (bukan penghasilan).</p>` : ''}`;

  const entries = Object.entries(cur.cats).sort((a, b) => b[1] - a[1]);
  const budgets = Object.fromEntries(Object.entries(getBudgets()).map(([k, b]) => [k, monthLimitFor(b, sy, sm - 1)]));
  const insights = [];
  if (net < 0) insights.push('Pengeluaran melebihi pemasukan bulan ini.');
  if (dOut != null && dOut > 10) insights.push(`Pengeluaran naik ${Math.round(dOut)}% dari bulan lalu.`);
  const rises = entries.filter(([k, v]) => (prev.cats[k] || 0) > 0 && v > prev.cats[k] * 1.2).sort((a, b) => (b[1] - prev.cats[b[0]]) - (a[1] - prev.cats[a[0]]));
  if (rises.length) insights.push(`${rises[0][0]} naik ${Math.round(pct(rises[0][1], prev.cats[rises[0][0]]))}% (${rp(rises[0][1] - prev.cats[rises[0][0]])}) dari bulan lalu.`);
  if (entries.length && cur.out > 0 && entries[0][1] / cur.out >= 0.4) insights.push(`${entries[0][0]} menyedot ${Math.round((entries[0][1] / cur.out) * 100)}% dari seluruh pengeluaran.`);
  Object.entries(budgets).forEach(([k, lim]) => { if ((cur.cats[k] || 0) > lim) insights.push(`Anggaran ${k} terlampaui ${rp(cur.cats[k] - lim)}.`); });
  const ul = $('#stat-insight');
  ul.classList.toggle('hidden', !insights.length);
  ul.innerHTML = insights.slice(0, 4).map(t => `<li>${esc(t)}</li>`).join('');

  $('#stat-cats').innerHTML = entries.length ? entries.map(([k, v]) => {
    const share = cur.out > 0 ? (v / cur.out) * 100 : 0;
    const d = pct(v, prev.cats[k] || 0);
    const lim = budgets[k];
    const ratio = lim ? v / lim : 0;
    return `<div><div class="mb-1 flex justify-between text-xs"><span class="font-semibold">${esc(k)} <span class="font-normal text-ink/60">${Math.round(share)}%${d != null ? ', ' + fmtPct(d) + ' vs bulan lalu' : ''}</span></span><span class="font-bold">${rp(v)}</span></div>
      <div class="h-2 overflow-hidden rounded-full bg-mist"><div class="h-full rounded-full bg-vault" style="width:${share}%"></div></div>
      ${lim ? `<div class="mt-1 flex items-center gap-2 text-[11px] text-ink/60"><div class="h-1.5 flex-1 overflow-hidden rounded-full bg-mist"><div class="h-full rounded-full ${ratio >= 1 ? 'bg-rust' : ratio >= 0.8 ? 'bg-saffron' : 'bg-kas'}" style="width:${Math.min(100, ratio * 100)}%"></div></div>anggaran ${Math.round(ratio * 100)}% dari ${rp(lim)}</div>` : ''}</div>`;
  }).join('') : '<p class="text-sm text-ink/60">Belum ada pengeluaran di bulan ini.</p>';

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const items = state.data.transactions.filter(t => t.tanggal === dateStr(d));
    days.push({ d, net: sum(items.filter(isEarn)) - sum(items.filter(isOut)) });
  }
  const maxAbs = Math.max(1, ...days.map(x => Math.abs(x.net)));
  const total = days.reduce((s, x) => s + x.net, 0);
  $('#stat-week').innerHTML = days.map(x => {
    const w = (Math.abs(x.net) / maxAbs) * 100;
    return `<div class="flex items-center gap-2 text-xs"><span class="w-20 shrink-0 text-ink/60">${esc(shortDate(x.d))}</span>
      <div class="grid h-2 flex-1 grid-cols-2"><div class="flex justify-end"><div class="rounded-l bg-rust" style="width:${x.net < 0 ? w : 0}%"></div></div>
        <div><div class="rounded-r bg-kas" style="width:${x.net > 0 ? w : 0}%"></div></div></div>
      <span class="w-24 shrink-0 text-right font-semibold ${x.net < 0 ? 'text-rust' : x.net > 0 ? 'text-kas' : 'text-ink/50'}">${rp(x.net)}</span></div>`;
  }).join('') + `<p class="border-t border-mist pt-2 text-xs font-bold">Total 7 hari: <span class="${total < 0 ? 'text-rust' : 'text-kas'}">${rp(total)}</span></p>`;
}

function renderBuku() {
  const pending = state.data.hutang.filter(h => h.status === 'Pending');
  $('#hp-list').innerHTML = pending.length ? pending.map(h => {
    const isHutang = h.tipe === 'Hutang';
    const sisa = h.nominal - h.terbayar;
    return `<li class="border-b border-mist py-3 last:border-0">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0"><p class="text-sm font-semibold">${esc(h.nama)}</p>
          <p class="text-xs"><span class="font-semibold ${isHutang ? 'text-rust' : 'text-kas'}">${esc(h.tipe)}</span> <span class="text-ink/60">- ${esc(h.tanggal)}</span></p>
          ${h.catatan ? `<p class="truncate text-xs text-ink/60">${esc(h.catatan)}</p>` : ''}</div>
        <div class="shrink-0 text-right"><p class="text-sm font-bold">${rp(sisa)}</p>
          ${h.terbayar > 0 ? `<p class="text-[11px] text-ink/60">dari ${rp(h.nominal)}</p>` : ''}</div></div>
      <div class="mt-2 flex justify-end gap-2">
        <button data-act="cicil" data-id="${esc(h.id)}" class="rounded-lg border border-mist px-2.5 py-1 text-xs font-semibold">${isHutang ? 'Bayar sebagian' : 'Terima sebagian'}</button>
        <button data-act="settle" data-id="${esc(h.id)}" class="rounded-lg bg-ink px-2.5 py-1 text-xs font-semibold text-white">Tandai Lunas</button></div></li>`;
  }).join('') : '<li class="py-3 text-sm text-ink/60">Tidak ada hutang atau piutang yang tertunda.</li>';
}

function renderSettings() {
  const set = (id, v) => { const el = $(id); if (document.activeElement !== el) el.value = v; };
  set('#set-living', fmtNum(state.data.settings.MonthlyLivingCost));
  set('#set-emerg', state.data.settings.EmergencyMonths === '' || state.data.settings.EmergencyMonths == null ? 6 : state.data.settings.EmergencyMonths);
  $('#settings-bills').innerHTML = state.data.bills.length
    ? state.data.bills.map(b => `<li class="flex items-center justify-between border-b border-mist py-2.5 text-sm last:border-0">
        <span><span class="font-semibold">${esc(b.nama)}</span> <span class="text-xs text-ink/60">tgl ${b.tgl}</span></span>
        <span class="flex items-center gap-3"><span class="font-bold">${rp(b.nominal)}</span>
          <button data-act="del-bill" data-id="${esc(b.id)}" class="text-xs text-rust">Hapus</button></span></li>`).join('')
    : '<li class="py-2 text-sm text-ink/60">Belum ada tagihan tetap.</li>';
  const bud = Object.entries(getBudgets());
  const nowD = new Date(), dimN = daysIn(nowD.getFullYear(), nowD.getMonth());
  $('#settings-budgets').innerHTML = bud.length
    ? bud.map(([k, b]) => { const q = budgetEquiv(b, dimN); return `<li class="flex items-center justify-between gap-3 border-b border-mist py-2.5 text-sm last:border-0">
        <span class="min-w-0"><span class="block font-semibold">${esc(k)}</span><span class="block text-xs text-ink/60">${rp(q.day)}/hari - ${rp(q.week)}/minggu - ${rp(q.month)}/bulan</span></span>
        <span class="flex shrink-0 items-center gap-3"><button data-act="edit-budget" data-id="${esc(k)}" class="text-xs font-semibold text-kas">Ubah</button><button data-act="del-budget" data-id="${esc(k)}" class="text-xs text-rust">Hapus</button></span></li>`; }).join('')
    : '<li class="py-2 text-sm text-ink/60">Belum ada batas.</li>';
}

function renderTabs() {
  $$('section[id^=tab-]').forEach(s => s.classList.toggle('hidden', s.id !== 'tab-' + state.tab));
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab));
  const on = 'text-white ', off = 'text-ink/60';
  const cls = (type, bg) => 'rounded-lg py-2 text-sm font-semibold ' + (state.type === type ? bg + ' ' + on : off);
  $('#type-expense').className = cls('Expense', 'bg-rust');
  $('#type-income').className = cls('Income', 'bg-kas');
  $('#type-transfer').className = cls('Transfer', 'bg-vault');
  renderPickers();
}

/* ---- pemilih kategori (chip) & sumber dana (segmen) ---- */
function catOptions(type) {
  const seen = new Set(CATS[type] || []);
  state.data.transactions.forEach(t => {
    if (t.type === type && t.category && t.category !== 'Transfer' && !t.category.startsWith('Pelunasan ')) seen.add(t.category);
  });
  if (type === 'Expense') Object.keys(parseBudgets()).forEach(k => seen.add(k));
  return [...seen];
}
function chipBtn(p, label, active, act, extra) {
  return `<button type="button" data-act="${act}" data-p="${p}" ${extra || ''} aria-pressed="${active}" class="rounded-full border px-3 py-1.5 text-xs font-semibold transition ${active ? 'border-ink bg-ink text-white' : 'border-mist bg-white text-ink/70'}">${label}</button>`;
}
function renderChips(p, type) {
  const st = picker[p];
  $(`#${p}-chips`).innerHTML = catOptions(type).map(c => chipBtn(p, esc(c), !st.adding && st.cat === c, 'pick-cat', `data-cat="${esc(c)}"`)).join('')
    + chipBtn(p, '+ Baru', st.adding, 'new-cat');
  $(`#${p}-cat-new`).classList.toggle('hidden', !st.adding);
}
function renderFund(p) {
  const cur = state.fund[p];
  [['kas', FUND.KAS, 'bg-kas'], ['vault', FUND.VAULT, 'bg-vault']].forEach(([k, name, bg]) => {
    const b = $(`#${p}-fund-${k}`);
    b.className = 'rounded-lg py-2 text-sm font-semibold transition ' + (cur === name ? bg + ' text-white' : 'text-ink/60');
    b.setAttribute('aria-pressed', String(cur === name));
  });
}
function renderPickers() {
  const tr = state.type === 'Transfer';
  $('#f-cat-wrap').classList.toggle('hidden', tr);
  if (!tr) renderChips('f', state.type);
  renderChips('b', 'Expense');
  renderFund('f');
  renderFund('e');
  $('#f-fund-label').textContent = tr ? 'Pindahkan dari' : state.type === 'Income' ? 'Masuk ke' : 'Dibayar dari';
  const note = $('#f-transfer-note');
  note.classList.toggle('hidden', !tr);
  note.textContent = tr ? `Dipindahkan ke ${otherFund(state.fund.f)}` : '';
  renderBudgetForm();
  if (state.editType) {
    const trE = state.editType === 'Transfer';
    if (!trE) renderChips('e', state.editType);
    const en = $('#e-transfer-note');
    en.classList.toggle('hidden', !trE);
    en.textContent = trE ? `Dipindahkan ke ${otherFund(state.fund.e)}` : '';
  }
}
function renderBudgetForm() {
  const labels = { harian: 'Batas per hari', mingguan: 'Batas per minggu', bulanan: 'Batas per bulan' };
  PERIODS.forEach(p => {
    const b = $('#bp-' + p), on = state.budgetPeriod === p;
    b.className = 'rounded-lg py-2 text-xs font-semibold transition ' + (on ? 'bg-ink text-white' : 'text-ink/60');
    b.setAttribute('aria-pressed', String(on));
  });
  const inp = $('#bud-limit');
  inp.placeholder = labels[state.budgetPeriod];
  inp.setAttribute('aria-label', labels[state.budgetPeriod]);
  const a = parseRp(inp.value), eq = $('#b-equiv');
  if (a > 0) {
    const d = new Date(), q = budgetEquiv({ a, p: state.budgetPeriod }, daysIn(d.getFullYear(), d.getMonth()));
    eq.textContent = `Setara ${rp(q.day)}/hari - ${rp(q.week)}/minggu - ${rp(q.month)}/bulan`;
  } else eq.textContent = 'Beli sekaligus tidak masalah: Beranda menunjukkan berapa hari ke depan yang sudah terbayar di muka.';
}
$('#bud-limit').addEventListener('input', renderBudgetForm);
const pickedCat = p => (picker[p].adding ? cleanCat($(`#${p}-cat-new`).value) : picker[p].cat);
const resetPicker = p => { picker[p] = { cat: '', adding: false }; $(`#${p}-cat-new`).value = ''; };

function setTab(tab) {
  state.tab = tab;
  history.replaceState(null, '', '#' + tab);
  renderTabs();
  window.scrollTo({ top: 0 });
}

/* ================= KONEKSI (setiap pengguna memakai Sheet sendiri) ================= */
function showConnect(msg) {
  const err = $('#c-error');
  err.textContent = msg || '';
  err.classList.toggle('hidden', !msg);
  if (conn) { $('#c-url').value = conn.url; $('#c-token').value = ''; }
  show('#modal-connect');
}

$('#connect-form').addEventListener('submit', async e => {
  e.preventDefault();
  const url = $('#c-url').value.trim(), token = $('#c-token').value.trim();
  if (!/^https:\/\/script\.google\.com\/(a\/[^/]+\/)?macros\/s\/[^/]+\/exec$/.test(url)) return showConnect('URL harus berupa URL web app Apps Script yang berakhiran /exec.');
  const prev = conn;
  conn = { url, token };
  setBusy(true);
  try {
    const raw = await call('getAll');
    localStorage.setItem(STORE.CONN, JSON.stringify(conn));
    state.data = normalize(raw);
    state.extra = {};
    saveCache();
    $('#c-error').classList.add('hidden');
    hide('#modal-connect');
    render();
    toast('Terhubung ke Google Sheet Anda');
  } catch (err) {
    conn = prev;
    showConnect('Gagal terhubung: ' + (isNetErr(err) ? 'periksa URL dan koneksi internet' : err.message));
  } finally {
    setBusy(false);
  }
});

/* ================= EVENT ================= */
function openEdit(id) {
  const t = state.data.transactions.find(x => x.id === id);
  if (!t) return;
  if (t.pending) return toast('Transaksi ini masih menunggu sinkron.', 'error');
  const tr = t.type === 'Transfer', locked = String(t.category).startsWith('Pelunasan ');
  state.editType = t.type;
  picker.e = { cat: t.category, adding: false };
  state.fund.e = t.sumber;
  $('#e-id').value = id;
  $('#e-title').textContent = 'Edit ' + (tr ? 'transfer' : t.type === 'Income' ? 'pemasukan' : 'pengeluaran');
  $('#e-date').value = t.tanggal;
  setMoney($('#e-nominal'), t.nominal);
  $('#e-nominal').disabled = locked;
  $('#e-cat-new').value = '';
  $('#e-cat-wrap').classList.toggle('hidden', tr || locked);
  $('#e-fund-label').textContent = tr ? 'Pindahkan dari' : 'Sumber dana';
  $('#e-desc').value = t.deskripsi || '';
  renderPickers();
  show('#modal-edit');
}

function confirmVault(nominal, alasan) {
  return confirm(`Tarik ${rp(nominal)} dari Brankas Darurat?\nAlasan: ${alasan}`);
}

/* ---- lembar catat transaksi (tombol mengambang) ---- */
function openTx() {
  if (!parseRp($('#f-nominal').value) && !pickedCat('f')) { // form masih kosong: mulai dari Keluar
    state.type = 'Expense';
    resetPicker('f');
    renderTabs();
  }
  $('#f-date').value = $('#f-date').value || dateStr(new Date());
  show('#modal-tx');
  setTimeout(() => $('#f-nominal').focus(), 50);
}

/* ---- lembar pembayaran: bayar hutang/terima piutang, bayar tagihan, pindah dana ---- */
let sheet = null;
const sheetOut = () => sheet.mode !== 'hutang' || sheet.target.tipe === 'Hutang'; // uang keluar dari dompet?
function fundBalances() { const c = compute(); return { [FUND.KAS]: c.kas, [FUND.VAULT]: c.vault }; }

function renderSheet() {
  if (!sheet) return;
  const bal = fundBalances();
  const amt = parseRp($('#s-nominal').value);
  const cur = bal[sheet.fund];
  [['kas', FUND.KAS, 'bg-kas'], ['vault', FUND.VAULT, 'bg-vault']].forEach(([k, name, bg]) => {
    const b = $(`#s-fund-${k}`), on = sheet.fund === name;
    b.className = 'rounded-xl border px-3 py-2.5 text-left transition ' + (on ? bg + ' border-transparent text-white' : 'border-mist bg-white text-ink');
    b.setAttribute('aria-pressed', String(on));
    b.innerHTML = `<span class="block text-sm font-semibold">${name}</span><span class="block text-xs ${on ? 'text-white/80' : 'text-ink/60'}">Saldo ${rp(bal[name])}</span>`;
  });
  let msg, bad = false;
  if (sheetOut()) {
    msg = `Saldo ${sheet.fund} setelahnya ${rp(cur - amt)}.`;
    if (amt > cur) { bad = true; msg = `Saldo ${sheet.fund} tidak cukup, kurang ${rp(amt - cur)}. Saldo akan menjadi minus.`; }
  } else msg = `Saldo ${sheet.fund} setelahnya ${rp(cur + amt)}.`;
  const note = $('#s-note');
  note.textContent = amt > 0 ? msg : '';
  note.className = 'mt-1.5 text-xs ' + (bad ? 'font-semibold text-rust' : 'text-ink/60');
  const maxAmt = sheet.max;
  $('#s-quick').innerHTML = maxAmt > 0
    ? `<button type="button" data-act="s-fill" data-amt="${Math.round(maxAmt)}" class="rounded-full border border-mist bg-white px-3 py-1 text-xs font-semibold text-ink/70">Semua sisa ${rp(maxAmt)}</button>` : '';
}

function openSheet(cfg) {
  sheet = { mode: cfg.mode, id: cfg.id, fund: FUND.KAS, max: 0, target: null };
  let title, sub, label, pre = '';
  if (cfg.mode === 'hutang') {
    const h = state.data.hutang.find(x => x.id === cfg.id);
    if (!h) { sheet = null; return; }
    sheet.target = h; sheet.max = h.nominal - h.terbayar;
    const isH = h.tipe === 'Hutang';
    title = isH ? 'Bayar hutang' : 'Terima pembayaran';
    sub = `${h.nama} - sisa ${rp(sheet.max)}`;
    label = isH ? 'Dibayar dari' : 'Diterima di';
    if (cfg.full) pre = sheet.max;
  } else if (cfg.mode === 'bill') {
    const b = compute().billRows.find(x => x.id === cfg.id);
    if (!b) { sheet = null; return; }
    sheet.target = b; sheet.max = b.remaining; pre = b.remaining;
    title = 'Bayar tagihan'; sub = `${b.nama} - sisa ${rp(b.remaining)}`; label = 'Dibayar dari';
  }
  $('#s-title').textContent = title;
  $('#s-sub').textContent = sub;
  $('#s-fund-label').textContent = label;
  setMoney($('#s-nominal'), pre);
  renderSheet();
  show('#modal-sheet');
  setTimeout(() => $('#s-nominal').focus(), 50);
}
$('#s-nominal').addEventListener('input', renderSheet);

document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const id = el.dataset.id;
  switch (el.dataset.act) {
    case 'tab': setTab(el.dataset.tab); break;
    case 'type': state.type = el.dataset.type; resetPicker('f'); renderTabs(); break;
    case 'open-settings': show('#modal-settings'); break;
    case 'close-settings': hide('#modal-settings'); break;
    case 'open-tx': openTx(); break;
    case 'b-period': state.budgetPeriod = el.dataset.p; renderPickers(); break;
    case 'edit-budget': {
      const bd = getBudgets()[id];
      if (!bd) break;
      picker.b = { cat: id, adding: false };
      state.budgetPeriod = bd.p;
      setMoney($('#bud-limit'), bd.a);
      renderPickers();
      $('#bud-limit').focus();
      break;
    }
    case 'close-tx': hide('#modal-tx'); break;
    case 'open-reset': $('#r-confirm').value = ''; $('#r-backup').checked = true; $('#r-all').checked = false; syncResetBtn(); show('#modal-reset'); break;
    case 'close-reset': hide('#modal-reset'); break;
    case 'close-edit': state.editType = null; hide('#modal-edit'); break;
    case 'pick-cat': picker[el.dataset.p] = { cat: el.dataset.cat, adding: false }; renderPickers(); break;
    case 'new-cat': picker[el.dataset.p] = { cat: '', adding: true }; renderPickers(); $(`#${el.dataset.p}-cat-new`).focus(); break;
    case 'fund': state.fund[el.dataset.p] = el.dataset.fund; renderPickers(); break;
    case 'disconnect':
      if (confirm('Putuskan koneksi? Data tetap aman di Google Sheet Anda. Antrean offline yang belum terkirim akan hilang.')) {
        localStorage.removeItem(STORE.CONN); localStorage.removeItem(STORE.QUEUE); location.reload();
      }
      break;
    case 'toggle-reset': {
      const prev = state.data.settings.ResetMode === 'ON' ? 'ON' : 'OFF';
      const next = prev === 'ON' ? 'OFF' : 'ON';
      state.data.settings.ResetMode = next;
      render();
      if (!(await mutate('saveSetting', { key: 'ResetMode', value: next }))) { state.data.settings.ResetMode = prev; render(); }
      break;
    }
    case 'pay-bill': openSheet({ mode: 'bill', id }); break;
    case 's-fund': if (sheet) { sheet.fund = el.dataset.fund; renderSheet(); } break;
    case 's-fill': setMoney($('#s-nominal'), Number(el.dataset.amt)); renderSheet(); break;
    case 'close-sheet': sheet = null; hide('#modal-sheet'); break;
    case 'edit-tx': openEdit(id); break;
    case 'del-tx': {
      const t = state.data.transactions.find(x => x.id === id);
      if (t && t.pending) { // batalkan catatan offline
        setQueue(getQueue().filter(q => q.payload.id !== id));
        state.data.transactions = state.data.transactions.filter(x => x.id !== id);
        render(); break;
      }
      const extra = t && String(t.category).startsWith('Pelunasan ') ? '\nHutang/piutang terkait akan dibuka lagi.' : '';
      if (confirm('Hapus transaksi ini?' + extra)) await mutate('deleteTransaction', { id }, 'Transaksi dihapus');
      break;
    }
    case 'del-bill':
      if (confirm('Hapus tagihan ini?')) await mutate('deleteBill', { id }, 'Tagihan dihapus');
      break;
    case 'del-budget': {
      if ((state.data.meta.serverVersion || 0) < 4) { toast('Server belum diperbarui. Salin Code.gs terbaru lalu deploy versi baru.', 'error'); break; }
      const b = getBudgets(); delete b[id];
      await mutate('saveSetting', { key: 'Budgets', value: JSON.stringify(b) }, 'Batas dihapus');
      break;
    }
    case 'settle': openSheet({ mode: 'hutang', id, full: true }); break;
    case 'cicil': openSheet({ mode: 'hutang', id, full: false }); break;
  }
});

['#modal-settings', '#modal-edit', '#modal-reset', '#modal-sheet', '#modal-tx'].forEach(sel => $(sel).addEventListener('click', e => { if (e.target.id === sel.slice(1)) hide(sel); }));


$('#tx-form').addEventListener('submit', async e => {
  e.preventDefault();
  const type = state.type, sumber = state.fund.f;
  const nominal = parseRp($('#f-nominal').value), desc = $('#f-desc').value.trim();
  let category = 'Transfer';
  if (type !== 'Transfer') {
    category = pickedCat('f');
    if (!category) return toast('Pilih kategori atau tulis kategori baru', 'error');
  }
  if (nominal <= 0) return toast('Nominal harus lebih dari 0', 'error');
  if (sumber === FUND.VAULT && type !== 'Income') {
    if (!desc) return toast('Isi alasan di kolom deskripsi untuk penarikan Brankas Darurat', 'error');
    if (!confirmVault(nominal, desc)) return;
  }
  const ok = await mutate('addTransaction', { tanggal: $('#f-date').value, type, category, nominal, deskripsi: desc, sumber, tujuan: type === 'Transfer' ? otherFund(sumber) : '' }, 'Transaksi tersimpan');
  if (ok) { $('#f-nominal').value = ''; $('#f-desc').value = ''; resetPicker('f'); renderPickers(); hide('#modal-tx'); }
});

$('#edit-form').addEventListener('submit', async e => {
  e.preventDefault();
  const t = state.data.transactions.find(x => x.id === $('#e-id').value);
  if (!t) return;
  const catHidden = $('#e-cat-wrap').classList.contains('hidden');
  const category = catHidden ? t.category : pickedCat('e');
  if (!category) return toast('Pilih kategori atau tulis kategori baru', 'error');
  const nominal = parseRp($('#e-nominal').value);
  if (nominal <= 0) return toast('Nominal harus lebih dari 0', 'error');
  const sumber = state.fund.e;
  const ok = await mutate('updateTransaction', {
    id: t.id, tanggal: $('#e-date').value, nominal, category, sumber,
    tujuan: t.type === 'Transfer' ? otherFund(sumber) : '', deskripsi: $('#e-desc').value.trim()
  }, 'Perubahan disimpan');
  if (ok) { state.editType = null; hide('#modal-edit'); }
});

const syncResetBtn = () => { $('#r-submit').disabled = busyCount > 0 || $('#r-confirm').value.trim().toUpperCase() !== 'HAPUS'; };
$('#r-confirm').addEventListener('input', syncResetBtn);
$('#reset-form').addEventListener('submit', async e => {
  e.preventDefault();
  if ($('#r-confirm').value.trim().toUpperCase() !== 'HAPUS') return toast('Ketik HAPUS untuk melanjutkan', 'error');
  if (!navigator.onLine) return toast('Reset butuh koneksi internet', 'error');
  const backup = $('#r-backup').checked;
  $('#r-submit').disabled = true;
  const ok = await mutate('resetAll', { confirm: 'HAPUS', backup, all: $('#r-all').checked });
  if (!ok) { syncResetBtn(); return; } // galat sudah ditampilkan; modal tetap terbuka
  setQueue([]);           // catatan offline yang belum terkirim ikut dibuang
  state.extra = {};
  hide('#modal-reset'); hide('#modal-settings');
  await loadData();       // muat ulang dari server (kosong)
  toast(backup ? 'Semua data direset. Backup ada di folder Drive "Dompet Fleksibel - Backup".' : 'Semua data direset.');
});

$('#sheet-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (!sheet) return;
  const amt = parseRp($('#s-nominal').value);
  const cur = fundBalances()[sheet.fund];
  const today = dateStr(new Date());
  if (amt <= 0) return toast('Nominal harus lebih dari 0', 'error');
  if (amt > sheet.max) return toast(`Nominal melebihi sisa (${rp(sheet.max)})`, 'error');
  if (sheetOut() && amt > cur && !confirm(`Saldo ${sheet.fund} (${rp(cur)}) tidak cukup. Saldo akan menjadi minus. Lanjutkan?`)) return;
  let ok;
  if (sheet.mode === 'hutang') {
    ok = await mutate('settleHutang', { id: sheet.id, sumber: sheet.fund, tanggal: today, jumlah: amt }, amt >= sheet.max ? 'Ditandai lunas dan dicatat' : 'Cicilan dicatat');
  } else {
    ok = await mutate('addTransaction', { tanggal: today, type: 'Expense', category: 'Tagihan', nominal: amt, deskripsi: 'Tagihan: ' + sheet.target.nama, sumber: sheet.fund, refId: sheet.id }, 'Tagihan dibayar dari ' + sheet.fund);
  }
  if (ok) { sheet = null; hide('#modal-sheet'); }
});

$('#hp-form').addEventListener('submit', async e => {
  e.preventDefault();
  const ok = await mutate('addHutang', {
    tanggal: dateStr(new Date()), tipe: $('#hp-tipe').value, nama: $('#hp-nama').value.trim(),
    nominal: parseRp($('#hp-nominal').value), catatan: $('#hp-catatan').value.trim()
  }, 'Tersimpan di buku');
  if (ok) { $('#hp-nama').value = ''; $('#hp-nominal').value = ''; $('#hp-catatan').value = ''; }
});

$('#living-form').addEventListener('submit', async e => {
  e.preventDefault();
  await mutate('saveSetting', { key: 'MonthlyLivingCost', value: parseRp($('#set-living').value) }, 'Biaya hidup disimpan');
});
$('#emerg-form').addEventListener('submit', async e => {
  e.preventDefault();
  await mutate('saveSetting', { key: 'EmergencyMonths', value: Number($('#set-emerg').value) }, 'Target dana darurat disimpan');
});
$('#budget-form').addEventListener('submit', async e => {
  e.preventDefault();
  const kat = pickedCat('b');
  if (!kat) return toast('Pilih kategori atau tulis kategori baru', 'error');
  if ((state.data.meta.serverVersion || 0) < 4) return toast('Server belum diperbarui. Salin Code.gs terbaru ke Apps Script lalu deploy versi baru.', 'error');
  const b = getBudgets();
  const lim = parseRp($('#bud-limit').value);
  if (lim > 0) b[kat] = { a: lim, p: state.budgetPeriod }; else delete b[kat];
  const ok = await mutate('saveSetting', { key: 'Budgets', value: JSON.stringify(b) }, lim > 0 ? 'Batas disimpan' : 'Batas dihapus');
  if (ok) { $('#bud-limit').value = ''; resetPicker('b'); renderPickers(); }
});
$('#bill-form').addEventListener('submit', async e => {
  e.preventDefault();
  const ok = await mutate('saveBill', { nama: $('#bill-nama').value.trim(), nominal: parseRp($('#bill-nominal').value), tgl: Number($('#bill-tgl').value) }, 'Tagihan ditambahkan');
  if (ok) e.target.reset();
});

$('#stat-month').addEventListener('change', e => {
  if (!e.target.value) return;
  state.statMonth = e.target.value;
  renderStatistik(compute());
  ensureStatData();
});

document.addEventListener('keydown', e => { // Esc menutup lembar yang sedang terbuka (paling atas dulu)
  if (e.key !== 'Escape') return;
  const order = [['#modal-reset'], ['#modal-sheet', () => { sheet = null; }], ['#modal-edit', () => { state.editType = null; }], ['#modal-tx'], ['#modal-settings']];
  const top = order.find(([id]) => $(id).classList.contains('flex'));
  if (top) { if (top[1]) top[1](); hide(top[0]); }
});

window.addEventListener('online', loadData);
window.addEventListener('offline', () => $('#offline-banner').classList.remove('hidden'));

/* ================= INIT ================= */
(function init() {
  initMoneyInputs();
  $('#f-date').value = dateStr(new Date());
  const hash = location.hash.replace('#', '');
  if (TABS.includes(hash)) state.tab = hash;
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW gagal:', err)));
  }
  if (!conn) { render(); showConnect(); return; }
  const cached = readJSON(cacheKey(), null); // tampilkan data lama dulu agar cepat
  if (cached) state.data = normalize(cached);
  render();
  loadData();
})();
