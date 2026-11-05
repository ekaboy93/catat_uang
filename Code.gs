/**
 * DOMPET FLEKSIBEL (DUA BRANKAS) - Backend REST API v3
 * Google Apps Script + Google Sheets sebagai database (milik akun Google Anda sendiri).
 *
 * Cara pakai:
 * 1. Buat Google Sheet baru > Extensions > Apps Script > tempel file ini.
 * 2. Jalankan setup() sekali (beri izin). TOKEN rahasia dibuat otomatis dan ditampilkan
 *    di Execution log. Lupa token? Jalankan lihatToken().
 * 3. Deploy > New deployment > Web app > Execute as: Me, Who has access: Anyone.
 * 4. Buka aplikasi, tempel URL /exec dan TOKEN di layar "Hubungkan".
 * 5. (Opsional) Jalankan pasangPengingatEmail() untuk email pengingat tagihan tiap pagi.
 *
 * Update dari versi lama: tempel kode baru, jalankan setup() lagi (menambah kolom baru),
 * lalu Deploy > Manage deployments > Edit > New version.
 *
 * CORS: ContentService tidak bisa mengatur header HTTP. Web App Apps Script otomatis
 * membalas dengan Access-Control-Allow-Origin: * untuk "simple request", maka frontend
 * mengirim POST bertipe text/plain (tanpa preflight) berisi JSON.
 */

const TZ = 'Asia/Jakarta';
const FUNDS = ['Kas Harian', 'Brankas Darurat'];
const TX_TYPES = ['Income', 'Expense', 'Transfer'];
const HP_TYPES = ['Piutang Jasa', 'Piutang Pinjaman', 'Hutang'];
const USER_SETTINGS = ['MonthlyLivingCost', 'ResetMode', 'EmergencyMonths', 'Budgets'];
const WINDOW_MONTHS = 12;          // aplikasi hanya memuat 12 bulan terakhir
const BACKUP_FOLDER = 'Dompet Fleksibel - Backup';
const BACKUP_KEEP = 12;            // simpan 12 backup terbaru
const DEFAULT_SETTINGS = { MonthlyLivingCost: 0, ResetMode: 'OFF', EmergencyMonths: 6, Budgets: '{}', ResetCount: '' };

const SCHEMA = {
  Transactions: ['ID', 'Tanggal', 'Type', 'Category', 'Nominal', 'Deskripsi', 'Sumber Dana', 'Tujuan Dana', 'RefID'],
  HutangPiutang: ['ID', 'Tanggal', 'Tipe', 'Nama', 'Nominal', 'Catatan', 'Status', 'Terbayar'],
  FixedBills: ['ID', 'Nama Tagihan', 'Nominal', 'Tgl Jatuh Tempo'],
  Settings: ['Key', 'Value']
};
const KEYS = {
  Transactions: ['id', 'tanggal', 'type', 'category', 'nominal', 'deskripsi', 'sumber', 'tujuan', 'refId'],
  HutangPiutang: ['id', 'tanggal', 'tipe', 'nama', 'nominal', 'catatan', 'status', 'terbayar'],
  FixedBills: ['id', 'nama', 'nominal', 'tgl']
};

/* ============ SETUP & TOKEN ============ */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SCHEMA).forEach(function (name) {
    const n = SCHEMA[name].length;
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getMaxColumns() < n) sh.insertColumnsAfter(sh.getMaxColumns(), n - sh.getMaxColumns());
    sh.getRange(1, 1, 1, n).setValues([SCHEMA[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  ss.getSheetByName('Transactions').getRange('B:B').setNumberFormat('@');
  ss.getSheetByName('HutangPiutang').getRange('B:B').setNumberFormat('@');
  const have = readSettings_();
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) {
    if (!have.__keys[k]) setSetting_(k, DEFAULT_SETTINGS[k]);
  });
  const def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1 && def.getLastRow() === 0) ss.deleteSheet(def);
  Logger.log('SETUP SELESAI. TOKEN Anda: ' + getToken_());
}

function getToken_() {
  const props = PropertiesService.getScriptProperties();
  let t = props.getProperty('TOKEN');
  if (!t) {
    t = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 32);
    props.setProperty('TOKEN', t);
  }
  return t;
}
function lihatToken() { Logger.log('TOKEN: ' + getToken_()); }

/* ============ ENTRY POINT ============ */
function doGet() {
  return json_({ ok: true, data: { app: 'Dompet Fleksibel', version: 3 } }); // health check, tanpa data
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return json_({ ok: false, error: 'Body bukan JSON yang valid' }); }
  try {
    if (!body.token || body.token !== getToken_()) throw new Error('Token tidak valid');
    let data;
    if (body.action === 'getAll') {
      const lock0 = LockService.getScriptLock();
      lock0.waitLock(20000);
      try { fixMissingIds_(); data = getAll_(); } finally { lock0.releaseLock(); }
    } else if (body.action === 'getMonths') {
      data = getMonths_(body.payload || {});
    } else {
      const lock = LockService.getScriptLock();
      lock.waitLock(20000);
      try { data = route_(body.action, body.payload || {}); } finally { lock.releaseLock(); }
    }
    return json_({ ok: true, data: data });
  } catch (err) {
    return json_({ ok: false, error: err.message });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Aksi tulis mengembalikan "patch" kecil (bukan seluruh data) agar penyimpanan cepat. */
function route_(action, p) {
  switch (action) {
    case 'addTransaction': return { tx: { upsert: [rowObj_('Transactions', addTx_(p))] } };
    case 'updateTransaction': return { tx: { upsert: [rowObj_('Transactions', updateTx_(p))] } };
    case 'deleteTransaction': return deleteTx_(p.id);
    case 'addHutang': return addHutang_(p);
    case 'settleHutang': return settleHutang_(p);
    case 'saveBill': return { bills: { upsert: [rowObj_('FixedBills', saveBill_(p))] } };
    case 'deleteBill': deleteById_('FixedBills', p.id); return { bills: { remove: [String(p.id)] } };
    case 'saveSetting': saveSetting_(p); return { settings: settingsOut_() };
    default: throw new Error('Action tidak dikenal: ' + action);
  }
}

/* ============ HELPER ============ */
function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" belum ada. Jalankan setup() dulu.');
  return sh;
}
function newId_() { return Utilities.getUuid().slice(0, 8); }
function today_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function str_(v, label, required) {
  const s = String(v == null ? '' : v).trim();
  if (required && !s) throw new Error(label + ' wajib diisi');
  return s;
}
function nominal_(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) throw new Error('Nominal harus lebih dari 0');
  return n;
}
function date_(v) {
  const s = v ? String(v) : today_();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('Format tanggal harus yyyy-MM-dd');
  return s;
}
function oneOf_(v, list, label) {
  if (list.indexOf(v) < 0) throw new Error(label + ' harus salah satu dari: ' + list.join(', '));
  return v;
}

/** Tanggal ketikan manual (05/11/2026, 5-11-2026, 2026/11/5) -> yyyy-MM-dd. Format harian-dulu (Indonesia). */
function normDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  const s = String(v == null ? '' : v).trim();
  let m = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/);
  if (m) return m[3] + '-' + pad2_(+m[2]) + '-' + pad2_(+m[1]);
  m = s.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})$/);
  if (m) return m[1] + '-' + pad2_(+m[2]) + '-' + pad2_(+m[3]);
  return s;
}
/** Angka ketikan manual ("Rp 1.500.000", "1.500.000", "1500000") -> number. */
function toNum_(v) {
  if (typeof v === 'number') return v;
  const s = String(v == null ? '' : v).replace(/rp|\s/gi, '');
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) return Number(s.replace(/\./g, '').replace(',', '.'));
  return Number(s.replace(',', '.')) || 0;
}
function toObj_(name, r) {
  const o = {};
  KEYS[name].forEach(function (k, i) {
    let v = r[i];
    if (k === 'tanggal') v = normDate_(v);
    else if (k === 'nominal' || k === 'terbayar' || k === 'tgl') v = toNum_(v);
    o[k] = v;
  });
  if (name === 'HutangPiutang') {
    let t = Number(o.terbayar) || 0;
    if (o.status === 'Lunas' && !t) t = Number(o.nominal) || 0; // data lama
    o.terbayar = t;
  }
  return o;
}
function rowObj_(name, row) {
  return toObj_(name, sheet_(name).getRange(row, 1, 1, SCHEMA[name].length).getValues()[0]);
}
/** Baris yang diketik manual di Sheet tanpa ID diberi ID otomatis (dan Status hutang kosong menjadi Pending). */
function fixMissingIds_() {
  ['Transactions', 'HutangPiutang', 'FixedBills'].forEach(function (name) {
    const sh = sheet_(name);
    const last = sh.getLastRow();
    if (last < 2) return;
    const v = sh.getRange(2, 1, last - 1, 2).getValues();
    let changed = false;
    const ids = v.map(function (r) {
      if (r[0] === '' && r[1] !== '') { changed = true; return [newId_()]; }
      return [r[0]];
    });
    if (changed) sh.getRange(2, 1, last - 1, 1).setValues(ids);
    if (name === 'HutangPiutang') {
      const st = sh.getRange(2, 7, last - 1, 1).getValues();
      let ch2 = false;
      const fixed = st.map(function (r, i) {
        if (r[0] === '' && v[i][1] !== '') { ch2 = true; return ['Pending']; }
        return [r[0]];
      });
      if (ch2) sh.getRange(2, 7, last - 1, 1).setValues(fixed);
    }
  });
}

function readRows_(name) {
  const sh = sheet_(name);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, SCHEMA[name].length).getValues()
    .filter(function (r) { return r[0] !== ''; })
    .map(function (r) { return toObj_(name, r); });
}

function readSettings_() {
  const out = {};
  const seen = {};
  Object.keys(DEFAULT_SETTINGS).forEach(function (k) { out[k] = DEFAULT_SETTINGS[k]; });
  const sh = sheet_('Settings');
  const last = sh.getLastRow();
  if (last >= 2) {
    sh.getRange(2, 1, last - 1, 2).getValues().forEach(function (r) {
      if (r[0] !== '') { out[r[0]] = r[1]; seen[r[0]] = true; }
    });
  }
  out.__keys = seen;
  return out;
}

function setSetting_(key, value) {
  const sh = sheet_('Settings');
  const last = sh.getLastRow();
  if (last >= 2) {
    const keys = sh.getRange(2, 1, last - 1, 1).getValues();
    for (let i = 0; i < keys.length; i++) {
      if (keys[i][0] === key) { sh.getRange(i + 2, 2).setValue(value); return; }
    }
  }
  sh.appendRow([key, value]);
}

function findRow_(name, id) {
  const sh = sheet_(name);
  const last = sh.getLastRow();
  if (last < 2) return -1;
  const ids = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(id)) return i + 2;
  }
  return -1;
}

function deleteById_(name, id) {
  const row = findRow_(name, id);
  if (row < 0) throw new Error('Data tidak ditemukan');
  sheet_(name).deleteRow(row);
}

/* ============ DATA ============ */
function pad2_(n) { return (n < 10 ? '0' : '') + n; }
function windowStart_() {
  let y = Number(Utilities.formatDate(new Date(), TZ, 'yyyy'));
  let m = Number(Utilities.formatDate(new Date(), TZ, 'M')) - (WINDOW_MONTHS - 1);
  while (m <= 0) { m += 12; y -= 1; }
  return y + '-' + pad2_(m) + '-01';
}
function settingsOut_() {
  const s = readSettings_();
  delete s.__keys;
  return s;
}

/** Muat data ringan: transaksi 12 bulan terakhir + saldo awal (ringkasan transaksi yang lebih lama). */
function getAll_() {
  const start = windowStart_();
  const opening = {};
  FUNDS.forEach(function (f) { opening[f] = 0; });
  const recent = [];
  readRows_('Transactions').forEach(function (t) {
    if (String(t.tanggal) >= start) { recent.push(t); return; }
    const n = Number(t.nominal) || 0;
    if (t.type === 'Transfer') {
      opening[t.sumber] = (opening[t.sumber] || 0) - n;
      opening[t.tujuan] = (opening[t.tujuan] || 0) + n;
    } else {
      opening[t.sumber] = (opening[t.sumber] || 0) + (t.type === 'Income' ? n : -n);
    }
  });
  return {
    transactions: recent,
    hutang: readRows_('HutangPiutang').filter(function (h) { return h.status === 'Pending'; }),
    bills: readRows_('FixedBills'),
    settings: settingsOut_(),
    meta: { windowStart: start, opening: opening, windowMonths: WINDOW_MONTHS }
  };
}

/** Transaksi untuk bulan tertentu (dipakai Statistik saat memilih bulan di luar jendela). */
function getMonths_(p) {
  const list = Array.isArray(p.months) ? p.months : [];
  if (!list.length || list.length > 24) throw new Error('Daftar bulan tidak valid');
  const wanted = {};
  list.forEach(function (m) {
    if (!/^\d{4}-\d{2}$/.test(m)) throw new Error('Format bulan harus yyyy-MM');
    wanted[m] = [];
  });
  readRows_('Transactions').forEach(function (t) {
    const k = String(t.tanggal).slice(0, 7);
    if (wanted[k]) wanted[k].push(t);
  });
  return { months: wanted };
}

/** Validasi + susun satu baris transaksi (dipakai tambah & edit). */
function buildTx_(p, id) {
  const type = oneOf_(p.type, TX_TYPES, 'Type');
  const sumber = oneOf_(p.sumber, FUNDS, 'Sumber Dana');
  const desc = str_(p.deskripsi, 'Deskripsi', false);
  let category, tujuan = '';
  if (type === 'Transfer') {
    tujuan = oneOf_(p.tujuan, FUNDS, 'Tujuan Dana');
    if (tujuan === sumber) throw new Error('Sumber dan tujuan transfer harus berbeda');
    category = 'Transfer';
  } else {
    category = str_(p.category, 'Kategori', true);
  }
  if (sumber === 'Brankas Darurat' && type !== 'Income' && !desc) {
    throw new Error('Alasan (deskripsi) wajib diisi untuk penarikan Brankas Darurat');
  }
  return [id, date_(p.tanggal), type, category, nominal_(p.nominal), desc, sumber, tujuan, str_(p.refId, 'RefID', false)];
}

/** Mengembalikan nomor baris transaksi. */
function addTx_(p) {
  const id = p.id ? String(p.id) : newId_();
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(id)) throw new Error('ID transaksi tidak valid');
  const existing = findRow_('Transactions', id);
  if (existing > 0) return existing; // idempoten: aman bila antrean offline terkirim ulang
  const sh = sheet_('Transactions');
  sh.appendRow(buildTx_(p, id));
  return sh.getLastRow();
}

function updateTx_(p) {
  const row = findRow_('Transactions', p.id);
  if (row < 0) throw new Error('Transaksi tidak ditemukan');
  const sh = sheet_('Transactions');
  const old = sh.getRange(row, 1, 1, 9).getValues()[0];
  const merged = Object.assign({}, p, { type: old[2], refId: old[8] });
  if (String(old[3]).indexOf('Pelunasan ') === 0) { merged.category = old[3]; merged.nominal = old[4]; } // terkunci
  sh.getRange(row, 1, 1, 9).setValues([buildTx_(merged, old[0])]);
  return row;
}

function deleteTx_(id) {
  const row = findRow_('Transactions', id);
  if (row < 0) throw new Error('Transaksi tidak ditemukan');
  const sh = sheet_('Transactions');
  const v = sh.getRange(row, 1, 1, 9).getValues()[0];
  const patch = { tx: { remove: [String(id)] } };
  if (String(v[3]).indexOf('Pelunasan ') === 0 && v[8]) { // batalkan pelunasan: buka lagi hutang/piutangnya
    const hr = findRow_('HutangPiutang', v[8]);
    if (hr > 0) {
      const hs = sheet_('HutangPiutang');
      const h = hs.getRange(hr, 1, 1, 8).getValues()[0];
      const paid = Math.max(0, (Number(h[7]) || 0) - Number(v[4]));
      hs.getRange(hr, 7, 1, 2).setValues([[paid >= Number(h[4]) ? 'Lunas' : 'Pending', paid]]);
      patch.hutang = { upsert: [rowObj_('HutangPiutang', hr)] };
    }
  }
  sh.deleteRow(row);
  return patch;
}

function addHutang_(p) {
  const hs = sheet_('HutangPiutang');
  hs.appendRow([
    newId_(), date_(p.tanggal), oneOf_(p.tipe, HP_TYPES, 'Tipe'), str_(p.nama, 'Nama', true),
    nominal_(p.nominal), str_(p.catatan, 'Catatan', false), 'Pending', 0
  ]);
  return { hutang: { upsert: [rowObj_('HutangPiutang', hs.getLastRow())] } };
}

/** Pelunasan penuh atau cicilan (p.jumlah). Piutang Jasa & Pinjaman -> Income, Hutang -> Expense. */
function settleHutang_(p) {
  const row = findRow_('HutangPiutang', p.id);
  if (row < 0) throw new Error('Data hutang/piutang tidak ditemukan');
  const hs = sheet_('HutangPiutang');
  const v = hs.getRange(row, 1, 1, 8).getValues()[0];
  const total = Number(v[4]);
  let paid = Number(v[7]) || 0;
  if (v[6] === 'Lunas' && !paid) paid = total;
  const remaining = total - paid;
  if (remaining <= 0) throw new Error('Sudah berstatus lunas');
  const amount = (p.jumlah != null && p.jumlah !== '') ? nominal_(p.jumlah) : remaining;
  if (amount > remaining + 0.001) throw new Error('Jumlah melebihi sisa (' + remaining + ')');
  const newPaid = paid + amount;
  const done = newPaid >= total - 0.001;
  const isHutang = v[2] === 'Hutang';
  const txRow = addTx_({
    tanggal: p.tanggal,
    type: isHutang ? 'Expense' : 'Income',
    category: isHutang ? 'Pelunasan Hutang' : (v[2] === 'Piutang Jasa' ? 'Pelunasan Piutang Jasa' : 'Pelunasan Piutang Pinjaman'),
    nominal: amount,
    deskripsi: (done ? '' : 'Cicilan ') + v[2] + ' - ' + v[3] + (v[5] ? ' (' + v[5] + ')' : ''),
    sumber: p.sumber || FUNDS[0],
    refId: v[0]
  });
  hs.getRange(row, 7, 1, 2).setValues([[done ? 'Lunas' : 'Pending', newPaid]]);
  return { tx: { upsert: [rowObj_('Transactions', txRow)] }, hutang: { upsert: [rowObj_('HutangPiutang', row)] } };
}

/** Mengembalikan nomor baris tagihan. */
function saveBill_(p) {
  const nama = str_(p.nama, 'Nama tagihan', true);
  const nom = nominal_(p.nominal);
  const tgl = Math.round(Number(p.tgl));
  if (!(tgl >= 1 && tgl <= 31)) throw new Error('Tanggal jatuh tempo harus 1-31');
  const sh = sheet_('FixedBills');
  if (p.id) {
    const row = findRow_('FixedBills', p.id);
    if (row < 0) throw new Error('Tagihan tidak ditemukan');
    sh.getRange(row, 2, 1, 3).setValues([[nama, nom, tgl]]);
    return row;
  }
  sh.appendRow([newId_(), nama, nom, tgl]);
  return sh.getLastRow();
}

function normBudgets_(v) {
  let obj;
  try { obj = typeof v === 'string' ? JSON.parse(v) : v; } catch (e) { throw new Error('Format anggaran tidak valid'); }
  const out = {};
  Object.keys(obj || {}).forEach(function (k) {
    const n = Number(obj[k]);
    if (k.trim() && n > 0) out[k.trim()] = n;
  });
  return JSON.stringify(out);
}

function saveSetting_(p) {
  const key = oneOf_(p.key, USER_SETTINGS, 'Key');
  let value = p.value;
  if (key === 'MonthlyLivingCost') {
    value = Number(value);
    if (!isFinite(value) || value < 0) throw new Error('Biaya hidup tidak valid');
  } else if (key === 'ResetMode') {
    value = oneOf_(value, ['ON', 'OFF'], 'ResetMode');
    const cur = readSettings_();
    if (value === 'ON' && cur.ResetMode !== 'ON') { // catat berapa kali amnesti dipakai bulan ini
      const ym = Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
      const parts = String(cur.ResetCount || '').split('|');
      const n = parts[0] === ym ? Number(parts[1]) || 0 : 0;
      setSetting_('ResetCount', ym + '|' + (n + 1));
    }
  } else if (key === 'EmergencyMonths') {
    value = Number(value);
    if (!(value >= 0 && value <= 120)) throw new Error('Target bulan dana darurat harus 0-120');
  } else if (key === 'Budgets') {
    value = normBudgets_(value);
  }
  setSetting_(key, value);
}

/* ============ PENGINGAT EMAIL (opsional) ============ */
function pasangPengingatEmail() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'kirimPengingat') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('kirimPengingat').timeBased().atHour(7).everyDays(1).inTimezone(TZ).create();
}

function kirimPengingat() {
  const ym = Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
  const day = Number(Utilities.formatDate(new Date(), TZ, 'd'));
  const total = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
  const tx = readRows_('Transactions');
  const lines = [];
  readRows_('FixedBills').forEach(function (b) {
    const paid = tx.filter(function (t) {
      return t.type === 'Expense' && t.refId === b.id && String(t.tanggal).indexOf(ym) === 0;
    }).reduce(function (s, t) { return s + Number(t.nominal); }, 0);
    const remaining = Number(b.nominal) - paid;
    const left = Math.min(Number(b.tgl), total) - day;
    if (remaining > 0 && left <= 3) {
      lines.push('- ' + b.nama + ': Rp ' + remaining + (left < 0 ? ' (terlambat ' + (-left) + ' hari)' : left === 0 ? ' (jatuh tempo hari ini)' : ' (' + left + ' hari lagi)'));
    }
  });
  if (lines.length) {
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(), 'Pengingat tagihan - Dompet Fleksibel', lines.join('\n'));
  }
}

/* ============ BACKUP OTOMATIS ============ */
/** Salin seluruh spreadsheet ke folder Drive khusus; simpan BACKUP_KEEP salinan terbaru. */
function backupSekarang() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const it = DriveApp.getFoldersByName(BACKUP_FOLDER);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(BACKUP_FOLDER);
  DriveApp.getFileById(ss.getId()).makeCopy('Backup ' + ss.getName() + ' ' + today_(), folder);
  const files = [];
  const fi = folder.getFiles();
  while (fi.hasNext()) files.push(fi.next());
  files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  files.slice(BACKUP_KEEP).forEach(function (f) { f.setTrashed(true); });
  Logger.log('Backup selesai: ' + Math.min(files.length, BACKUP_KEEP) + ' salinan tersimpan di folder "' + BACKUP_FOLDER + '".');
}

/** Jalankan sekali: backup otomatis tiap tanggal 1 pukul 02.00. */
function pasangBackupBulanan() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'backupSekarang') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('backupSekarang').timeBased().onMonthDay(1).atHour(2).inTimezone(TZ).create();
  backupSekarang(); // backup pertama langsung dibuat
}
