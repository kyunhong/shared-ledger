import { USERS, USER_COLORS } from './config.js';
import * as api from './api.js';
import * as S from './stats.js';
import * as C from './charts.js';
import { load, save, remove } from './store.js';

/* ───────────────────────── 유틸 ───────────────────────── */

const $ = (sel, el = document) => el.querySelector(sel);
const pad = n => String(n).padStart(2, '0');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const won = n => `${Math.round(n).toLocaleString('ko-KR')}원`;
const pct = (v, digits = 0) => (v == null ? '–' : `${(v * 100).toFixed(digits)}%`);
const clamp01 = v => Math.max(0, Math.min(1, v || 0));
const avg = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const dateLabel = d => {
  const dt = new Date(`${d}T00:00`);
  return `${dt.getMonth() + 1}월 ${dt.getDate()}일 (${WEEK[dt.getDay()]})`;
};
const monthLabel = ym => `${ym.slice(0, 4)}년 ${Number(ym.slice(5))}월`;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
const other = u => USERS.find(x => x !== u);
const userTag = u => `<span class="who" style="--u:${USER_COLORS[u]}">${esc(u)}</span>`;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/* ───────────────────────── 상태 ───────────────────────── */

const state = {
  me: load('me'),
  pin: load('pin'),
  data: load('cache') || { entries: [], categories: [], budgets: [] },
  queue: load('queue') || [],           // 오프라인 대기 작업
  lastSync: load('lastSync'),
  tab: load('tab') || 'home',
  month: S.ymOf(todayStr()),
  filter: { user: 'all', type: 'all', category: '' },
  statsScope: 'all',
  statsCat: null,
  newIds: new Set(),
  syncing: false,
  resync: false,
  lastError: null,
};

const entries = () => state.data.entries;
const sortEntries = list => [...list].sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));

const FALLBACK_COLORS = ['#F97316', '#3B82F6', '#EAB308', '#EC4899', '#10B981', '#8B5CF6', '#06B6D4', '#EF4444'];
function catMeta(name) {
  const c = state.data.categories.find(x => x.name === name);
  if (c) return c;
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { name, icon: '📦', color: FALLBACK_COLORS[h % FALLBACK_COLORS.length], type: '출금' };
}

/* ───────────────────────── 동기화 ───────────────────────── */

function persist() {
  save('cache', state.data);
  save('queue', state.queue);
}

async function sync({ silent = true } = {}) {
  if (!state.pin) return;
  if (state.syncing) { state.resync = true; return; }
  state.syncing = true;
  renderSyncStatus();
  try {
    await flushQueue();
    const data = await api.call('bootstrap', {}, state.pin);
    state.data = { entries: data.entries, categories: data.categories, budgets: data.budgets };
    applyQueueLocally();
    state.lastSync = new Date().toISOString();
    save('lastSync', state.lastSync);
    state.lastError = null;
    persist();
  } catch (e) {
    if (e instanceof api.ApiError && e.message.includes('비밀번호가 틀렸')) {
      state.syncing = false;
      return logout('비밀번호가 바뀌었어요. 다시 로그인하세요.');
    }
    state.lastError = e.message;
    if (!silent) toast(e.message);
  } finally {
    state.syncing = false;
  }
  render();
  if (state.resync) { state.resync = false; sync(); }
}

async function flushQueue() {
  while (state.queue.length) {
    const op = state.queue[0];
    try {
      if (op.kind === 'add') await api.call('addEntry', { entry: op.entry }, state.pin);
      else if (op.kind === 'update') await api.call('updateEntry', { entry: op.entry }, state.pin);
      else if (op.kind === 'delete') await api.call('deleteEntry', { id: op.id }, state.pin);
    } catch (e) {
      // 서버가 내용 자체를 거절한 경우만 버리고, 네트워크·인증·잠금 문제는 나중에 재시도
      if (!(e instanceof api.ApiError) || /비밀번호|잠겼|다른 저장/.test(e.message)) throw e;
      toast(`저장 실패: ${e.message}`);
    }
    state.queue.shift();
    save('queue', state.queue);
  }
}

/** 서버 데이터 위에 아직 전송 못 한 작업을 다시 얹음 */
function applyQueueLocally() {
  for (const op of state.queue) {
    const list = state.data.entries;
    if (op.kind === 'delete') {
      state.data.entries = list.filter(e => e.id !== op.id);
    } else {
      const i = list.findIndex(e => e.id === op.entry.id);
      const merged = { ...(i >= 0 ? list[i] : { createdAt: new Date().toISOString() }), ...op.entry, pending: true };
      if (i >= 0) list[i] = merged; else list.push(merged);
    }
  }
}

const stripEntry = e => ({ id: e.id, date: e.date, user: e.user, type: e.type, amount: e.amount, category: e.category, memo: e.memo || '' });

function upsertEntry(entry, isNew) {
  const clean = stripEntry(entry);
  if (isNew) {
    state.queue.push({ kind: 'add', entry: clean });
  } else {
    const queuedAdd = state.queue.find(q => q.kind === 'add' && q.entry.id === clean.id);
    if (queuedAdd) queuedAdd.entry = clean;
    else state.queue.push({ kind: 'update', entry: clean });
  }
  applyQueueLocally();
  persist();
  render();
  sync();
}

function removeEntry(id) {
  const wasQueuedAdd = state.queue.some(q => q.kind === 'add' && q.entry.id === id);
  state.queue = state.queue.filter(q => (q.entry ? q.entry.id !== id : true));
  if (!wasQueuedAdd) state.queue.push({ kind: 'delete', id });
  state.data.entries = state.data.entries.filter(e => e.id !== id);
  persist();
  render();
  sync();
}

/** 카테고리·예산처럼 즉시 서버에 반영해야 하는 작업 */
async function online(action, payload, btn) {
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '저장 중…'; }
  try {
    return await api.call(action, payload, state.pin);
  } catch (e) {
    toast(e instanceof api.NetworkError ? '인터넷 연결이 필요해요.' : e.message);
    throw e;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

/* ───────────────────────── 화면 공통 ───────────────────────── */

const TITLES = { home: '공유가계부', list: '내역', stats: '통계', settings: '설정' };

function render() {
  if (!state.pin || !state.me) return renderLogin();
  $('#login').hidden = true;
  $('#app').hidden = false;
  C.destroyAll();

  const renderers = { home: renderHome, list: renderList, stats: renderStats, settings: renderSettings };
  const out = (renderers[state.tab] || renderHome)();
  const [html, after] = Array.isArray(out) ? out : [out];
  $('#view').innerHTML = html;
  after?.();

  document.querySelectorAll('.tab[data-tab]').forEach(t => t.classList.toggle('active', t.dataset.tab === state.tab));
  $('#title').textContent = TITLES[state.tab];
  renderSyncStatus();
}

function renderSyncStatus() {
  const el = $('#sync');
  if (!el) return;
  const waiting = state.queue.length;
  let text, cls = '';
  if (state.syncing) { text = '동기화 중…'; cls = 'busy'; }
  else if (waiting) { text = `전송 대기 ${waiting}건`; cls = 'warn'; }
  else if (state.lastError) { text = '오프라인'; cls = 'warn'; }
  else { text = api.isDemo ? '데모 모드' : '✓ 최신'; }
  el.textContent = text;
  el.className = `sync ${cls}`;
}

function go(tab) {
  if (tab === 'list') markSeen();
  state.tab = tab;
  save('tab', tab);
  render();
  window.scrollTo(0, 0);
}

function monthNav() {
  const cur = S.ymOf(todayStr());
  return `<div class="month-nav">
    <button class="icon-btn" data-act="month" data-step="-1" aria-label="이전 달">‹</button>
    <button class="month-label" data-act="month" data-step="0">${monthLabel(state.month)}</button>
    <button class="icon-btn" data-act="month" data-step="1" aria-label="다음 달" ${state.month >= cur ? 'disabled' : ''}>›</button>
  </div>`;
}

function entryRow(e) {
  const c = catMeta(e.category);
  const isNew = state.newIds.has(e.id);
  return `<li class="entry${isNew ? ' is-new' : ''}" data-act="edit-entry" data-id="${esc(e.id)}">
    <span class="cat-ico" style="--c:${c.color}">${esc(c.icon)}</span>
    <div class="entry-main">
      <div class="entry-title">${esc(e.category)} ${userTag(e.user)}${e.pending ? ' <span class="pending" title="전송 대기">⏳</span>' : ''}</div>
      ${e.memo ? `<div class="entry-sub">${esc(e.memo)}</div>` : ''}
    </div>
    <div class="entry-amt ${e.type === '입금' ? 'in' : 'out'}">${e.type === '입금' ? '+' : '-'}${won(e.amount)}</div>
  </li>`;
}

function card(title, body, extra = '') {
  return `<section class="card ${extra}">${title ? `<h2>${title}</h2>` : ''}${body}</section>`;
}

/* ───────────────────────── 홈 ───────────────────────── */

function newFromPartner() {
  const seen = load('lastSeen');
  if (!seen) return [];
  return entries().filter(e => e.user !== state.me && (e.createdAt || '') > seen);
}

function markSeen() {
  state.newIds = new Set(newFromPartner().map(e => e.id));
  save('lastSeen', new Date().toISOString());
}

function renderHome() {
  const m = state.month;
  const E = entries();
  const you = other(state.me);
  const fresh = newFromPartner();

  const banner = fresh.length
    ? `<button class="banner" data-act="see-new">💌 <b>${esc(you)}</b>님이 새 내역 <b>${fresh.length}건</b>을 기록했어요 <span>보기 ›</span></button>`
    : '';

  const people = [state.me, you].map(u => personCard(u, S.summary(E, m, u))).join('');

  const recent = sortEntries(E.filter(e => e.date.startsWith(m))).slice(0, 5);
  const recentHtml = recent.length
    ? `<ul class="entries">${recent.map(entryRow).join('')}</ul><button class="link-btn" data-act="tab" data-tab="list">전체 내역 보기 ›</button>`
    : `<div class="empty"><p>이번 달 기록이 아직 없어요</p><button class="btn primary sm" data-act="new-entry">첫 기록 남기기</button></div>`;

  return `${monthNav()}${banner}
    <div class="people">${people}</div>
    ${battleCard(m)}
    ${budgetCard(m)}
    ${card('최근 내역', recentHtml)}`;
}

function personCard(u, s) {
  return `<section class="card person" style="--u:${USER_COLORS[u]}">
    <div class="person-head"><span class="dot"></span>${esc(u)}${u === state.me ? '<small>나</small>' : ''}</div>
    <dl>
      <div><dt>수입</dt><dd class="in">${won(s.income)}</dd></div>
      <div><dt>지출</dt><dd class="out">${won(s.expense)}</dd></div>
      <div><dt>남은 돈</dt><dd class="${s.net < 0 ? 'out' : ''}">${won(s.net)}</dd></div>
    </dl>
    <div class="rate">
      <div class="bar"><span style="width:${clamp01(s.rate) * 100}%"></span></div>
      <span>저축률 <b>${pct(s.rate)}</b></span>
    </div>
  </section>`;
}

function battleCard(m) {
  const b = S.savingsBattle(entries(), m, USERS, todayStr());
  if (b.rows.every(r => r.pct == null)) {
    return card('🏆 절약 대결', '<p class="muted">지난달 기록이 쌓이면 시작돼요. 각자 <b>최근 3개월 평균 지출</b>과 비교해서 누가 더 아꼈는지 겨뤄요.</p>');
  }
  const rows = b.rows.map(r => {
    if (r.pct == null) return `<div class="battle-row">${userTag(r.user)}<span class="muted">비교할 지난 기록이 없어요</span></div>`;
    const saved = r.pct >= 0;
    const ratio = r.expected ? r.spent / r.expected : 0;
    return `<div class="battle-row${b.winner === r.user ? ' winner' : ''}">
      <div class="battle-top">${userTag(r.user)}${b.winner === r.user ? '<span class="crown">👑</span>' : ''}
        <span class="battle-pct ${saved ? 'good' : 'bad'}">평소보다 ${Math.abs(Math.round(r.pct * 100))}% ${saved ? '덜' : '더'} 씀</span></div>
      <div class="bar battle-bar" style="--u:${USER_COLORS[r.user]}"><span style="width:${Math.min(ratio, 1.5) / 1.5 * 100}%"></span><i style="left:${100 / 1.5}%"></i></div>
      <div class="battle-sub">${won(r.spent)} / 평소 ${won(r.expected)}</div>
    </div>`;
  }).join('');
  const note = b.partial ? '오늘까지의 페이스 기준 · 막대의 세로선이 평소 수준' : '한 달 전체 기준 · 막대의 세로선이 평소 수준';
  return card('🏆 절약 대결', `<p class="sub">${note}</p>${rows}`);
}

function budgetCard(m) {
  const list = S.budgetStatus(entries(), state.data.budgets, m, state.me);
  if (!list.length) {
    return card('🎯 내 예산', '<p class="muted">카테고리별 월 예산을 정하면 얼마나 썼는지 한눈에 볼 수 있어요.</p><button class="btn ghost sm" data-act="budgets">예산 설정하기</button>');
  }
  const progress = S.monthProgress(m, todayStr());
  const rows = list.map(b => {
    const c = catMeta(b.category);
    const level = b.pct >= 1 ? 'over' : b.pct >= 0.8 ? 'warn' : '';
    return `<div class="budget-row ${level}">
      <div class="budget-top"><span>${esc(c.icon)} ${esc(b.category)}</span><span><b>${won(b.spent)}</b> / ${won(b.budget)}</span></div>
      <div class="bar budget-bar"><span style="width:${clamp01(b.pct) * 100}%"></span>${progress < 1 ? `<i style="left:${progress * 100}%"></i>` : ''}</div>
      ${b.pct >= 1 ? `<div class="budget-note">🚨 ${won(b.spent - b.budget)} 초과</div>` : b.pct >= 0.8 ? `<div class="budget-note">⚠️ ${pct(b.pct)} 사용</div>` : ''}
    </div>`;
  }).join('');
  return card('🎯 내 예산', `${progress < 1 ? '<p class="sub">세로선은 오늘까지 써도 되는 적정선</p>' : ''}${rows}`);
}

/* ───────────────────────── 내역 ───────────────────────── */

function renderList() {
  const m = state.month;
  const f = state.filter;
  const all = entries().filter(e => e.date.startsWith(m));
  const list = sortEntries(all.filter(e =>
    (f.user === 'all' || e.user === f.user) &&
    (f.type === 'all' || e.type === f.type) &&
    (!f.category || e.category === f.category)));

  const income = list.filter(e => e.type === '입금').reduce((s, e) => s + e.amount, 0);
  const expense = list.filter(e => e.type === '출금').reduce((s, e) => s + e.amount, 0);

  const chips = (key, options) => `<div class="chips">${options.map(([val, label]) =>
    `<button class="chip${f[key] === val ? ' on' : ''}" data-act="filter" data-key="${key}" data-val="${esc(val)}">${label}</button>`).join('')}</div>`;

  const usedCats = [...new Set(all.map(e => e.category))];
  const catOptions = [...state.data.categories.map(c => c.name), ...usedCats].filter((v, i, a) => a.indexOf(v) === i);

  const groups = new Map();
  for (const e of list) {
    if (!groups.has(e.date)) groups.set(e.date, []);
    groups.get(e.date).push(e);
  }
  const body = list.length
    ? [...groups].map(([date, items]) => {
      const out = items.filter(e => e.type === '출금').reduce((s, e) => s + e.amount, 0);
      return `<div class="day-group"><div class="day-head"><span>${dateLabel(date)}</span>${out ? `<span>-${won(out)}</span>` : ''}</div>
        <ul class="entries">${items.map(entryRow).join('')}</ul></div>`;
    }).join('')
    : '<div class="empty card"><p>조건에 맞는 내역이 없어요</p></div>';

  return `${monthNav()}
    <div class="filters">
      ${chips('user', [['all', '전체'], ...USERS.map(u => [u, u])])}
      ${chips('type', [['all', '전체'], ['입금', '수입'], ['출금', '지출']])}
      <select class="select" data-change="category-filter" aria-label="카테고리 필터">
        <option value="">모든 카테고리</option>
        ${catOptions.map(n => `<option value="${esc(n)}" ${f.category === n ? 'selected' : ''}>${esc(catMeta(n).icon)} ${esc(n)}</option>`).join('')}
      </select>
    </div>
    <div class="totals"><span>수입 <b class="in">${won(income)}</b></span><span>지출 <b class="out">${won(expense)}</b></span><span>${list.length}건</span></div>
    ${body}`;
}

/* ───────────────────────── 통계 ───────────────────────── */

function renderStats() {
  const m = state.month;
  const u = state.statsScope;
  const E = entries();
  const today = todayStr();
  const months = S.monthRange(m, 12);
  const trend = S.monthly(E, months, u);
  const active = trend.filter(r => r.income || r.expense);
  const avgExpense = avg(active.map(r => r.expense));
  const avgRate = avg(active.filter(r => r.rate != null).map(r => r.rate));

  const scopeSeg = `<div class="seg scope">${[['all', '함께'], ...USERS.map(x => [x, x])].map(([val, label]) =>
    `<button class="${u === val ? 'on' : ''}" data-act="scope" data-val="${val}" ${val !== 'all' ? `style="--u:${USER_COLORS[val]}"` : ''}>${label}</button>`).join('')}</div>`;

  // 카테고리
  const cat = S.byCategory(E, m, u);
  const prev = new Map(S.byCategory(E, S.addMonths(m, -1), u).rows.map(r => [r.category, r.amount]));
  const catRows = cat.rows.map(r => {
    const c = catMeta(r.category);
    const before = prev.get(r.category) || 0;
    const diff = r.amount - before;
    const diffHtml = before ? `<span class="diff ${diff > 0 ? 'bad' : 'good'}">${diff > 0 ? '▲' : '▼'} ${C.short(Math.abs(diff))}</span>` : '<span class="diff">신규</span>';
    const open = state.statsCat === r.category;
    return `<li class="cat-row${open ? ' open' : ''}" data-act="stat-cat" data-cat="${esc(r.category)}">
        <span class="cat-ico" style="--c:${c.color}">${esc(c.icon)}</span>
        <div class="cat-main"><div class="cat-top"><span>${esc(r.category)} <small>${r.count}건</small></span><b>${won(r.amount)}</b></div>
          <div class="bar thin"><span style="width:${r.share * 100}%;background:${c.color}"></span></div>
          <div class="cat-bottom"><span>${pct(r.share, 1)}</span>${diffHtml}</div></div>
      </li>${open ? '<li class="cat-trend"><div class="chart h160"><canvas id="c-cat"></canvas></div><p class="sub center">최근 12개월 추이</p></li>' : ''}`;
  }).join('');
  const catBody = cat.rows.length
    ? `<div class="donut-wrap"><div class="chart h200"><canvas id="c-donut"></canvas></div>
         <div class="donut-center"><small>총 지출</small><b>${won(cat.total)}</b></div></div>
       <p class="sub center">카테고리를 누르면 월별 추이를 볼 수 있어요</p>
       <ul class="cat-list">${catRows}</ul>`
    : '<p class="muted">이번 달 지출이 없어요</p>';

  // 지은 vs 홍균
  let compare = '';
  let cmpCats = [];
  if (u === 'all') {
    const both = S.byCategory(E, m, 'all').rows.slice(0, 8);
    cmpCats = both.map(r => r.category);
    const s = Object.fromEntries(USERS.map(x => [x, S.summary(E, m, x)]));
    const vs = USERS.map(x => `<div class="vs-side" style="--u:${USER_COLORS[x]}"><span>${esc(x)}</span><b>${pct(s[x].rate)}</b><small>저축률</small></div>`).join('<div class="vs-mid">VS</div>');
    compare = card('💑 지은 vs 홍균', `
      <div class="vs">${vs}</div>
      <h3>저축률 추이</h3><div class="chart h180"><canvas id="c-rate"></canvas></div>
      ${cmpCats.length ? `<h3>이번 달 카테고리별 지출</h3><div class="chart" style="height:${cmpCats.length * 40 + 50}px"><canvas id="c-cmp"></canvas></div>` : ''}`);
  }

  // 요일 패턴
  const wk = S.weekdayAvg(E, S.monthRange(m, 3), u, today);
  const maxWk = Math.max(...wk);
  const weekInsight = maxWk > 0 ? `<b>${WEEK[wk.indexOf(maxWk)]}요일</b>에 가장 많이 써요 (하루 평균 ${won(maxWk)})` : '';

  // 큰 지출
  const top = S.topExpenses(E, m, u);

  const html = `${monthNav()}${scopeSeg}
    ${card('📈 월별 추이', `<p class="sub">최근 12개월</p><div class="chart h220"><canvas id="c-trend"></canvas></div>
      <div class="kv"><div><small>월평균 지출</small><b>${avgExpense == null ? '–' : won(avgExpense)}</b></div><div><small>평균 저축률</small><b>${pct(avgRate)}</b></div></div>`)}
    ${card('🍩 카테고리별 지출', catBody)}
    ${compare}
    ${card('🗓️ 지출 캘린더', heatmap(m, u))}
    ${card('📅 요일별 지출 패턴', `<p class="sub">최근 3개월 · 하루 평균</p><div class="chart h160"><canvas id="c-week"></canvas></div>${weekInsight ? `<p class="insight">${weekInsight}</p>` : ''}`)}
    ${card('💸 이번 달 큰 지출 TOP 5', top.length ? `<ol class="entries ranked">${top.map(entryRow).join('')}</ol>` : '<p class="muted">이번 달 지출이 없어요</p>')}`;

  const after = () => {
    C.trend($('#c-trend'), trend);
    if (cat.rows.length) C.donut($('#c-donut'), cat.rows, n => catMeta(n).color);
    if (state.statsCat) C.categoryTrend($('#c-cat'), months, S.categoryMonthly(E, months, u, state.statsCat), catMeta(state.statsCat).color);
    if (u === 'all') {
      C.rateCompare($('#c-rate'), months, Object.fromEntries(USERS.map(x => [x, S.monthly(E, months, x).map(r => r.rate)])));
      if (cmpCats.length) {
        C.userCompare($('#c-cmp'), cmpCats.map(n => `${catMeta(n).icon} ${n}`),
          Object.fromEntries(USERS.map(x => [x, cmpCats.map(n => S.byCategory(E, m, x).rows.find(r => r.category === n)?.amount || 0)])));
      }
    }
    C.weekday($('#c-week'), wk, WEEK);
  };
  return [html, after];
}

function heatmap(m, u) {
  const days = S.daily(entries(), m, u);
  const max = Math.max(...days, 1);
  const first = new Date(`${m}-01T00:00`).getDay();
  const today = todayStr();
  let zero = 0, counted = 0;
  const cells = days.map((v, i) => {
    const ds = `${m}-${pad(i + 1)}`;
    const future = ds > today;
    if (!future) { counted++; if (!v) zero++; }
    const level = v ? 0.18 + 0.82 * Math.sqrt(v / max) : 0;
    const cls = future ? ' future' : !v ? ' zero' : '';
    return `<button class="hm-c${cls}" style="--a:${level}" data-act="day" data-date="${ds}" data-amt="${v}"><span>${i + 1}</span></button>`;
  }).join('');
  return `<div class="heatmap">${WEEK.map(w => `<div class="hm-h">${w}</div>`).join('')}${'<div></div>'.repeat(first)}${cells}</div>
    <p class="insight">${counted ? `무지출 <b>${zero}일</b> / ${counted}일${zero ? ' 🌱' : ''}` : ''}</p>`;
}

/* ───────────────────────── 설정 ───────────────────────── */

function renderSettings() {
  const cats = state.data.categories;
  const catList = type => cats.filter(c => c.type === type).map(c =>
    `<li class="set-row" data-act="edit-cat" data-name="${esc(c.name)}"><span class="cat-ico" style="--c:${c.color}">${esc(c.icon)}</span><span>${esc(c.name)}</span><span class="chev">›</span></li>`).join('');

  const myBudgets = state.data.budgets.filter(b => b.user === state.me);
  const syncText = state.lastSync ? new Date(state.lastSync).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '없음';

  return `
    ${card('👤 나는', `<div class="seg">${USERS.map(u => `<button class="${state.me === u ? 'on' : ''}" style="--u:${USER_COLORS[u]}" data-act="set-me" data-user="${u}">${u}</button>`).join('')}</div>
      <p class="sub">새 기록의 작성자가 자동으로 선택돼요.</p>`)}
    ${card('🎯 내 월 예산', `<p class="sub">${myBudgets.length ? `${myBudgets.length}개 카테고리 · 합계 ${won(myBudgets.reduce((s, b) => s + b.amount, 0))}` : '아직 설정한 예산이 없어요'}</p>
      <button class="btn ghost" data-act="budgets">예산 설정</button>`)}
    ${card('🏷️ 카테고리', `<h3>지출</h3><ul class="set-list">${catList('출금')}</ul><h3>수입</h3><ul class="set-list">${catList('입금')}</ul>
      <button class="btn ghost" data-act="edit-cat">+ 카테고리 추가</button>`)}
    ${isStandalone() ? '' : card('📱 아이폰에 설치하기', `<ol class="howto"><li>Safari에서 이 페이지를 열고</li><li>아래쪽 <b>공유 버튼(□↑)</b>을 누른 뒤</li><li><b>홈 화면에 추가</b>를 선택하세요</li></ol>`)}
    ${card('🔄 데이터', `<div class="kv"><div><small>마지막 동기화</small><b>${syncText}</b></div><div><small>전송 대기</small><b>${state.queue.length}건</b></div></div>
      ${state.lastError ? `<p class="error-text">${esc(state.lastError)}</p>` : ''}
      <button class="btn ghost" data-act="sync">지금 동기화</button>`)}
    ${card('🔒 보안', `<button class="btn ghost" data-act="change-pin">비밀번호 변경</button><button class="btn ghost danger-text" data-act="logout">로그아웃</button>`)}
    <p class="footer">공유가계부 · 지은 💕 홍균${api.isDemo ? ' · 데모 모드' : ''}</p>`;
}

/* ───────────────────────── 바텀 시트 ───────────────────────── */

function openSheet(html, mount) {
  const root = $('#sheet-root');
  root.innerHTML = `<div class="backdrop" data-act="close-sheet"></div>
    <div class="sheet" role="dialog" aria-modal="true"><div class="grabber"></div>${html}</div>`;
  root.classList.add('open');
  document.body.classList.add('sheet-open');
  mount?.(root.querySelector('.sheet'));
}

function closeSheet() {
  const root = $('#sheet-root');
  root.classList.remove('open');
  root.innerHTML = '';
  document.body.classList.remove('sheet-open');
}

const parseAmount = s => Number(String(s).replace(/[^\d]/g, '')) || 0;

function openEntrySheet(existing) {
  const isNew = !existing;
  const curMonth = S.ymOf(todayStr());
  const f = existing ? { ...existing } : {
    id: uid(),
    date: state.month === curMonth ? todayStr() : `${state.month}-01`,
    user: state.me, type: '출금', amount: 0, category: '', memo: '',
  };

  openSheet(`
    <form class="entry-form" novalidate>
      <div class="seg type-seg">
        <button type="button" data-type="출금" class="${f.type === '출금' ? 'on' : ''}">💸 지출</button>
        <button type="button" data-type="입금" class="${f.type === '입금' ? 'on' : ''}">💰 수입</button>
      </div>
      <label class="amount-field"><input name="amount" inputmode="numeric" autocomplete="off" placeholder="0" value="${f.amount ? f.amount.toLocaleString('ko-KR') : ''}" aria-label="금액"><span>원</span></label>
      <div class="quick">${[1000, 10000, 50000, 100000].map(v => `<button type="button" data-add="${v}">+${C.short(v)}</button>`).join('')}<button type="button" data-add="0">지우기</button></div>
      <div class="field-label">카테고리</div>
      <div class="cat-chips"></div>
      <div class="row2">
        <label class="field"><span>날짜</span><input type="date" name="date" value="${f.date}" required></label>
        <div class="field"><span>작성자</span><div class="seg user-seg">${USERS.map(u => `<button type="button" data-user="${u}" class="${f.user === u ? 'on' : ''}" style="--u:${USER_COLORS[u]}">${u}</button>`).join('')}</div></div>
      </div>
      <label class="field"><span>메모 (선택)</span><input name="memo" maxlength="200" value="${esc(f.memo)}" placeholder="예: 151 팩 2개" autocomplete="off"></label>
      <div class="actions">
        ${isNew ? '<button type="button" class="btn ghost" data-close>취소</button>' : '<button type="button" class="btn danger" data-del>삭제</button>'}
        <button class="btn primary" type="submit">${isNew ? '저장' : '수정'}</button>
      </div>
    </form>`, sheet => {
    const form = $('form', sheet);
    const amount = form.elements.amount;

    const usage = new Map();
    const since = S.addMonths(curMonth, -3);
    for (const e of entries()) if (e.user === f.user && e.date >= since) usage.set(e.category, (usage.get(e.category) || 0) + 1);

    const drawCats = () => {
      let list = state.data.categories.filter(c => c.type === f.type);
      if (f.category && !list.some(c => c.name === f.category)) list = [catMeta(f.category), ...list];
      list = [...list].sort((a, b) => (usage.get(b.name) || 0) - (usage.get(a.name) || 0) || a.order - b.order);
      $('.cat-chips', sheet).innerHTML = list.map(c =>
        `<button type="button" class="cat-chip${f.category === c.name ? ' on' : ''}" data-cat="${esc(c.name)}" style="--c:${c.color}">${esc(c.icon)} ${esc(c.name)}</button>`).join('');
    };
    drawCats();

    sheet.addEventListener('click', ev => {
      const t = ev.target.closest('button');
      if (!t) return;
      if (t.dataset.type) {
        if (f.type !== t.dataset.type) { f.type = t.dataset.type; f.category = ''; }
        sheet.querySelectorAll('[data-type]').forEach(b => b.classList.toggle('on', b === t));
        drawCats();
      } else if (t.dataset.cat) {
        f.category = t.dataset.cat;
        drawCats();
      } else if (t.dataset.user) {
        f.user = t.dataset.user;
        sheet.querySelectorAll('[data-user]').forEach(b => b.classList.toggle('on', b === t));
      } else if (t.dataset.add != null) {
        const v = Number(t.dataset.add);
        const next = v ? parseAmount(amount.value) + v : 0;
        amount.value = next ? next.toLocaleString('ko-KR') : '';
      } else if (t.hasAttribute('data-close')) {
        closeSheet();
      } else if (t.hasAttribute('data-del')) {
        if (confirm('이 내역을 삭제할까요?')) { removeEntry(f.id); closeSheet(); toast('삭제했어요'); }
      }
    });

    amount.addEventListener('input', () => {
      const n = parseAmount(amount.value);
      amount.value = n ? n.toLocaleString('ko-KR') : '';
    });

    form.addEventListener('submit', ev => {
      ev.preventDefault();
      f.amount = parseAmount(amount.value);
      f.date = form.elements.date.value;
      f.memo = form.elements.memo.value.trim();
      if (!f.amount) return toast('금액을 입력하세요');
      if (!f.category) return toast('카테고리를 선택하세요');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) return toast('날짜를 선택하세요');
      upsertEntry(f, isNew);
      closeSheet();
      toast(isNew ? '저장했어요 ✓' : '수정했어요 ✓');
    });

    if (isNew) amount.focus();
  });
}

function openCategorySheet(name) {
  const existing = name ? state.data.categories.find(c => c.name === name) : null;
  const c = existing ? { ...existing } : { name: '', type: '출금', icon: '📦', color: '#64748B', order: 50 };
  openSheet(`
    <form class="entry-form" novalidate>
      <h2>${existing ? '카테고리 수정' : '새 카테고리'}</h2>
      <div class="seg type-seg">
        <button type="button" data-type="출금" class="${c.type === '출금' ? 'on' : ''}">💸 지출</button>
        <button type="button" data-type="입금" class="${c.type === '입금' ? 'on' : ''}">💰 수입</button>
      </div>
      <div class="row2 cat-edit">
        <label class="field icon-field"><span>아이콘</span><input name="icon" value="${esc(c.icon)}" maxlength="4" autocomplete="off"></label>
        <label class="field"><span>이름</span><input name="name" value="${esc(c.name)}" maxlength="30" placeholder="예: 포켓몬카드" autocomplete="off"></label>
        <label class="field color-field"><span>색상</span><input type="color" name="color" value="${c.color}"></label>
      </div>
      ${existing ? '<p class="sub">이름을 바꾸면 기존 내역도 함께 바뀌어요.</p>' : ''}
      <div class="actions">
        ${existing ? '<button type="button" class="btn danger" data-del>삭제</button>' : '<button type="button" class="btn ghost" data-close>취소</button>'}
        <button class="btn primary" type="submit">저장</button>
      </div>
    </form>`, sheet => {
    const form = $('form', sheet);
    sheet.addEventListener('click', async ev => {
      const t = ev.target.closest('button');
      if (!t) return;
      if (t.dataset.type) {
        c.type = t.dataset.type;
        sheet.querySelectorAll('[data-type]').forEach(b => b.classList.toggle('on', b === t));
      } else if (t.hasAttribute('data-close')) {
        closeSheet();
      } else if (t.hasAttribute('data-del')) {
        if (!confirm(`'${c.name}' 카테고리를 삭제할까요?`)) return;
        try {
          state.data.categories = await online('deleteCategory', { name: c.name }, t);
          persist(); closeSheet(); render(); toast('삭제했어요');
        } catch { /* toast 표시됨 */ }
      }
    });
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const next = { ...c, name: form.elements.name.value.trim(), icon: form.elements.icon.value.trim() || '📦', color: form.elements.color.value };
      if (!next.name) return toast('이름을 입력하세요');
      try {
        state.data.categories = await online('saveCategory', { category: next, originalName: existing?.name || '' }, form.querySelector('[type=submit]'));
        if (existing && existing.name !== next.name) {
          state.data.entries.forEach(e => { if (e.category === existing.name) e.category = next.name; });
          state.data.budgets.forEach(b => { if (b.category === existing.name) b.category = next.name; });
        }
        persist(); closeSheet(); render(); toast('저장했어요 ✓');
      } catch { /* toast 표시됨 */ }
    });
  });
}

function openBudgetSheet() {
  const mine = new Map(state.data.budgets.filter(b => b.user === state.me).map(b => [b.category, b.amount]));
  const cats = state.data.categories.filter(c => c.type === '출금');
  const recent = S.monthRange(S.addMonths(S.ymOf(todayStr()), -1), 3);
  const avgOf = name => avg(recent.map(m => S.byCategory(entries(), m, state.me).rows.find(r => r.category === name)?.amount || 0)) || 0;

  openSheet(`
    <form class="entry-form" novalidate>
      <h2>${esc(state.me)}의 월 예산</h2>
      <p class="sub">비워 두면 예산 없음. 회색 숫자는 최근 3개월 평균이에요.</p>
      <ul class="budget-edit">${cats.map(c => `<li>
        <span class="cat-ico" style="--c:${c.color}">${esc(c.icon)}</span>
        <div><div>${esc(c.name)}</div><small>평균 ${won(avgOf(c.name))}</small></div>
        <input inputmode="numeric" data-cat="${esc(c.name)}" value="${mine.get(c.name) ? mine.get(c.name).toLocaleString('ko-KR') : ''}" placeholder="0" autocomplete="off">
      </li>`).join('')}</ul>
      <div class="actions"><button type="button" class="btn ghost" data-close>취소</button><button class="btn primary" type="submit">저장</button></div>
    </form>`, sheet => {
    const form = $('form', sheet);
    sheet.querySelectorAll('input[data-cat]').forEach(inp => inp.addEventListener('input', () => {
      const n = parseAmount(inp.value);
      inp.value = n ? n.toLocaleString('ko-KR') : '';
    }));
    $('[data-close]', sheet).addEventListener('click', closeSheet);
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const btn = form.querySelector('[type=submit]');
      const changed = [...sheet.querySelectorAll('input[data-cat]')]
        .map(inp => ({ category: inp.dataset.cat, amount: parseAmount(inp.value) }))
        .filter(b => (mine.get(b.category) || 0) !== b.amount);
      try {
        for (const b of changed) {
          state.data.budgets = await online('saveBudget', { budget: { user: state.me, ...b } }, btn);
        }
        persist(); closeSheet(); render(); toast(changed.length ? '예산을 저장했어요 ✓' : '변경 사항이 없어요');
      } catch { render(); }
    });
  });
}

function openPinSheet() {
  openSheet(`
    <form class="entry-form" novalidate>
      <h2>비밀번호 변경</h2>
      <p class="sub">바꾸면 상대방도 새 비밀번호로 다시 로그인해야 해요.</p>
      <label class="field"><span>새 비밀번호 (6자 이상)</span><input type="password" name="p1" autocomplete="new-password"></label>
      <label class="field"><span>한 번 더</span><input type="password" name="p2" autocomplete="new-password"></label>
      <div class="actions"><button type="button" class="btn ghost" data-close>취소</button><button class="btn primary" type="submit">변경</button></div>
    </form>`, sheet => {
    const form = $('form', sheet);
    $('[data-close]', sheet).addEventListener('click', closeSheet);
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const p1 = form.elements.p1.value, p2 = form.elements.p2.value;
      if (p1.length < 6) return toast('6자 이상 입력하세요');
      if (p1 !== p2) return toast('두 비밀번호가 달라요');
      try {
        await online('changePin', { newPin: p1 }, form.querySelector('[type=submit]'));
        state.pin = p1; save('pin', p1);
        closeSheet(); toast('비밀번호를 바꿨어요 ✓');
      } catch { /* toast 표시됨 */ }
    });
  });
}

/* ───────────────────────── 로그인 ───────────────────────── */

function renderLogin(message = '') {
  $('#app').hidden = true;
  const L = $('#login');
  L.hidden = false;
  let me = state.me || USERS[0];
  L.innerHTML = `
    <form class="login-card" novalidate>
      <img src="icons/icon-192.png" alt="" width="72" height="72">
      <h1>공유가계부</h1>
      <p class="sub">지은 💕 홍균의 수입·지출 공유</p>
      ${message ? `<p class="error-text">${esc(message)}</p>` : ''}
      <div class="field-label">나는</div>
      <div class="seg">${USERS.map(u => `<button type="button" data-user="${u}" class="${me === u ? 'on' : ''}" style="--u:${USER_COLORS[u]}">${u}</button>`).join('')}</div>
      <label class="field"><span>비밀번호</span><input type="password" name="pin" autocomplete="current-password" required></label>
      <button class="btn primary block" type="submit">시작하기</button>
    </form>`;
  const form = $('form', L);
  form.addEventListener('click', e => {
    const t = e.target.closest('[data-user]');
    if (!t) return;
    me = t.dataset.user;
    form.querySelectorAll('[data-user]').forEach(b => b.classList.toggle('on', b === t));
  });
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const pin = form.elements.pin.value;
    const btn = form.querySelector('[type=submit]');
    if (!pin) return toast('비밀번호를 입력하세요');
    btn.disabled = true; btn.textContent = '확인 중…';
    try {
      await api.call('ping', {}, pin);
      state.pin = pin; state.me = me;
      save('pin', pin); save('me', me);
      if (!load('lastSeen')) save('lastSeen', new Date().toISOString());
      render();
      sync();
    } catch (err) {
      toast(err.message);
      btn.disabled = false; btn.textContent = '시작하기';
    }
  });
}

function logout(message = '') {
  ['pin', 'cache', 'queue', 'lastSync'].forEach(remove);
  state.pin = null;
  state.data = { entries: [], categories: [], budgets: [] };
  state.queue = [];
  closeSheet();
  renderLogin(message);
}

/* ───────────────────────── 이벤트 ───────────────────────── */

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

const ACTIONS = {
  tab: t => go(t.dataset.tab),
  month: t => {
    const step = Number(t.dataset.step);
    const cur = S.ymOf(todayStr());
    state.month = step === 0 ? cur : S.addMonths(state.month, step);
    if (state.month > cur) state.month = cur;
    state.statsCat = null;
    render();
  },
  'new-entry': () => openEntrySheet(),
  'edit-entry': t => {
    const e = entries().find(x => x.id === t.dataset.id);
    if (e) openEntrySheet(e);
  },
  'see-new': () => { state.filter = { user: other(state.me), type: 'all', category: '' }; go('list'); },
  filter: t => { state.filter[t.dataset.key] = t.dataset.val; render(); },
  scope: t => { state.statsScope = t.dataset.val; render(); },
  'stat-cat': t => {
    state.statsCat = state.statsCat === t.dataset.cat ? null : t.dataset.cat;
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  },
  day: t => toast(`${dateLabel(t.dataset.date)} · 지출 ${won(Number(t.dataset.amt))}`),
  'close-sheet': closeSheet,
  sync: () => sync({ silent: false }),
  'set-me': t => { state.me = t.dataset.user; save('me', state.me); render(); toast(`${state.me}(으)로 바꿨어요`); },
  'edit-cat': t => openCategorySheet(t.dataset.name),
  budgets: openBudgetSheet,
  'change-pin': openPinSheet,
  logout: () => { if (confirm('로그아웃할까요? 이 기기에 저장된 데이터가 지워져요.')) logout(); },
};

document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]');
  if (t && ACTIONS[t.dataset.act]) ACTIONS[t.dataset.act](t, e);
});

document.addEventListener('change', e => {
  if (e.target.matches('[data-change="category-filter"]')) {
    state.filter.category = e.target.value;
    render();
  }
});

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
window.addEventListener('online', () => sync());
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.tab === 'stats') render(); });

/* ───────────────────────── 시작 ───────────────────────── */

if ('serviceWorker' in navigator && !api.isDemo) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

if (api.isDemo && !state.pin) {
  state.pin = 'demo'; state.me = state.me || '홍균';
  save('pin', state.pin); save('me', state.me);
  if (!load('lastSeen')) save('lastSeen', new Date(Date.now() - 3 * 864e5).toISOString());
}

render();
sync();
