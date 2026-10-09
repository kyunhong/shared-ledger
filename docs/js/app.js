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
const man = n => `${C.short(Math.round(n))}원`;
const pct = (v, digits = 0) => (v == null ? '–' : `${(v * 100).toFixed(digits)}%`);
const clamp01 = v => Math.max(0, Math.min(1, v || 0));
const avg = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];

/** 받침에 따라 조사 선택: josa('식비', '은', '는') → '식비는' */
function josa(word, withFinal, without) {
  const code = String(word).charCodeAt(String(word).length - 1) - 0xAC00;
  const has = code >= 0 && code <= 11171 && code % 28 !== 0;
  return `${word}${has ? withFinal : without}`;
}

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
  gear: '<svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/></svg>',
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
  query: '',
  statsScope: 'all',
  statsCat: null,
  newIds: new Set(),
  syncing: false,
  resync: false,
  lastError: null,
};

const entries = () => state.data.entries;
const sortEntries = list => [...list].sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || '').localeCompare(a.createdAt || ''));
const fixedSet = () => new Set(state.data.categories.filter(c => c.fixed).map(c => c.name));
const varEntries = () => S.variableOnly(entries(), fixedSet());
const budgetTotal = u => {
  const fixed = fixedSet();
  return state.data.budgets.filter(b => (u === 'all' || b.user === u) && !fixed.has(b.category)).reduce((s, b) => s + b.amount, 0);
};

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
  render({ keepScroll: true });
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
  render({ keepScroll: true });
  sync();
}

function removeEntry(id) {
  const wasQueuedAdd = state.queue.some(q => q.kind === 'add' && q.entry.id === id);
  state.queue = state.queue.filter(q => (q.entry ? q.entry.id !== id : true));
  if (!wasQueuedAdd) state.queue.push({ kind: 'delete', id });
  state.data.entries = state.data.entries.filter(e => e.id !== id);
  persist();
  render({ keepScroll: true });
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

const RENDERERS = { home: renderHome, together: renderTogether, list: renderList, stats: renderStats, settings: renderSettings };

function render({ keepScroll = false } = {}) {
  if (!state.pin || !state.me) return renderLogin();
  $('#login').hidden = true;
  $('#app').hidden = false;
  // 검색창에 입력 중이면 전체를 다시 그리지 않고 결과만 갱신
  if (state.tab === 'list' && document.activeElement?.matches('[data-input="search"]')) {
    $('#list-results').innerHTML = listResults();
    return;
  }
  const y = window.scrollY;
  C.destroyAll();
  const out = (RENDERERS[state.tab] || renderHome)();
  const [html, after] = Array.isArray(out) ? out : [out];
  $('#view').innerHTML = html;
  after?.();
  if (keepScroll) window.scrollTo(0, y);

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
  $('#gear').classList.toggle('on', state.tab === 'settings');
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

const section = (title, body, aside = '', cls = '') =>
  `<section class="sec ${cls}">${title ? `<header class="sec-head"><h2>${title}</h2>${aside ? `<span class="sec-aside">${aside}</span>` : ''}</header>` : ''}${body}</section>`;

const ico = c => `<span class="ico">${esc(c.icon)}</span>`;

const legend = items => `<div class="legend">${items.map(([label, color, shape = 'sq']) =>
  `<span><i class="${shape}" style="${shape === 'dash' ? `border-color:${color}` : `background:${color}`}"></i>${label}</span>`).join('')}</div>`;

function entryRow(e, { showDate = false } = {}) {
  const c = catMeta(e.category);
  const isIn = e.type === '입금';
  const sub = [`<b style="color:${uVar(e.user)}">${esc(e.user)}</b>`];
  if (e.memo) sub.push(esc(e.category));
  if (showDate) sub.push(`${Number(e.date.slice(5, 7))}/${Number(e.date.slice(8))}`);
  if (e.pending) sub.push('전송 대기');
  return `<li class="row${state.newIds.has(e.id) ? ' is-new' : ''}" data-id="${esc(e.id)}">
    <div class="row-inner" data-act="edit-entry" data-id="${esc(e.id)}">
      ${ico(c)}
      <div class="row-main">
        <div class="row-title">${esc(e.memo || e.category)}</div>
        <div class="row-sub">${sub.join(' · ')}</div>
      </div>
      <div class="row-amt${isIn ? ' in' : ''}">${isIn ? '+' : '−'}${num(e.amount)}</div>
    </div>
    <button class="row-del" data-act="swipe-del" data-id="${esc(e.id)}">삭제</button>
  </li>`;
}

/* ───────────────────────── 판단 문장 ───────────────────────── */

/** 페이스 결과를 한 문장으로: { text, tone } */
function paceHeadline(p, { past = false } = {}) {
  const verb = past ? '썼어요' : '쓰고 있어요';
  if (!p.day) return { text: '아직 오지 않은 달이에요', tone: '' };
  if (!p.base) return { text: `${past ? `${monthNum(p.month)}월에` : '이번 달'} ${won(p.spent)} 썼어요`, tone: '' };
  if (p.early && !past) return { text: '월초라 아직 판단하기 일러요', tone: '' };
  const d = Math.round((p.ratio - 1) * 100);
  const ref = p.base.kind === 'budget' ? '예산 페이스보다' : '평소보다';
  if (Math.abs(d) <= 3) return { text: `${p.base.kind === 'budget' ? '예산 페이스' : '평소'}와 비슷하게 ${verb}`, tone: '' };
  return d < 0
    ? { text: `${ref} <em class="good">${-d}% 덜</em> ${verb}`, tone: 'good' }
    : { text: `${ref} <em class="bad">${d}% 더</em> ${verb}`, tone: 'bad' };
}

function causeText(c) {
  if (!c.count || !c.usualCount) return '';
  const fmtCount = n => (Math.round(n * 10) / 10).toString();
  const more = c.count - c.usualCount >= 1.5 && c.count / c.usualCount >= 1.3;
  const pricier = c.usualTicket > 0 && c.ticket / c.usualTicket >= 1.25;
  if (more && pricier) return `더 자주(${fmtCount(c.usualCount)}→${c.count}회), 더 비싸게(1회 ${man(c.usualTicket)}→${man(c.ticket)}) 썼어요`;
  if (more) return `횟수가 늘었어요. 평소 ${fmtCount(c.usualCount)}회 → 이번 ${c.count}회`;
  if (pricier) return `횟수는 비슷한데 1회 금액이 ${man(c.usualTicket)} → ${man(c.ticket)}로 커졌어요`;
  return '';
}

function insights(m, u) {
  const today = todayStr();
  const fixed = fixedSet();
  const out = [];
  const dev = S.deviations(varEntries(), m, u, today).filter(d => Math.abs(d.diff) >= 5000);
  const up = dev.find(d => d.diff > 0);
  const down = dev.find(d => d.diff < 0);
  if (up) {
    const why = causeText(S.cause(entries(), m, u, up.category, today));
    out.push(`<b>${esc(up.category)}</b>에 평소보다 ${man(up.diff)} 더 썼어요.${why ? ` ${why}` : ''}`);
  }
  if (down) out.push(`<b>${esc(josa(down.category, '은', '는'))}</b> 평소보다 ${man(-down.diff)} 덜 썼어요.`);
  const small = S.smallSpend(entries(), m, u, today);
  if (small.count >= 5) out.push(`1만원 미만 결제 <b>${small.count}건</b>이 모여 ${man(small.amount)}이 됐어요.`);
  const s = S.summary(entries(), m, u, fixed);
  const prev = S.summary(entries(), S.addMonths(m, -1), u, fixed);
  if (s.rate != null && prev.rate != null && S.monthProgress(m, today) === 1) {
    const d = Math.round((s.rate - prev.rate) * 100);
    if (Math.abs(d) >= 3) out.push(`저축률이 지난달보다 <b>${Math.abs(d)}%p ${d > 0 ? '올랐어요' : '내렸어요'}</b>.`);
  }
  if (s.expense && s.fixed / s.expense >= 0.3) out.push(`지출의 ${pct(s.fixed / s.expense)}가 고정비예요. 줄이려면 구독·통신부터 살펴보세요.`);
  return out.slice(0, 3);
}

/* ───────────────────────── 홈: 지금 괜찮나 ───────────────────────── */

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
  const me = state.me;
  const you = other(me);
  const today = todayStr();
  const fixed = fixedSet();
  const p = S.pace(varEntries(), m, me, today, budgetTotal(me));
  const past = !p.isCurrent;
  const head = paceHeadline(p, { past });
  const sum = S.summary(entries(), m, me, fixed);
  const fresh = newFromPartner();

  const sub = [`${esc(me)}`, past ? `${monthNum(m)}월 전체` : `${p.day}일째`];
  if (sum.fixed) sub.push(`고정비 ${man(sum.fixed)} 제외`);

  const hero = `<section class="hero">
    <p class="hero-sub">${sub.join(' · ')}</p>
    <p class="hero-head">${head.text}</p>
  </section>`;

  const notice = fresh.length
    ? `<button class="notice" data-act="see-new"><i style="background:${uVar(you)}"></i><span>${esc(you)}님이 새로 <b>${fresh.length}건</b> 기록했어요</span><em>보기</em></button>`
    : '';

  // 페이스 차트 + 판단 숫자
  let paceSec = '';
  if (p.day) {
    const legendItems = [['이번 달', 'var(--text)', 'ln']];
    if (p.base) legendItems.push([p.base.kind === 'budget' ? '예산 범위' : '평소 범위', 'var(--band)']);
    if (p.base?.last) legendItems.push(['지난달', 'var(--bar-mid)', 'dash']);
    let tiles;
    if (p.base && !past) {
      const left = p.allowance;
      tiles = `<div class="tiles">
        <div>${left == null ? '<span>오늘이 마지막 날</span><b>–</b>' : left > 0
          ? `<span>남은 ${p.remaining}일, 하루에</span><b>${won(left)}</b><small>까지 쓰면 ${p.base.kind === 'budget' ? '예산 안' : '평소 수준'}</small>`
          : `<span>남은 ${p.remaining}일</span><b class="bad">${man(-left * p.remaining)} 초과</b><small>이미 ${p.base.kind === 'budget' ? '예산' : '평소 한 달 치'}를 넘었어요</small>`}</div>
        <div><span>지금 속도면 월말에</span><b>${man(p.projected)}</b><small>${p.base.kind === 'budget' ? '예산' : '평소'} ${man(p.end)}</small></div>
      </div>`;
    } else {
      tiles = `<div class="tiles">
        <div><span>변동 지출</span><b>${won(sum.variable)}</b>${p.base ? `<small>평소 ${man(p.end)}</small>` : ''}</div>
        <div><span>고정비</span><b>${won(sum.fixed)}</b><small>구독·통신·주거 등</small></div>
      </div>`;
    }
    paceSec = section('', `${legend(legendItems)}<div class="chart h180"><canvas id="c-pace"></canvas></div>${tiles}
      ${p.base ? '' : '<p class="note small">한 달 이상 기록이 쌓이거나 예산을 정하면 평소 범위가 함께 그려져요.</p>'}`, '', 'tight');
  }

  const facts = `<section class="facts3">
    <div><span>수입</span><b>${num(sum.income)}</b></div>
    <div><span>지출</span><b>${num(sum.expense)}</b></div>
    <div><span>저축률</span><b>${pct(sum.rate)}</b></div>
  </section>`;

  const recent = sortEntries(entries().filter(e => e.date.startsWith(m))).slice(0, 5);
  const recentBody = recent.length
    ? `<ul class="rows">${recent.map(e => entryRow(e)).join('')}</ul>`
    : `<div class="blank"><p>아직 기록이 없어요</p><button class="btn ink sm" data-act="new-entry">첫 기록 남기기</button></div>`;

  return [`${hero}${notice}${paceSec}${facts}
    ${deviationSection(m, me)}
    ${budgetSection(m)}
    ${section('최근 기록', recentBody, recent.length ? '<button class="text-btn" data-act="tab" data-tab="list">전체 보기</button>' : '')}`,
  () => { if (p.day) C.pace($('#c-pace'), p); }];
}

function deviationSection(m, u) {
  const today = todayStr();
  const dev = S.deviations(varEntries(), m, u, today).filter(d => Math.abs(d.diff) >= 3000).slice(0, 5);
  if (!dev.length) return '';
  const max = Math.max(...dev.map(d => Math.abs(d.diff)));
  const rows = dev.map(d => {
    const w = Math.abs(d.diff) / max * 50;
    const up = d.diff > 0;
    return `<button class="dev" data-act="dev-cat" data-cat="${esc(d.category)}">
      <span class="dev-name">${esc(d.category)}</span>
      <span class="dev-bar"><i class="axis"></i><i class="${up ? 'up' : 'down'}" style="width:${w}%"></i></span>
      <span class="dev-amt ${up ? 'bad' : 'good'}">${up ? '+' : '−'}${C.short(Math.abs(d.diff))}</span>
    </button>`;
  }).join('');
  const top = dev.find(d => d.diff > 0);
  const why = top ? causeText(S.cause(entries(), m, u, top.category, today)) : '';
  return section('평소와 다른 곳', `${rows}${why ? `<p class="why"><b>${esc(top.category)}</b> · ${why}</p>` : ''}`,
    S.monthProgress(m, today) < 1 ? '같은 날짜까지 비교' : '');
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
    </div>`;
  }).join('');
  return section('내 예산', `${rows}${progress < 1 ? '<p class="note small">세로선은 오늘까지 써도 되는 적정선이에요</p>' : ''}`,
    '<button class="text-btn" data-act="budgets">수정</button>');
}

/* ───────────────────────── 함께 ───────────────────────── */

function renderTogether() {
  const m = state.month;
  const today = todayStr();
  const fixed = fixedSet();
  const V = varEntries();
  const paces = Object.fromEntries(USERS.map(u => [u, S.pace(V, m, u, today, budgetTotal(u))]));
  const sums = Object.fromEntries(USERS.map(u => [u, S.summary(entries(), m, u, fixed)]));
  const past = m < S.ymOf(today);

  const judged = USERS.filter(u => paces[u].ratio != null && !(paces[u].early && !past));
  let headline;
  if (judged.length === 2) {
    const [a, b] = USERS;
    const ra = paces[a].ratio, rb = paces[b].ratio;
    if (Math.abs(ra - rb) < 0.03) headline = past ? `${monthNum(m)}월 절약 대결은 무승부` : '지금은 둘이 비슷하게 아끼는 중';
    else {
      const w = ra < rb ? a : b;
      headline = past ? `${monthNum(m)}월 절약 대결은 <em style="color:${uVar(w)}">${esc(w)}</em> 승` : `지금은 <em style="color:${uVar(w)}">${esc(josa(w, '이', '가'))}</em> 더 아끼는 중`;
    }
  } else {
    headline = paces[USERS[0]].early && !past ? '월초라 아직 승부를 가리기 일러요' : '한 달 기록이 쌓이면 절약 대결이 시작돼요';
  }

  const faces = USERS.map(u => {
    const p = paces[u];
    const d = p.ratio != null ? Math.round((p.ratio - 1) * 100) : null;
    const big = d == null || (p.early && !past) ? '–' : `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d)}%`;
    return `<div style="--u:${uVar(u)}">
      <span>${esc(u)}</span>
      <b class="${d == null ? '' : d > 3 ? 'bad' : d < -3 ? 'good' : ''}">${big}</b>
      <small>${p.base?.kind === 'budget' ? '예산 페이스 대비' : '평소 대비'} · ${man(p.spent)} 씀</small>
    </div>`;
  }).join('');

  const idxSeries = {};
  const len = S.daysIn(m);
  for (const u of USERS) {
    const p = paces[u];
    if (!p.base) continue;
    idxSeries[u] = p.cur.map((v, i) => (i < p.day && p.base.avg[i] >= p.end * 0.08 ? Math.round(v / p.base.avg[i] * 100) : null));
  }
  const hasIdx = Object.keys(idxSeries).length > 0;

  const rows = [
    ['수입', u => num(sums[u].income)],
    ['변동 지출', u => num(sums[u].variable)],
    ['고정비', u => num(sums[u].fixed)],
    ['남은 돈', u => `<span class="${sums[u].net < 0 ? 'bad' : ''}">${sums[u].net < 0 ? '−' : ''}${num(Math.abs(sums[u].net))}</span>`],
    ['저축률', u => pct(sums[u].rate)],
  ];
  const table = `<div class="cmp">
    <div class="cmp-row head"><span></span>${USERS.map(u => `<b style="color:${uVar(u)}">${esc(u)}</b>`).join('')}</div>
    ${rows.map(([label, f]) => `<div class="cmp-row"><span>${label}</span>${USERS.map(u => `<b>${f(u)}</b>`).join('')}</div>`).join('')}
  </div>`;

  // 나비 차트
  const [a, b] = USERS;
  const cats = S.byCategory(entries(), m, 'all').rows.slice(0, 8).map(r => r.category);
  const per = Object.fromEntries(USERS.map(x => [x, new Map(S.byCategory(entries(), m, x).rows.map(r => [r.category, r.amount]))]));
  const max = Math.max(1, ...cats.flatMap(n => USERS.map(x => per[x].get(n) || 0)));
  const butterfly = cats.length ? `<div class="bfly">
    <div class="bfly-row head"><b style="color:${uVar(a)}">${esc(a)}</b><span></span><b style="color:${uVar(b)}">${esc(b)}</b></div>
    ${cats.map(n => {
      const va = per[a].get(n) || 0, vb = per[b].get(n) || 0;
      return `<div class="bfly-row">
        <div class="bfly-side l"><span>${va ? C.short(va) : ''}</span><i style="width:${va / max * 100}%;background:${uVar(a)}"></i></div>
        <div class="bfly-label">${esc(n)}</div>
        <div class="bfly-side r"><i style="width:${vb / max * 100}%;background:${uVar(b)}"></i><span>${vb ? C.short(vb) : ''}</span></div>
      </div>`;
    }).join('')}</div>` : '<p class="note">이 달에는 지출이 없어요</p>';

  const html = `<section class="hero"><p class="hero-sub">절약 대결 · 고정비 제외, 각자의 평소와 비교</p><p class="hero-head">${headline}</p></section>
    <section class="face">${faces}</section>
    ${hasIdx ? section('평소 대비 흐름', `${legend([...USERS.filter(u => idxSeries[u]).map(u => [u, uVar(u), 'ln']), ['평소 (100%)', 'var(--text-3)', 'dash']])}
      <div class="chart h180"><canvas id="c-idx"></canvas></div>
      <p class="note small">선이 100%보다 아래면 평소보다 덜 쓰고 있다는 뜻이에요</p>`) : ''}
    ${section('이 달 살림', table)}
    ${section('어디에 썼나', butterfly, '전체 지출')}`;

  return [html, () => { if (hasIdx) C.paceIndex($('#c-idx'), len, idxSeries); }];
}

/* ───────────────────────── 내역 ───────────────────────── */

function filteredList() {
  const f = state.filter;
  const q = state.query.trim().toLowerCase();
  let list = entries().filter(e =>
    (f.user === 'all' || e.user === f.user) &&
    (f.type === 'all' || e.type === f.type) &&
    (!f.category || e.category === f.category));
  if (q) {
    const qNum = q.replace(/[^\d]/g, '');
    list = list.filter(e => e.memo.toLowerCase().includes(q) || e.category.toLowerCase().includes(q) || (qNum && String(e.amount).includes(qNum)));
  } else {
    list = list.filter(e => e.date.startsWith(state.month));
  }
  return sortEntries(list).slice(0, q ? 200 : 1000);
}

function listResults() {
  const list = filteredList();
  const q = state.query.trim();
  const income = list.filter(e => e.type === '입금').reduce((s, e) => s + e.amount, 0);
  const expense = list.filter(e => e.type === '출금').reduce((s, e) => s + e.amount, 0);
  const groups = new Map();
  for (const e of list) {
    const k = q ? e.date.slice(0, 7) : e.date;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const body = list.length
    ? [...groups].map(([key, items]) => {
      const out = items.filter(e => e.type === '출금').reduce((s, e) => s + e.amount, 0);
      const label = q ? `${key.slice(0, 4)}년 ${monthNum(key)}월` : dateLabel(key);
      return `<div class="day"><div class="day-head"><span>${label}</span>${out ? `<span>−${num(out)}</span>` : ''}</div>
        <ul class="rows">${items.map(e => entryRow(e, { showDate: !!q })).join('')}</ul></div>`;
    }).join('')
    : `<div class="blank"><p>${q ? `'${esc(q)}'에 맞는 기록이 없어요` : '조건에 맞는 기록이 없어요'}</p></div>`;
  return `<div class="sum-line"><span>${q ? '전체 기간 ' : ''}${list.length}건</span><span>수입 <b>${num(income)}</b></span><span>지출 <b>${num(expense)}</b></span></div>${body}`;
}

function renderList() {
  const f = state.filter;
  const pill = (key, val, label) =>
    `<button class="pill${f[key] === val ? ' on' : ''}" data-act="filter" data-key="${key}" data-val="${esc(val)}">${label}</button>`;
  const used = [...new Set(entries().map(e => e.category))];
  const catOptions = [...state.data.categories.map(c => c.name), ...used].filter((v, i, a) => a.indexOf(v) === i);

  return `<label class="search">${ICON.search}<input type="search" data-input="search" placeholder="메모, 카테고리, 금액으로 찾기" value="${esc(state.query)}" autocomplete="off"></label>
    <div class="filter-bar">
      ${pill('user', 'all', '모두')}${USERS.map(u => pill('user', u, u)).join('')}
      <span class="divider"></span>
      ${pill('type', 'all', '전체')}${pill('type', '입금', '수입')}${pill('type', '출금', '지출')}
    </div>
    <select class="select" data-change="category-filter" aria-label="카테고리">
      <option value="">카테고리 전체</option>
      ${catOptions.map(n => `<option value="${esc(n)}" ${f.category === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}
    </select>
    <div id="list-results">${listResults()}</div>
    <p class="note small center">왼쪽으로 밀면 바로 지울 수 있어요</p>`;
}

/* ───────────────────────── 통계: 돌아보기 ───────────────────────── */

function renderStats() {
  const m = state.month;
  const u = state.statsScope;
  const today = todayStr();
  const fixed = fixedSet();
  const E = entries();
  const months = S.monthRange(m, 12);
  const trend = S.monthly(E, months, u, fixed);
  const active = trend.filter(r => r.income || r.expense);

  const scope = `<nav class="seg-line">${[['all', '함께'], ...USERS.map(x => [x, x])].map(([val, label]) =>
    `<button class="${u === val ? 'on' : ''}" data-act="scope" data-val="${val}">${label}</button>`).join('')}</nav>`;

  const ins = insights(m, u);
  const insSec = ins.length
    ? section('이 달 한눈에', `<ul class="insights">${ins.map(t => `<li>${t}</li>`).join('')}</ul>`)
    : '';

  const trendSec = section('월별 흐름', `
    ${legend([['수입', 'var(--bar-soft)'], ['변동 지출', 'var(--text)'], ['고정비', 'var(--bar-mid)'], ['남은 돈', 'var(--good)', 'ln']])}
    <div class="chart h200"><canvas id="c-trend"></canvas></div>
    <div class="facts">
      <div><span>월평균 변동 지출</span><b>${active.length ? won(avg(active.map(r => r.variable))) : '–'}</b></div>
      <div><span>월평균 고정비</span><b>${active.length ? won(avg(active.map(r => r.fixed))) : '–'}</b></div>
    </div>`, '최근 12개월');

  // 카테고리 + 평소 대비
  const cat = S.byCategory(E, m, u);
  const dev = new Map(S.deviations(E, m, u, today).map(d => [d.category, d]));
  const hasHistory = S.historyMonths(E, m, u).length > 0;
  const catRows = cat.rows.map(r => {
    const c = catMeta(r.category);
    const d = dev.get(r.category);
    const diffHtml = !hasHistory ? '' : d && Math.abs(d.diff) >= 1000
      ? `<span class="${d.diff > 0 ? 'bad' : 'good'}">${d.diff > 0 ? '+' : '−'}${C.short(Math.abs(d.diff))}</span>`
      : '<span>평소만큼</span>';
    const open = state.statsCat === r.category;
    let detail = '';
    if (open) {
      const why = causeText(S.cause(E, m, u, r.category, today));
      const cs = S.cause(E, m, u, r.category, today);
      detail = `<li class="cat-detail">
        <div class="chart h140"><canvas id="c-cat"></canvas></div>
        <p class="note small">${cs.count}회 · 1회 평균 ${won(Math.round(cs.ticket / 100) * 100)}${cs.usualCount ? ` (평소 ${Math.round(cs.usualCount * 10) / 10}회 · ${won(Math.round(cs.usualTicket / 100) * 100)})` : ''}</p>
        ${why ? `<p class="why">${why}</p>` : ''}
      </li>`;
    }
    return `<li class="cat${open ? ' open' : ''}${fixed.has(r.category) ? ' fixed' : ''}" data-act="stat-cat" data-cat="${esc(r.category)}">
        <i class="dot" style="background:${c.color}"></i>
        <span class="cat-name">${esc(r.category)}${fixed.has(r.category) ? '<small>고정</small>' : ''}</span>
        <span class="cat-pct">${pct(r.share)}</span>
        <span class="cat-amt">${num(r.amount)}</span>
        <span class="cat-diff">${diffHtml}</span>
      </li>${detail}`;
  }).join('');
  const catSec = section('어디에 썼나', cat.rows.length
    ? `<p class="big-num">${num(cat.total)}<small>원</small></p>
       <div class="stack">${cat.rows.map(r => `<span style="flex:${r.amount};background:${catMeta(r.category).color}"></span>`).join('')}</div>
       <ul class="cats">${catRows}</ul>
       <p class="note small">${hasHistory ? '오른쪽은 평소(같은 날짜까지) 대비 · ' : ''}누르면 추이와 원인을 볼 수 있어요</p>`
    : '<p class="note">이 달에는 지출이 없어요</p>');

  // 소소한 지출
  const small = S.smallSpend(E, m, u, today);
  const smallSec = small.count ? section('소소한 지출', `
    <p class="big-num">${num(small.amount)}<small>원</small></p>
    <p class="note">1만원 미만 결제 ${small.count}건${small.usual != null ? ` · 평소 이맘때 ${won(small.usual)}` : ''}</p>
    ${small.top.length ? `<ul class="mini">${small.top.map(t => `<li><span>${esc(t.label)}</span><em>${t.count}번</em><b>${num(t.amount)}</b></li>`).join('')}</ul>` : ''}`, '1만원 미만') : '';

  const top = S.topExpenses(E, m, u);
  const topSec = section('큰 지출', top.length ? `<ol class="rows ranked">${top.map(e => entryRow(e)).join('')}</ol>` : '<p class="note">이 달에는 지출이 없어요</p>', 'TOP 5');

  const html = `${scope}${insSec}${catSec}${smallSec}${trendSec}${section('지출 달력', heatmap(m, u))}${topSec}`;

  const after = () => {
    C.trend($('#c-trend'), trend);
    if (state.statsCat) C.categoryTrend($('#c-cat'), months, S.categoryMonthly(E, months, u, state.statsCat), catMeta(state.statsCat).color);
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
    .map(c => `<button class="cat-chip" data-act="edit-cat" data-name="${esc(c.name)}">${esc(c.icon)} ${esc(c.name)}${c.fixed ? '<small>고정</small>' : ''}</button>`).join('');

  return `
    <div class="group-label">나는</div>
    <section class="group">
      <div class="seg">${USERS.map(u => `<button class="${state.me === u ? 'on' : ''}" style="--u:${uVar(u)}" data-act="set-me" data-user="${u}">${u}</button>`).join('')}</div>
      <p class="note small">홈 화면의 판단과 새 기록의 작성자가 이 사람 기준이에요</p>
    </section>

    <div class="group-label">관리</div>
    <section class="group list">
      <button class="item" data-act="budgets"><span>내 월 예산</span><em>${myBudgets.length ? `${myBudgets.length}개 · ${num(myBudgets.reduce((s, b) => s + b.amount, 0))}원` : '없음'}</em>${ICON.chev}</button>
      <button class="item" data-act="change-pin"><span>비밀번호 변경</span>${ICON.chev}</button>
      <button class="item" data-act="sync"><span>지금 동기화</span><em>${state.queue.length ? `대기 ${state.queue.length}건` : syncText}</em>${ICON.chev}</button>
    </section>
    ${state.lastError ? `<p class="note err">${esc(state.lastError)}</p>` : ''}

    <div class="group-label">지출 카테고리</div>
    <section class="group"><div class="chip-wrap">${chips('출금')}<button class="cat-chip add" data-act="edit-cat">+ 추가</button></div>
      <p class="note small">'고정'은 매달 나가는 돈이에요. 절약 판단에서는 빼고 계산해요.</p></section>
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
  let pickedByHand = !!existing;   // 직접 고른 카테고리는 메모 자동 선택이 덮어쓰지 않음

  const since = `${S.addMonths(curMonth, -3)}-01`;
  const quick = isNew ? S.frequentItems(entries(), f.user, since) : [];
  const memoMap = S.memoCategories(entries(), f.user);
  const memoList = [...memoMap.keys()].slice(0, 80);

  openSheet(`
    <form class="form" novalidate>
      <nav class="seg-line type-tabs">
        <button type="button" data-type="출금" class="${f.type === '출금' ? 'on' : ''}">지출</button>
        <button type="button" data-type="입금" class="${f.type === '입금' ? 'on' : ''}">수입</button>
      </nav>
      ${quick.length ? `<div class="quick-items">${quick.map((q, i) => `<button type="button" data-quick="${i}">${esc(q.memo)} <em>${num(q.amount)}</em></button>`).join('')}</div>` : ''}
      <label class="amount"><input name="amount" inputmode="numeric" autocomplete="off" placeholder="0" value="${f.amount ? num(f.amount) : ''}" aria-label="금액"><span>원</span></label>
      <div class="quick">${[1000, 10000, 50000, 100000].map(v => `<button type="button" data-add="${v}">+${C.short(v)}</button>`).join('')}<button type="button" data-add="0">지우기</button></div>
      <label class="field memo-field"><span>메모</span><input name="memo" list="memo-list" maxlength="200" value="${esc(f.memo)}" placeholder="예: 아아, 점심" autocomplete="off"></label>
      <datalist id="memo-list">${memoList.map(mm => `<option value="${esc(mm)}"></option>`).join('')}</datalist>
      <div class="cat-grid"></div>
      <div class="fields">
        <label class="field"><span>날짜</span><input type="date" name="date" value="${f.date}" required></label>
        <div class="field"><span>누가</span><div class="seg small">${USERS.map(u => `<button type="button" data-user="${u}" class="${f.user === u ? 'on' : ''}" style="--u:${uVar(u)}">${u}</button>`).join('')}</div></div>
      </div>
      <div class="actions">
        ${isNew ? '' : '<button type="button" class="btn line danger" data-del>삭제</button>'}
        <button class="btn ink" type="submit">${isNew ? '저장' : '수정'}</button>
      </div>
    </form>`, sheet => {
    const form = $('form', sheet);
    const amount = form.elements.amount;
    const memo = form.elements.memo;

    const usage = new Map();
    for (const e of entries()) if (e.user === f.user && e.date >= since) usage.set(e.category, (usage.get(e.category) || 0) + 1);

    const setType = type => {
      if (f.type !== type) { f.type = type; f.category = ''; pickedByHand = false; }
      sheet.querySelectorAll('[data-type]').forEach(b => b.classList.toggle('on', b.dataset.type === type));
    };

    const drawCats = () => {
      let list = state.data.categories.filter(c => c.type === f.type);
      if (f.category && !list.some(c => c.name === f.category)) list = [catMeta(f.category), ...list];
      list = [...list].sort((a, b) => (usage.get(b.name) || 0) - (usage.get(a.name) || 0) || a.order - b.order);
      $('.cat-grid', sheet).innerHTML = list.map(c =>
        `<button type="button" class="tile${f.category === c.name ? ' on' : ''}" data-cat="${esc(c.name)}"><span>${esc(c.icon)}</span>${esc(c.name)}</button>`).join('');
    };
    drawCats();

    const applyMemo = () => {
      const hit = memoMap.get(memo.value.trim());
      if (!hit || pickedByHand) return;
      setType(hit.type);
      f.category = hit.category;
      drawCats();
    };

    sheet.addEventListener('click', ev => {
      const t = ev.target.closest('button');
      if (!t) return;
      if (t.dataset.type) {
        setType(t.dataset.type);
        drawCats();
      } else if (t.dataset.quick != null) {
        const q = quick[Number(t.dataset.quick)];
        setType('출금');
        f.category = q.category; pickedByHand = true;
        amount.value = num(q.amount);
        memo.value = q.memo;
        sheet.querySelectorAll('[data-quick]').forEach(b => b.classList.toggle('on', b === t));
        drawCats();
      } else if (t.dataset.cat) {
        f.category = t.dataset.cat; pickedByHand = true;
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
    memo.addEventListener('input', applyMemo);
    memo.addEventListener('change', applyMemo);

    form.addEventListener('submit', ev => {
      ev.preventDefault();
      f.amount = parseAmount(amount.value);
      f.date = form.elements.date.value;
      f.memo = memo.value.trim();
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
  const c = existing ? { ...existing } : { name: '', type, icon: '', color: '#9C8F80', order: 50, fixed: false };
  openSheet(`
    <form class="form" novalidate>
      <h2 class="sheet-title">${existing ? '카테고리 수정' : '새 카테고리'}</h2>
      <nav class="seg-line type-tabs">
        <button type="button" data-type="출금" class="${c.type === '출금' ? 'on' : ''}">지출</button>
        <button type="button" data-type="입금" class="${c.type === '입금' ? 'on' : ''}">수입</button>
      </nav>
      <div class="fields">
        <label class="field"><span>이모지</span><input name="icon" value="${esc(c.icon)}" maxlength="4" placeholder="🃏" autocomplete="off"></label>
        <label class="field"><span>이름</span><input name="name" value="${esc(c.name)}" maxlength="30" placeholder="포켓몬카드" autocomplete="off"></label>
        <label class="field switch-field" ${c.type === '입금' ? 'hidden' : ''}><span>고정비</span>
          <span class="switch-wrap"><small>매달 나가는 돈 (구독, 통신, 월세)</small><input type="checkbox" name="fixed" class="switch" ${c.fixed ? 'checked' : ''}></span></label>
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
        $('.switch-field', sheet).hidden = c.type === '입금';
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
      const next = { ...c, name: form.elements.name.value.trim(), icon: form.elements.icon.value.trim() || '·',
        fixed: c.type === '출금' && form.elements.fixed.checked };
      if (!next.name) return toast('이름을 입력해 주세요');
      try {
        const saved = await online('saveCategory', { category: next, originalName: existing?.name || '' }, form.querySelector('[type=submit]'));
        // 예전 서버(고정비 열 없음)여도 화면에서는 반영되도록
        state.data.categories = saved.map(x => (x.name === next.name && x.fixed === undefined ? { ...x, fixed: next.fixed } : x));
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
          <div><div>${esc(c.name)}${c.fixed ? ' <small class="inline">고정</small>' : ''}</div><small>${a ? `평균 ${num(a)}원` : '기록 없음'}</small></div>
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

function clearSwiped(except) {
  document.querySelectorAll('.row.swiped').forEach(r => { if (r !== except) r.classList.remove('swiped'); });
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
    const row = t.closest('.row');
    if (row?.classList.contains('swiped')) { row.classList.remove('swiped'); return; }
    const e = entries().find(x => x.id === t.dataset.id);
    if (e) openEntrySheet(e);
  },
  'swipe-del': t => { removeEntry(t.dataset.id); toast('지웠어요'); },
  'see-new': () => { state.filter = { user: other(state.me), type: 'all', category: '' }; state.query = ''; go('list'); },
  filter: t => { state.filter[t.dataset.key] = t.dataset.val; render(); },
  scope: t => { state.statsScope = t.dataset.val; state.statsCat = null; render(); },
  'stat-cat': t => {
    state.statsCat = state.statsCat === t.dataset.cat ? null : t.dataset.cat;
    render({ keepScroll: true });
  },
  'dev-cat': t => {
    state.statsScope = state.me;
    state.statsCat = t.dataset.cat;
    go('stats');
    requestAnimationFrame(() => document.querySelector('.cat.open')?.scrollIntoView({ block: 'center' }));
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

let suppressClick = false;
document.addEventListener('click', e => {
  if (suppressClick) { suppressClick = false; e.preventDefault(); return; }
  if (!e.target.closest('.row.swiped')) clearSwiped();
  const t = e.target.closest('[data-act]');
  if (t && ACTIONS[t.dataset.act]) ACTIONS[t.dataset.act](t, e);
}, true);

// 기록 행을 왼쪽으로 밀어 삭제 버튼 보이기
let swipe = null;
document.addEventListener('touchstart', e => {
  const row = e.target.closest('.row[data-id]');
  if (!row || e.target.closest('.row-del')) { swipe = null; return; }
  const t = e.touches[0];
  swipe = { row, x: t.clientX, y: t.clientY, dx: 0, active: false, open: row.classList.contains('swiped') };
}, { passive: true });
document.addEventListener('touchmove', e => {
  if (!swipe) return;
  const t = e.touches[0];
  const dx = t.clientX - swipe.x, dy = t.clientY - swipe.y;
  if (!swipe.active) {
    if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.5) { swipe.active = true; clearSwiped(swipe.row); }
    else if (Math.abs(dy) > 10) { swipe = null; return; }
  }
  if (swipe.active) {
    swipe.dx = dx;
    const base = swipe.open ? -84 : 0;
    swipe.row.querySelector('.row-inner').style.transform = `translateX(${Math.max(-110, Math.min(0, base + dx))}px)`;
  }
}, { passive: true });
document.addEventListener('touchend', () => {
  if (!swipe) return;
  const { row, dx, active, open } = swipe;
  swipe = null;
  if (!active) return;
  row.querySelector('.row-inner').style.transform = '';
  const shouldOpen = open ? dx < 30 : dx < -50;
  row.classList.toggle('swiped', shouldOpen);
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 350);
});

document.addEventListener('input', e => {
  if (e.target.matches('[data-input="search"]')) {
    state.query = e.target.value;
    $('#list-results').innerHTML = listResults();
  }
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
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => render({ keepScroll: true }));

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
