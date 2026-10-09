import { USERS, USER_VAR, CAT_PALETTE } from './config.js';
import * as api from './api.js';
import * as S from './stats.js';
import * as C from './charts.js';
import { load, save, remove } from './store.js';

/* ───────────────────────── 유틸 ───────────────────────── */

const $ = (sel, el = document) => el.querySelector(sel);
const pad = n => String(n).padStart(2, '0');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = n => Math.round(n).toLocaleString('ko-KR');
const won = n => `${num(n)}원`;
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
  return `${dt.getMonth() + 1}월 ${dt.getDate()}일 ${WEEK[dt.getDay()]}요일`;
};
const monthNum = ym => Number(ym.slice(5));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
const other = u => USERS.find(x => x !== u);
const uVar = u => `var(${USER_VAR[u]})`;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const ICON = {
  left: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
  chev: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
};

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

function catMeta(name) {
  const found = state.data.categories.find(x => x.name === name);
  if (found) {
    const i = state.data.categories.filter(x => x.type === found.type).indexOf(found);
    return { ...found, color: CAT_PALETTE[i % CAT_PALETTE.length] };
  }
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { name, icon: '·', type: '출금', color: CAT_PALETTE[h % CAT_PALETTE.length] };
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
      return logout('비밀번호가 바뀌었어요. 다시 로그인해 주세요.');
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
      toast(`저장하지 못했어요: ${e.message}`);
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
  if (btn) { btn.disabled = true; btn.textContent = '저장 중'; }
  try {
    return await api.call(action, payload, state.pin);
  } catch (e) {
    toast(e instanceof api.NetworkError ? '인터넷 연결이 필요해요' : e.message);
    throw e;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

/* ───────────────────────── 화면 공통 ───────────────────────── */

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
  renderTopbar();
}

function renderTopbar() {
  const cur = S.ymOf(todayStr());
  const y = state.month.slice(0, 4);
  $('#topbar-main').innerHTML = state.tab === 'settings'
    ? '<h1 class="page-title">설정</h1>'
    : `<div class="month-switch">
        <button class="chev-btn" data-act="month" data-step="-1" aria-label="이전 달">${ICON.left}</button>
        <button class="month-title" data-act="month" data-step="0">
          ${y !== cur.slice(0, 4) ? `<span class="year">${y}</span>` : ''}${monthNum(state.month)}월
        </button>
        <button class="chev-btn" data-act="month" data-step="1" aria-label="다음 달" ${state.month >= cur ? 'disabled' : ''}>${ICON.right}</button>
      </div>`;
  renderSyncStatus();
}

function renderSyncStatus() {
  const el = $('#sync');
  if (!el) return;
  const waiting = state.queue.length;
  let text = '', cls = '';
  if (state.syncing) { text = '동기화 중'; cls = 'busy'; }
  else if (waiting) { text = `전송 대기 ${waiting}`; cls = 'warn'; }
  else if (state.lastError) { text = '오프라인'; cls = 'warn'; }
  else if (api.isDemo) { text = '데모'; }
  el.textContent = text;
  el.className = `sync ${cls}`;
  el.hidden = !text;
}

function go(tab) {
  if (tab === 'list') markSeen();
  state.tab = tab;
  save('tab', tab);
  render();
  window.scrollTo(0, 0);
}

const section = (title, body, aside = '') =>
  `<section class="sec">${title ? `<header class="sec-head"><h2>${title}</h2>${aside ? `<span class="sec-aside">${aside}</span>` : ''}</header>` : ''}${body}</section>`;

const ico = c => `<span class="ico">${esc(c.icon)}</span>`;

function entryRow(e) {
  const c = catMeta(e.category);
  const isIn = e.type === '입금';
  return `<li class="row${state.newIds.has(e.id) ? ' is-new' : ''}" data-act="edit-entry" data-id="${esc(e.id)}">
    ${ico(c)}
    <div class="row-main">
      <div class="row-title">${esc(e.memo || e.category)}</div>
      <div class="row-sub"><b style="color:${uVar(e.user)}">${esc(e.user)}</b>${e.memo ? ` · ${esc(e.category)}` : ''}${e.pending ? ' · 전송 대기' : ''}</div>
    </div>
    <div class="row-amt${isIn ? ' in' : ''}">${isIn ? '+' : '−'}${num(e.amount)}</div>
  </li>`;
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
  const total = S.summary(E, m, 'all');
  const prev = S.summary(E, S.addMonths(m, -1), 'all');
  const isCur = m === S.ymOf(todayStr());
  const fresh = newFromPartner();

  let compare = '';
  if (!isCur && (prev.income || prev.expense)) {
    const d = total.net - prev.net;
    compare = `<p class="hero-note">지난달보다 ${C.short(Math.abs(d))}원 ${d >= 0 ? '더 남겼어요' : '덜 남겼어요'}</p>`;
  }

  const when = isCur ? '이번 달' : `${monthNum(m)}월에`;
  const hero = total.income > 0
    ? `<section class="hero">
        <p class="hero-label">${when} 둘이 남긴 돈</p>
        <p class="hero-amount${total.net < 0 ? ' neg' : ''}">${total.net < 0 ? '−' : ''}${num(Math.abs(total.net))}<small>원</small></p>
        <p class="hero-sub">수입 ${num(total.income)} · 지출 ${num(total.expense)}</p>
        ${compare}
      </section>`
    : `<section class="hero">
        <p class="hero-label">${when} 둘이 쓴 돈</p>
        <p class="hero-amount">${num(total.expense)}<small>원</small></p>
        <p class="hero-sub">아직 기록된 수입이 없어요</p>
      </section>`;

  const notice = fresh.length
    ? `<button class="notice" data-act="see-new"><i style="background:${uVar(you)}"></i><span>${esc(you)}님이 새로 <b>${fresh.length}건</b> 기록했어요</span><em>보기</em></button>`
    : '';

  const duo = `<section class="duo">${[state.me, you].map(u => duoCol(u, S.summary(E, m, u))).join('')}</section>`;

  const recent = sortEntries(E.filter(e => e.date.startsWith(m))).slice(0, 5);
  const recentBody = recent.length
    ? `<ul class="rows">${recent.map(entryRow).join('')}</ul>`
    : `<div class="blank"><p>아직 기록이 없어요</p><button class="btn ink sm" data-act="new-entry">첫 기록 남기기</button></div>`;

  return `${hero}${notice}${duo}
    ${battleSection(m)}
    ${budgetSection(m)}
    ${section('최근 기록', recentBody, recent.length ? '<button class="text-btn" data-act="tab" data-tab="list">전체 보기</button>' : '')}`;
}

function duoCol(u, s) {
  return `<div class="duo-col" style="--u:${uVar(u)}">
    <div class="duo-name"><i></i>${esc(u)}${u === state.me ? '<em>나</em>' : ''}</div>
    ${s.income > 0
      ? `<div class="duo-cap">남은 돈</div><div class="duo-net${s.net < 0 ? ' neg' : ''}">${s.net < 0 ? '−' : ''}${num(Math.abs(s.net))}<small>원</small></div>`
      : `<div class="duo-cap">쓴 돈</div><div class="duo-net">${num(s.expense)}<small>원</small></div>`}
    <dl class="duo-kv">
      <div><dt>수입</dt><dd>${num(s.income)}</dd></div>
      <div><dt>지출</dt><dd>${num(s.expense)}</dd></div>
    </dl>
    <div class="meter"><span style="width:${clamp01(s.rate) * 100}%"></span></div>
    <div class="duo-rate">저축률 <b>${pct(s.rate)}</b></div>
  </div>`;
}

function battleSection(m) {
  const b = S.savingsBattle(entries(), m, USERS, todayStr());
  if (b.rows.every(r => r.pct == null)) {
    return section('절약 대결', '<p class="note">한 달 이상 기록이 쌓이면 시작돼요. 각자 최근 석 달 평균과 비교해서 누가 더 아꼈는지 봐요.</p>');
  }
  const rows = b.rows.map(r => {
    if (r.pct == null) return `<div class="vs-row"><div class="vs-top"><b style="color:${uVar(r.user)}">${esc(r.user)}</b><span class="note">비교할 기록이 아직 없어요</span></div></div>`;
    const saved = r.pct >= 0;
    const ratio = r.expected ? r.spent / r.expected : 0;
    const lead = b.winner === r.user ? `<span class="tag">${b.partial ? '앞서는 중' : '승'}</span>` : '';
    return `<div class="vs-row" style="--u:${uVar(r.user)}">
      <div class="vs-top"><b>${esc(r.user)}</b>${lead}
        <span class="vs-pct ${saved ? 'good' : 'bad'}">${Math.abs(Math.round(r.pct * 100))}% ${saved ? '절약' : '초과'}</span></div>
      <div class="meter tick"><span style="width:${Math.min(ratio, 1.5) / 1.5 * 100}%"></span><i style="left:${100 / 1.5}%"></i></div>
      <div class="vs-sub">${won(r.spent)} 씀 · 평소 ${b.partial ? '이맘때 ' : ''}${won(r.expected)}</div>
    </div>`;
  }).join('');
  return section('절약 대결', rows, b.partial ? '오늘까지 기준' : '');
}

function budgetSection(m) {
  const list = S.budgetStatus(entries(), state.data.budgets, m, state.me);
  if (!list.length) {
    return section('내 예산', '<p class="note">카테고리별로 한 달 예산을 정해 두면 여기서 바로 확인할 수 있어요.</p><button class="btn line sm" data-act="budgets">예산 정하기</button>');
  }
  const progress = S.monthProgress(m, todayStr());
  const rows = list.map(b => {
    const c = catMeta(b.category);
    const level = b.pct >= 1 ? 'over' : b.pct >= 0.8 ? 'warn' : '';
    const left = b.budget - b.spent;
    return `<div class="bud ${level}">
      <div class="bud-top"><span>${esc(c.icon)}&nbsp; ${esc(b.category)}</span>
        <span class="bud-left">${left >= 0 ? `${num(left)}원 남음` : `${num(-left)}원 넘음`}</span></div>
      <div class="meter tick"><span style="width:${clamp01(b.pct) * 100}%"></span>${progress < 1 ? `<i style="left:${progress * 100}%"></i>` : ''}</div>
      <div class="bud-sub">${num(b.spent)} / ${num(b.budget)}</div>
    </div>`;
  }).join('');
  return section('내 예산', rows, `<button class="text-btn" data-act="budgets">수정</button>`);
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

  const pill = (key, val, label) =>
    `<button class="pill${f[key] === val ? ' on' : ''}" data-act="filter" data-key="${key}" data-val="${esc(val)}">${label}</button>`;

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
      return `<div class="day"><div class="day-head"><span>${dateLabel(date)}</span>${out ? `<span>−${num(out)}</span>` : ''}</div>
        <ul class="rows">${items.map(entryRow).join('')}</ul></div>`;
    }).join('')
    : '<div class="blank"><p>조건에 맞는 기록이 없어요</p></div>';

  return `<div class="filter-bar">
      ${pill('user', 'all', '모두')}${USERS.map(u => pill('user', u, u)).join('')}
      <span class="divider"></span>
      ${pill('type', 'all', '전체')}${pill('type', '입금', '수입')}${pill('type', '출금', '지출')}
    </div>
    <select class="select" data-change="category-filter" aria-label="카테고리">
      <option value="">카테고리 전체</option>
      ${catOptions.map(n => `<option value="${esc(n)}" ${f.category === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}
    </select>
    <div class="sum-line"><span>${list.length}건</span><span>수입 <b>${num(income)}</b></span><span>지출 <b>${num(expense)}</b></span></div>
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

  const scope = `<nav class="seg-line">${[['all', '함께'], ...USERS.map(x => [x, x])].map(([val, label]) =>
    `<button class="${u === val ? 'on' : ''}" data-act="scope" data-val="${val}">${label}</button>`).join('')}</nav>`;

  const legend = items => `<div class="legend">${items.map(([label, color, shape = 'sq']) => `<span><i class="${shape}" style="background:${color}"></i>${label}</span>`).join('')}</div>`;

  // 월별 추이
  const trendSec = section('월별 흐름', `
    ${legend([['수입', 'var(--bar-soft)'], ['지출', 'var(--text)'], ['남은 돈', 'var(--good)', 'ln']])}
    <div class="chart h200"><canvas id="c-trend"></canvas></div>
    <div class="facts"><div><span>월평균 지출</span><b>${avgExpense == null ? '–' : won(avgExpense)}</b></div><div><span>평균 저축률</span><b>${pct(avgRate)}</b></div></div>`, '최근 12개월');

  // 카테고리
  const cat = S.byCategory(E, m, u);
  const prev = new Map(S.byCategory(E, S.addMonths(m, -1), u).rows.map(r => [r.category, r.amount]));
  const catRows = cat.rows.map(r => {
    const c = catMeta(r.category);
    const before = prev.get(r.category) || 0;
    const diff = r.amount - before;
    const diffHtml = before
      ? `<span class="${diff > 0 ? 'bad' : 'good'}">${diff > 0 ? '+' : '−'}${C.short(Math.abs(diff))}</span>`
      : '<span>새로 씀</span>';
    const open = state.statsCat === r.category;
    return `<li class="cat${open ? ' open' : ''}" data-act="stat-cat" data-cat="${esc(r.category)}">
        <i class="dot" style="background:${c.color}"></i>
        <span class="cat-name">${esc(r.category)}</span>
        <span class="cat-pct">${pct(r.share)}</span>
        <span class="cat-amt">${num(r.amount)}</span>
        <span class="cat-diff">${diffHtml}</span>
      </li>${open ? '<li class="cat-chart"><div class="chart h140"><canvas id="c-cat"></canvas></div></li>' : ''}`;
  }).join('');
  const catSec = section('어디에 썼나', cat.rows.length
    ? `<p class="big-num">${num(cat.total)}<small>원</small></p>
       <div class="stack">${cat.rows.map(r => `<span style="flex:${r.amount};background:${catMeta(r.category).color}"></span>`).join('')}</div>
       <ul class="cats">${catRows}</ul>
       <p class="note small">항목을 누르면 월별 추이를 볼 수 있어요 · 오른쪽은 지난달 대비</p>`
    : '<p class="note">이 달에는 지출이 없어요</p>');

  // 지은 vs 홍균
  let duoSec = '';
  let rateSeries = null;
  if (u === 'all') {
    const s = Object.fromEntries(USERS.map(x => [x, S.summary(E, m, x)]));
    rateSeries = Object.fromEntries(USERS.map(x => [x, S.monthly(E, months, x).map(r => r.rate)]));
    const rows = S.byCategory(E, m, 'all').rows.slice(0, 7).map(r => r.category);
    const per = Object.fromEntries(USERS.map(x => [x, new Map(S.byCategory(E, m, x).rows.map(r => [r.category, r.amount]))]));
    const max = Math.max(1, ...rows.flatMap(n => USERS.map(x => per[x].get(n) || 0)));
    const [a, b] = USERS;
    const butterfly = rows.length ? `<div class="bfly">
        ${rows.map(n => {
          const va = per[a].get(n) || 0, vb = per[b].get(n) || 0;
          return `<div class="bfly-row">
            <div class="bfly-side l"><span>${va ? C.short(va) : ''}</span><i style="width:${va / max * 100}%;background:${uVar(a)}"></i></div>
            <div class="bfly-label">${esc(n)}</div>
            <div class="bfly-side r"><i style="width:${vb / max * 100}%;background:${uVar(b)}"></i><span>${vb ? C.short(vb) : ''}</span></div>
          </div>`;
        }).join('')}</div>` : '';

    duoSec = section(`${esc(a)}와 ${esc(b)}`, `
      <div class="face">${USERS.map(x => `<div style="--u:${uVar(x)}"><span>${esc(x)}</span><b>${pct(s[x].rate)}</b><small>저축률</small></div>`).join('')}</div>
      <h3>저축률 변화</h3>
      ${legend(USERS.map(x => [x, uVar(x), 'ln']))}
      <div class="chart h160"><canvas id="c-rate"></canvas></div>
      ${butterfly ? `<h3>이 달 카테고리별 지출</h3>${butterfly}` : ''}`);
  }

  // 요일
  const wk = S.weekdayAvg(E, S.monthRange(m, 3), u, today);
  const maxWk = Math.max(...wk);
  const weekSec = section('요일별 씀씀이', `
    <div class="chart h140"><canvas id="c-week"></canvas></div>
    ${maxWk > 0 ? `<p class="note">${WEEK[wk.indexOf(maxWk)]}요일에 가장 많이 써요. 하루 평균 ${won(maxWk)}</p>` : ''}`, '최근 3개월');

  const top = S.topExpenses(E, m, u);
  const topSec = section('큰 지출', top.length ? `<ol class="rows ranked">${top.map(entryRow).join('')}</ol>` : '<p class="note">이 달에는 지출이 없어요</p>', 'TOP 5');

  const html = `${scope}${trendSec}${catSec}${duoSec}${section('지출 달력', heatmap(m, u))}${weekSec}${topSec}`;

  const after = () => {
    C.trend($('#c-trend'), trend);
    if (state.statsCat) C.categoryTrend($('#c-cat'), months, S.categoryMonthly(E, months, u, state.statsCat), catMeta(state.statsCat).color);
    if (rateSeries) C.rateCompare($('#c-rate'), months, rateSeries);
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
    const level = v ? 0.12 + 0.78 * Math.sqrt(v / max) : 0;
    const cls = future ? ' future' : !v ? ' zero' : level > 0.4 ? ' hot' : '';
    return `<button class="cal-d${cls}${ds === today ? ' today' : ''}" style="--a:${level}" data-act="day" data-date="${ds}" data-amt="${v}"><span>${i + 1}</span></button>`;
  }).join('');
  return `<div class="cal">${WEEK.map(w => `<div class="cal-h">${w}</div>`).join('')}${'<div></div>'.repeat(first)}${cells}</div>
    ${counted ? `<p class="note">한 푼도 안 쓴 날 <b>${zero}일</b> · ${counted}일 중</p>` : ''}`;
}

/* ───────────────────────── 설정 ───────────────────────── */

function renderSettings() {
  const myBudgets = state.data.budgets.filter(b => b.user === state.me);
  const syncText = state.lastSync
    ? new Date(state.lastSync).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '없음';
  const chips = type => state.data.categories.filter(c => c.type === type)
    .map(c => `<button class="cat-chip" data-act="edit-cat" data-name="${esc(c.name)}">${esc(c.icon)} ${esc(c.name)}</button>`).join('');

  return `
    <div class="group-label">나는</div>
    <section class="group">
      <div class="seg">${USERS.map(u => `<button class="${state.me === u ? 'on' : ''}" style="--u:${uVar(u)}" data-act="set-me" data-user="${u}">${u}</button>`).join('')}</div>
      <p class="note small">새로 기록할 때 작성자로 자동 선택돼요</p>
    </section>

    <div class="group-label">관리</div>
    <section class="group list">
      <button class="item" data-act="budgets"><span>내 월 예산</span><em>${myBudgets.length ? `${myBudgets.length}개 · ${num(myBudgets.reduce((s, b) => s + b.amount, 0))}원` : '없음'}</em>${ICON.chev}</button>
      <button class="item" data-act="change-pin"><span>비밀번호 변경</span>${ICON.chev}</button>
      <button class="item" data-act="sync"><span>지금 동기화</span><em>${state.queue.length ? `대기 ${state.queue.length}건` : syncText}</em>${ICON.chev}</button>
    </section>
    ${state.lastError ? `<p class="note err">${esc(state.lastError)}</p>` : ''}

    <div class="group-label">지출 카테고리</div>
    <section class="group"><div class="chip-wrap">${chips('출금')}<button class="cat-chip add" data-act="edit-cat">+ 추가</button></div></section>
    <div class="group-label">수입 카테고리</div>
    <section class="group"><div class="chip-wrap">${chips('입금')}<button class="cat-chip add" data-act="edit-cat" data-type="입금">+ 추가</button></div></section>

    ${isStandalone() ? '' : `<div class="group-label">아이폰에 설치</div>
    <section class="group"><p class="note">Safari 아래쪽 공유 버튼을 누르고 <b>홈 화면에 추가</b>를 선택하면 앱처럼 쓸 수 있어요.</p></section>`}

    <section class="group list"><button class="item danger" data-act="logout"><span>로그아웃</span></button></section>
    <p class="colophon">공유가계부${api.isDemo ? ' · 데모' : ''}</p>`;
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
    <form class="form" novalidate>
      <nav class="seg-line type-tabs">
        <button type="button" data-type="출금" class="${f.type === '출금' ? 'on' : ''}">지출</button>
        <button type="button" data-type="입금" class="${f.type === '입금' ? 'on' : ''}">수입</button>
      </nav>
      <label class="amount"><input name="amount" inputmode="numeric" autocomplete="off" placeholder="0" value="${f.amount ? num(f.amount) : ''}" aria-label="금액"><span>원</span></label>
      <div class="quick">${[1000, 10000, 50000, 100000].map(v => `<button type="button" data-add="${v}">+${C.short(v)}</button>`).join('')}<button type="button" data-add="0">지우기</button></div>
      <div class="cat-grid"></div>
      <div class="fields">
        <label class="field"><span>날짜</span><input type="date" name="date" value="${f.date}" required></label>
        <div class="field"><span>누가</span><div class="seg small">${USERS.map(u => `<button type="button" data-user="${u}" class="${f.user === u ? 'on' : ''}" style="--u:${uVar(u)}">${u}</button>`).join('')}</div></div>
        <label class="field"><span>메모</span><input name="memo" maxlength="200" value="${esc(f.memo)}" placeholder="선택" autocomplete="off"></label>
      </div>
      <div class="actions">
        ${isNew ? '' : '<button type="button" class="btn line danger" data-del>삭제</button>'}
        <button class="btn ink" type="submit">${isNew ? '저장' : '수정'}</button>
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
      $('.cat-grid', sheet).innerHTML = list.map(c =>
        `<button type="button" class="tile${f.category === c.name ? ' on' : ''}" data-cat="${esc(c.name)}"><span>${esc(c.icon)}</span>${esc(c.name)}</button>`).join('');
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
        amount.value = next ? num(next) : '';
      } else if (t.hasAttribute('data-del')) {
        if (confirm('이 기록을 지울까요?')) { removeEntry(f.id); closeSheet(); toast('지웠어요'); }
      }
    });

    amount.addEventListener('input', () => {
      const n = parseAmount(amount.value);
      amount.value = n ? num(n) : '';
    });

    form.addEventListener('submit', ev => {
      ev.preventDefault();
      f.amount = parseAmount(amount.value);
      f.date = form.elements.date.value;
      f.memo = form.elements.memo.value.trim();
      if (!f.amount) return toast('금액을 입력해 주세요');
      if (!f.category) return toast('카테고리를 골라 주세요');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) return toast('날짜를 골라 주세요');
      upsertEntry(f, isNew);
      closeSheet();
      toast(isNew ? '기록했어요' : '고쳤어요');
    });

    if (isNew) amount.focus();
  });
}

function openCategorySheet(name, type = '출금') {
  const existing = name ? state.data.categories.find(c => c.name === name) : null;
  const c = existing ? { ...existing } : { name: '', type, icon: '', color: '#9C8F80', order: 50 };
  openSheet(`
    <form class="form" novalidate>
      <h2 class="sheet-title">${existing ? '카테고리 수정' : '새 카테고리'}</h2>
      <nav class="seg-line type-tabs">
        <button type="button" data-type="출금" class="${c.type === '출금' ? 'on' : ''}">지출</button>
        <button type="button" data-type="입금" class="${c.type === '입금' ? 'on' : ''}">수입</button>
      </nav>
      <div class="fields">
        <label class="field"><span>이모지</span><input name="icon" value="${esc(c.icon)}" maxlength="4" placeholder="🃏" autocomplete="off"></label>
        <label class="field"><span>이름</span><input name="name" value="${esc(c.name)}" maxlength="30" placeholder="예: 포켓몬카드" autocomplete="off"></label>
      </div>
      ${existing ? '<p class="note small">이름을 바꾸면 지난 기록도 같이 바뀌어요</p>' : ''}
      <div class="actions">
        ${existing ? '<button type="button" class="btn line danger" data-del>삭제</button>' : ''}
        <button class="btn ink" type="submit">저장</button>
      </div>
    </form>`, sheet => {
    const form = $('form', sheet);
    sheet.addEventListener('click', async ev => {
      const t = ev.target.closest('button');
      if (!t) return;
      if (t.dataset.type) {
        c.type = t.dataset.type;
        sheet.querySelectorAll('[data-type]').forEach(b => b.classList.toggle('on', b === t));
      } else if (t.hasAttribute('data-del')) {
        if (!confirm(`'${c.name}' 카테고리를 지울까요?`)) return;
        try {
          state.data.categories = await online('deleteCategory', { name: c.name }, t);
          persist(); closeSheet(); render(); toast('지웠어요');
        } catch { /* toast 표시됨 */ }
      }
    });
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const next = { ...c, name: form.elements.name.value.trim(), icon: form.elements.icon.value.trim() || '·' };
      if (!next.name) return toast('이름을 입력해 주세요');
      try {
        state.data.categories = await online('saveCategory', { category: next, originalName: existing?.name || '' }, form.querySelector('[type=submit]'));
        if (existing && existing.name !== next.name) {
          state.data.entries.forEach(e => { if (e.category === existing.name) e.category = next.name; });
          state.data.budgets.forEach(b => { if (b.category === existing.name) b.category = next.name; });
        }
        persist(); closeSheet(); render(); toast('저장했어요');
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
    <form class="form" novalidate>
      <h2 class="sheet-title">${esc(state.me)}의 월 예산</h2>
      <p class="note small">비워 두면 예산을 두지 않아요. 아래 회색 숫자는 최근 석 달 평균이에요.</p>
      <ul class="bud-edit">${cats.map(c => {
        const a = avgOf(c.name);
        return `<li>
          <span class="ico">${esc(c.icon)}</span>
          <div><div>${esc(c.name)}</div><small>${a ? `평균 ${num(a)}원` : '기록 없음'}</small></div>
          <input inputmode="numeric" data-cat="${esc(c.name)}" value="${mine.get(c.name) ? num(mine.get(c.name)) : ''}" placeholder="0" autocomplete="off">
        </li>`;
      }).join('')}</ul>
      <div class="actions"><button class="btn ink" type="submit">저장</button></div>
    </form>`, sheet => {
    const form = $('form', sheet);
    sheet.querySelectorAll('input[data-cat]').forEach(inp => inp.addEventListener('input', () => {
      const n = parseAmount(inp.value);
      inp.value = n ? num(n) : '';
    }));
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
        persist(); closeSheet(); render(); toast(changed.length ? '예산을 저장했어요' : '바뀐 내용이 없어요');
      } catch { render(); }
    });
  });
}

function openPinSheet() {
  openSheet(`
    <form class="form" novalidate>
      <h2 class="sheet-title">비밀번호 변경</h2>
      <p class="note small">바꾸면 상대방도 새 비밀번호로 다시 로그인해야 해요.</p>
      <div class="fields">
        <label class="field"><span>새 비밀번호</span><input type="password" name="p1" autocomplete="new-password" placeholder="6자 이상"></label>
        <label class="field"><span>한 번 더</span><input type="password" name="p2" autocomplete="new-password"></label>
      </div>
      <div class="actions"><button class="btn ink" type="submit">변경</button></div>
    </form>`, sheet => {
    const form = $('form', sheet);
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const p1 = form.elements.p1.value, p2 = form.elements.p2.value;
      if (p1.length < 6) return toast('6자 이상 입력해 주세요');
      if (p1 !== p2) return toast('두 비밀번호가 달라요');
      try {
        await online('changePin', { newPin: p1 }, form.querySelector('[type=submit]'));
        state.pin = p1; save('pin', p1);
        closeSheet(); toast('비밀번호를 바꿨어요');
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
    <form class="login" novalidate>
      <div class="login-mark"><i style="background:var(--p1)"></i><i style="background:var(--p2)"></i></div>
      <h1>공유가계부</h1>
      <p class="note">${USERS.join('와 ')}의 한 달</p>
      ${message ? `<p class="note err">${esc(message)}</p>` : ''}
      <div class="who-pick">${USERS.map(u => `<button type="button" data-user="${u}" class="${me === u ? 'on' : ''}" style="--u:${uVar(u)}"><i></i>${u}</button>`).join('')}</div>
      <label class="field"><span>비밀번호</span><input type="password" name="pin" autocomplete="current-password" required></label>
      <button class="btn ink block" type="submit">시작하기</button>
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
    if (!pin) return toast('비밀번호를 입력해 주세요');
    btn.disabled = true; btn.textContent = '확인 중';
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
  toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
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
  scope: t => { state.statsScope = t.dataset.val; state.statsCat = null; render(); },
  'stat-cat': t => {
    state.statsCat = state.statsCat === t.dataset.cat ? null : t.dataset.cat;
    const y = window.scrollY;
    render();
    window.scrollTo(0, y);
  },
  day: t => toast(`${dateLabel(t.dataset.date)} · ${Number(t.dataset.amt) ? won(Number(t.dataset.amt)) : '지출 없음'}`),
  'close-sheet': closeSheet,
  sync: () => sync({ silent: false }),
  'set-me': t => { state.me = t.dataset.user; save('me', state.me); render(); },
  'edit-cat': t => openCategorySheet(t.dataset.name, t.dataset.type),
  budgets: openBudgetSheet,
  'change-pin': openPinSheet,
  logout: () => { if (confirm('로그아웃할까요? 이 기기에 저장된 기록 사본이 지워져요.')) logout(); },
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
