/**
 * 공유가계부 API — 구글 시트 + Apps Script
 *
 * 최초 1회:
 *   1) 아래 INITIAL_PIN을 두 분만 아는 비밀번호(6자 이상)로 바꾸기
 *   2) 상단 함수 선택에서 setup 선택 → 실행 (권한 허용)
 *   3) 배포 → 새 배포 → 웹 앱 (실행: 나 / 액세스: 모든 사용자)
 *
 * ⚠️ 실제 비밀번호를 넣은 이 파일을 GitHub에 올리지 마세요.
 */
const INITIAL_PIN = '여기에-비밀번호-입력';

const USERS = ['지은', '홍균'];
const TYPES = ['입금', '출금'];

const SHEET = { ENTRIES: '내역', CATEGORIES: '카테고리', BUDGETS: '예산' };
const HEADERS = {
  [SHEET.ENTRIES]: ['id', '날짜', '작성자', '구분', '금액', '카테고리', '메모', '등록일시', '수정일시'],
  [SHEET.CATEGORIES]: ['이름', '구분', '아이콘', '색상', '순서', '고정비'],
  [SHEET.BUDGETS]: ['작성자', '카테고리', '월예산'],
};

const DEFAULT_CATEGORIES = [
  ['월급', '입금', '💰', '#22A06B', 1, false],
  ['부수입', '입금', '💵', '#4BCE97', 2, false],
  ['기타입금', '입금', '📥', '#7EE2B8', 3, false],
  ['식비', '출금', '🍚', '#F97316', 10, false],
  ['카페·간식', '출금', '☕', '#A16207', 11, false],
  ['주유', '출금', '⛽', '#EF4444', 12, false],
  ['교통', '출금', '🚌', '#3B82F6', 13, false],
  ['포켓몬카드', '출금', '🃏', '#EAB308', 14, false],
  ['쇼핑', '출금', '🛍️', '#EC4899', 15, false],
  ['데이트', '출금', '💕', '#F43F5E', 16, false],
  ['생활·주거', '출금', '🏠', '#6366F1', 17, true],
  ['통신·구독', '출금', '📱', '#06B6D4', 18, true],
  ['의료·건강', '출금', '💊', '#10B981', 19, false],
  ['경조사·선물', '출금', '🎁', '#8B5CF6', 20, false],
  ['기타지출', '출금', '📦', '#64748B', 99, false],
];

/* ───────────────────────── 초기 설정 ───────────────────────── */

function setup() {
  if (INITIAL_PIN === '여기에-비밀번호-입력' || INITIAL_PIN.length < 6) {
    throw new Error('INITIAL_PIN을 6자 이상의 비밀번호로 바꾼 뒤 다시 실행하세요.');
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  Object.keys(HEADERS).forEach(function (name) {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      const head = HEADERS[name];
      sh.getRange(1, 1, 1, head.length).setValues([head])
        .setFontWeight('bold').setBackground('#f1f5f9');
      sh.setFrozenRows(1);
    }
  });

  const entries = ss.getSheetByName(SHEET.ENTRIES);
  entries.getRange('A:B').setNumberFormat('@'); // id·날짜가 자동 변환되지 않도록 텍스트 고정
  entries.getRange('E:E').setNumberFormat('#,##0');

  const cats = ss.getSheetByName(SHEET.CATEGORIES);
  if (cats.getLastRow() === 1) {
    cats.getRange(2, 1, DEFAULT_CATEGORIES.length, 6).setValues(DEFAULT_CATEGORIES);
  }

  // 비어 있는 기본 시트 정리
  ['시트1', 'Sheet1'].forEach(function (n) {
    const s = ss.getSheetByName(n);
    if (s && s.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s);
  });

  PropertiesService.getScriptProperties().setProperty('PIN', INITIAL_PIN);
  Logger.log('✅ 설정 완료! 이제 웹 앱으로 배포하세요.');
}

/* ───────────────────────── 진입점 ───────────────────────── */

function doGet() {
  return json_({ ok: true, data: '공유가계부 API 작동 중' });
}

function doPost(e) {
  let res;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    checkAuth_(req.pin);
    const handler = ACTIONS[req.action];
    if (!handler) throw new Error('알 수 없는 요청: ' + req.action);
    res = { ok: true, data: handler(req) };
  } catch (err) {
    res = { ok: false, error: err.message };
  }
  return json_(res);
}

const ACTIONS = {
  ping: function () { return 'pong'; },
  bootstrap: bootstrap_,
  addEntry: addEntry_,
  updateEntry: updateEntry_,
  deleteEntry: deleteEntry_,
  saveCategory: saveCategory_,
  deleteCategory: deleteCategory_,
  saveBudget: saveBudget_,
  changePin: changePin_,
};

/* ───────────────────────── 인증 ───────────────────────── */

function checkAuth_(pin) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('authFails') || 0);
  if (fails >= 10) throw new Error('비밀번호 오류가 많아 10분간 잠겼습니다.');

  const saved = PropertiesService.getScriptProperties().getProperty('PIN');
  if (!saved) throw new Error('서버 설정이 안 됐습니다. setup()을 실행하세요.');
  if (String(pin || '') !== saved) {
    cache.put('authFails', String(fails + 1), 600);
    throw new Error('비밀번호가 틀렸습니다.');
  }
}

function changePin_(req) {
  const next = String(req.newPin || '');
  if (next.length < 6) throw new Error('비밀번호는 6자 이상이어야 합니다.');
  PropertiesService.getScriptProperties().setProperty('PIN', next);
  return true;
}

/* ───────────────────────── 조회 ───────────────────────── */

function bootstrap_() {
  return {
    users: USERS,
    entries: readEntries_(),
    categories: readCategories_(),
    budgets: readBudgets_(),
    serverTime: new Date().toISOString(),
  };
}

function readEntries_() {
  const sh = sheet_(SHEET.ENTRIES);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, 9).getValues()
    .filter(function (r) { return r[0] !== ''; })
    .map(rowToEntry_);
}

function rowToEntry_(r) {
  return {
    id: String(r[0]),
    date: fmtDate_(r[1]),
    user: String(r[2]),
    type: String(r[3]),
    amount: Number(r[4]) || 0,
    category: String(r[5]),
    memo: String(r[6] || ''),
    createdAt: fmtTime_(r[7]),
    updatedAt: fmtTime_(r[8]),
  };
}

function readCategories_() {
  const sh = sheet_(SHEET.CATEGORIES);
  migrateCategories_(sh);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, 6).getValues()
    .filter(function (r) { return r[0] !== ''; })
    .map(function (r) {
      return { name: String(r[0]), type: String(r[1]), icon: String(r[2]), color: String(r[3]), order: Number(r[4]) || 0,
        fixed: r[5] === true || String(r[5]).toUpperCase() === 'TRUE' };
    })
    .sort(function (a, b) { return a.order - b.order; });
}

function readBudgets_() {
  const sh = sheet_(SHEET.BUDGETS);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, 3).getValues()
    .filter(function (r) { return r[0] !== ''; })
    .map(function (r) { return { user: String(r[0]), category: String(r[1]), amount: Number(r[2]) || 0 }; });
}

/* ───────────────────────── 내역 쓰기 ───────────────────────── */

function addEntry_(req) {
  const v = validateEntry_(req.entry || {});
  const clientId = String((req.entry && req.entry.id) || '');
  const id = /^[A-Za-z0-9-]{8,40}$/.test(clientId) ? clientId : Utilities.getUuid();

  return withLock_(function () {
    const sh = sheet_(SHEET.ENTRIES);
    const existing = findRow_(sh, id);
    if (existing > 0) return rowToEntry_(sh.getRange(existing, 1, 1, 9).getValues()[0]); // 재전송 중복 방지

    const row = [id, v.date, v.user, v.type, v.amount, safe_(v.category), safe_(v.memo), new Date(), ''];
    sh.appendRow(row);
    return rowToEntry_(row);
  });
}

function updateEntry_(req) {
  const id = String((req.entry && req.entry.id) || '');
  const v = validateEntry_(req.entry || {});

  return withLock_(function () {
    const sh = sheet_(SHEET.ENTRIES);
    const rowNo = findRow_(sh, id);
    if (rowNo < 0) throw new Error('해당 내역을 찾을 수 없습니다. (이미 삭제됨)');
    sh.getRange(rowNo, 2, 1, 6).setValues([[v.date, v.user, v.type, v.amount, safe_(v.category), safe_(v.memo)]]);
    sh.getRange(rowNo, 9).setValue(new Date());
    return rowToEntry_(sh.getRange(rowNo, 1, 1, 9).getValues()[0]);
  });
}

function deleteEntry_(req) {
  const id = String(req.id || '');
  return withLock_(function () {
    const sh = sheet_(SHEET.ENTRIES);
    const rowNo = findRow_(sh, id);
    if (rowNo > 0) sh.deleteRow(rowNo);
    return { id: id };
  });
}

function validateEntry_(x) {
  const date = String(x.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('날짜 형식이 올바르지 않습니다.');
  if (USERS.indexOf(x.user) < 0) throw new Error('작성자가 올바르지 않습니다.');
  if (TYPES.indexOf(x.type) < 0) throw new Error('입금/출금 구분이 올바르지 않습니다.');
  const amount = Math.round(Number(x.amount));
  if (!(amount > 0) || amount > 1e11) throw new Error('금액이 올바르지 않습니다.');
  const category = String(x.category || '').trim().slice(0, 30);
  if (!category) throw new Error('카테고리를 선택하세요.');
  const memo = String(x.memo || '').trim().slice(0, 200);
  return { date: date, user: x.user, type: x.type, amount: amount, category: category, memo: memo };
}

/* ───────────────────────── 카테고리 / 예산 ───────────────────────── */

function saveCategory_(req) {
  const c = req.category || {};
  const name = String(c.name || '').trim().slice(0, 30);
  if (!name) throw new Error('카테고리 이름을 입력하세요.');
  if (TYPES.indexOf(c.type) < 0) throw new Error('카테고리 구분이 올바르지 않습니다.');
  const original = String(req.originalName || '').trim();
  const row = [safe_(name), c.type, safe_(String(c.icon || '📦').slice(0, 8)),
    /^#[0-9A-Fa-f]{6}$/.test(c.color) ? c.color : '#64748B', Number(c.order) || 50, c.fixed === true];

  return withLock_(function () {
    const sh = sheet_(SHEET.CATEGORIES);
    const target = findRow_(sh, original || name);
    if (original && original !== name && findRow_(sh, name) > 0) throw new Error('같은 이름의 카테고리가 이미 있습니다.');

    migrateCategories_(sh);
    if (target > 0) sh.getRange(target, 1, 1, 6).setValues([row]);
    else sh.appendRow(row);

    // 이름이 바뀌면 기존 내역·예산도 함께 변경
    if (original && original !== name) {
      renameIn_(sheet_(SHEET.ENTRIES), 6, original, name);
      renameIn_(sheet_(SHEET.BUDGETS), 2, original, name);
    }
    return readCategories_();
  });
}

/** 예전 시트에 '고정비' 열이 없으면 추가 (통신·구독, 생활·주거는 고정비로 시작) */
function migrateCategories_(sh) {
  if (sh.getRange(1, 6).getValue() === '고정비') return;
  sh.getRange(1, 6).setValue('고정비').setFontWeight('bold').setBackground('#f1f5f9');
  const n = sh.getLastRow() - 1;
  if (n < 1) return;
  const names = sh.getRange(2, 1, n, 1).getValues();
  sh.getRange(2, 6, n, 1).setValues(names.map(function (r) { return [r[0] === '통신·구독' || r[0] === '생활·주거']; }));
}

function deleteCategory_(req) {
  const name = String(req.name || '');
  return withLock_(function () {
    const entries = sheet_(SHEET.ENTRIES);
    if (entries.getLastRow() > 1 &&
        entries.getRange(2, 6, entries.getLastRow() - 1, 1).createTextFinder(name).matchEntireCell(true).findNext()) {
      throw new Error('이미 사용 중인 카테고리는 삭제할 수 없어요. 이름 변경을 이용하세요.');
    }
    const sh = sheet_(SHEET.CATEGORIES);
    const rowNo = findRow_(sh, name);
    if (rowNo > 0) sh.deleteRow(rowNo);
    return readCategories_();
  });
}

function saveBudget_(req) {
  const b = req.budget || {};
  if (USERS.indexOf(b.user) < 0) throw new Error('작성자가 올바르지 않습니다.');
  const category = String(b.category || '');
  const amount = Math.max(0, Math.round(Number(b.amount) || 0));

  return withLock_(function () {
    const sh = sheet_(SHEET.BUDGETS);
    const n = sh.getLastRow() - 1;
    const rows = n > 0 ? sh.getRange(2, 1, n, 2).getValues() : [];
    let rowNo = -1;
    rows.forEach(function (r, i) { if (r[0] === b.user && r[1] === category) rowNo = i + 2; });

    if (amount === 0) { if (rowNo > 0) sh.deleteRow(rowNo); }
    else if (rowNo > 0) sh.getRange(rowNo, 3).setValue(amount);
    else sh.appendRow([b.user, safe_(category), amount]);
    return readBudgets_();
  });
}

/* ───────────────────────── 유틸 ───────────────────────── */

function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('"' + name + '" 시트가 없습니다. setup()을 실행하세요.');
  return sh;
}

/** 첫 번째 열에서 값이 정확히 일치하는 행 번호 (없으면 -1) */
function findRow_(sh, key) {
  if (!key) return -1;
  const last = sh.getLastRow();
  if (last < 2) return -1;
  const cell = sh.getRange(2, 1, last - 1, 1).createTextFinder(String(key)).matchEntireCell(true).findNext();
  return cell ? cell.getRow() : -1;
}

function renameIn_(sh, col, from, to) {
  if (sh.getLastRow() < 2) return;
  sh.getRange(2, col, sh.getLastRow() - 1, 1).createTextFinder(from).matchEntireCell(true).replaceAllWith(to);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('다른 저장이 진행 중입니다. 잠시 후 다시 시도하세요.');
  try { return fn(); } finally { lock.releaseLock(); }
}

/** 수식으로 해석되지 않도록 방어 (=, +, -, @ 로 시작하는 문자열) */
function safe_(s) {
  s = String(s);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function fmtDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v);
}

function fmtTime_(v) {
  return v instanceof Date ? v.toISOString() : String(v || '');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
