// 통계 계산 (순수 함수) — 날짜는 'YYYY-MM-DD', 월은 'YYYY-MM' 문자열

const pad = n => String(n).padStart(2, '0');
const mean = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
const dayOf = date => Number(date.slice(8, 10));

export const ymOf = date => date.slice(0, 7);

export function addMonths(ym, k) {
  let [y, m] = ym.split('-').map(Number);
  m += k;
  y += Math.floor((m - 1) / 12);
  m = (((m - 1) % 12) + 12) % 12 + 1;
  return `${y}-${pad(m)}`;
}

/** endYm 을 마지막으로 하는 n개월 목록 */
export const monthRange = (endYm, n) => Array.from({ length: n }, (_, i) => addMonths(endYm, i - n + 1));

export function daysIn(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

/** 조회 시점 기준 그 달의 며칠째까지 볼지 (지난 달이면 말일) */
export function dayCutOf(month, today) {
  const cur = ymOf(today);
  if (month === cur) return dayOf(today);
  return month < cur ? daysIn(month) : 0;
}

export function monthProgress(month, today) {
  return dayCutOf(month, today) / daysIn(month);
}

export function pick(entries, { month, user, type, category, upTo }) {
  return entries.filter(e =>
    (!month || e.date.startsWith(month)) &&
    (!user || user === 'all' || e.user === user) &&
    (!type || e.type === type) &&
    (!category || e.category === category) &&
    (!upTo || dayOf(e.date) <= upTo));
}

/** 고정비 카테고리 지출을 뺀 기록 (수입은 그대로) */
export const variableOnly = (entries, fixed) => entries.filter(e => e.type !== '출금' || !fixed.has(e.category));

export function summary(entries, month, user, fixed = new Set()) {
  let income = 0, expense = 0, fixedSum = 0;
  for (const e of pick(entries, { month, user })) {
    if (e.type === '입금') income += e.amount;
    else {
      expense += e.amount;
      if (fixed.has(e.category)) fixedSum += e.amount;
    }
  }
  const net = income - expense;
  return { income, expense, fixed: fixedSum, variable: expense - fixedSum, net, rate: income > 0 ? net / income : null };
}

export const monthly = (entries, months, user, fixed) =>
  months.map(month => ({ month, ...summary(entries, month, user, fixed) }));

export function byCategory(entries, month, user, type = '출금', upTo) {
  const map = new Map();
  let total = 0;
  for (const e of pick(entries, { month, user, type, upTo })) {
    const c = map.get(e.category) || { category: e.category, amount: 0, count: 0 };
    c.amount += e.amount;
    c.count += 1;
    map.set(e.category, c);
    total += e.amount;
  }
  const rows = [...map.values()]
    .sort((a, b) => b.amount - a.amount)
    .map(r => ({ ...r, share: total ? r.amount / total : 0 }));
  return { total, rows };
}

export function categoryMonthly(entries, months, user, category) {
  return months.map(month => pick(entries, { month, user, type: '출금', category }).reduce((s, e) => s + e.amount, 0));
}

export function daily(entries, month, user) {
  const days = Array(daysIn(month)).fill(0);
  for (const e of pick(entries, { month, user, type: '출금' })) days[dayOf(e.date) - 1] += e.amount;
  return days;
}

export function cumulative(entries, month, user) {
  let s = 0;
  return daily(entries, month, user).map(v => (s += v));
}

/** 지출 기록이 있는 지난 달들 (최대 n개) */
export function historyMonths(entries, month, user, n = 3) {
  return monthRange(addMonths(month, -1), n).filter(m => pick(entries, { month: m, user, type: '출금' }).length > 0);
}

/**
 * 평소 누적 지출 곡선: 지난 달들의 날짜별 누적 지출 평균 + 범위.
 * 기록이 없으면 예산 합계로 일정한 페이스를 가정.
 */
export function baseline(entries, month, user, budgetTotal = 0) {
  const len = daysIn(month);
  const months = historyMonths(entries, month, user);
  if (months.length) {
    const curves = months.map(m => cumulative(entries, m, user));
    const at = (c, d) => c[Math.min(d, c.length) - 1];
    const avg = [], lo = [], hi = [];
    for (let d = 1; d <= len; d++) {
      const vals = curves.map(c => at(c, d));
      const a = mean(vals);
      avg.push(a);
      if (vals.length >= 2) { lo.push(Math.min(...vals)); hi.push(Math.max(...vals)); }
      else { lo.push(a * 0.88); hi.push(a * 1.12); }
    }
    const prev = addMonths(month, -1);
    const last = months.includes(prev) ? (() => { const c = cumulative(entries, prev, user); return Array.from({ length: len }, (_, i) => at(c, i + 1)); })() : null;
    return { kind: 'history', months: months.length, avg, lo, hi, last };
  }
  if (budgetTotal > 0) {
    const avg = Array.from({ length: len }, (_, i) => budgetTotal * (i + 1) / len);
    return { kind: 'budget', months: 0, avg, lo: avg.map(v => v * 0.9), hi: avg.map(v => v * 1.1), last: null };
  }
  return null;
}

/** 이번 달 페이스: 평소 이맘때 대비, 월말 예상, 하루 가능 금액 */
export function pace(entries, month, user, today, budgetTotal = 0) {
  const len = daysIn(month);
  const day = dayCutOf(month, today);
  const cur = cumulative(entries, month, user);
  const spent = day ? cur[day - 1] : 0;
  const base = baseline(entries, month, user, budgetTotal);
  const out = { month, user, len, day, cur, spent, base, isCurrent: month === ymOf(today) };
  if (!base || !day) return out;
  const expected = base.avg[day - 1];
  const end = base.avg[len - 1];
  const remaining = len - day;
  return {
    ...out,
    expected,
    end,
    early: expected < end * 0.08,                         // 월초라 판단하기 이름
    ratio: expected > 0 ? spent / expected : null,
    projected: spent + (end - expected),
    remaining,
    allowance: remaining > 0 ? (end - spent) / remaining : null,
  };
}

/** 카테고리별로 평소(지난 달들의 같은 날짜까지 평균)와 비교 */
export function deviations(entries, month, user, today) {
  const upTo = dayCutOf(month, today);
  const months = historyMonths(entries, month, user);
  if (!months.length || !upTo) return [];
  const sums = m => new Map(byCategory(entries, m, user, '출금', upTo).rows.map(r => [r.category, r.amount]));
  const now = sums(month);
  const prev = months.map(sums);
  const cats = new Set([...now.keys(), ...prev.flatMap(p => [...p.keys()])]);
  return [...cats]
    .map(category => {
      const amount = now.get(category) || 0;
      const usual = mean(prev.map(p => p.get(category) || 0));
      return { category, amount, usual, diff: amount - usual };
    })
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
}

/** 지출 변화의 원인: 횟수 vs 1회 금액 */
export function cause(entries, month, user, category, today) {
  const upTo = dayCutOf(month, today);
  const months = historyMonths(entries, month, user);
  const now = pick(entries, { month, user, type: '출금', category, upTo });
  const prev = months.map(m => pick(entries, { month: m, user, type: '출금', category, upTo }));
  const prevAll = prev.flat();
  const sum = list => list.reduce((s, e) => s + e.amount, 0);
  return {
    count: now.length,
    ticket: now.length ? sum(now) / now.length : 0,
    usualCount: prev.length ? prevAll.length / prev.length : 0,
    usualTicket: prevAll.length ? sum(prevAll) / prevAll.length : 0,
  };
}

/** 소소한 지출 (기준 금액 미만) 합계와 자주 나온 항목 */
export function smallSpend(entries, month, user, today, limit = 10000) {
  const upTo = dayCutOf(month, today);
  const list = pick(entries, { month, user, type: '출금', upTo }).filter(e => e.amount < limit);
  const months = historyMonths(entries, month, user);
  const usual = mean(months.map(m => pick(entries, { month: m, user, type: '출금', upTo })
    .filter(e => e.amount < limit).reduce((s, e) => s + e.amount, 0)));
  const freq = new Map();
  for (const e of list) {
    const k = e.memo || e.category;
    const f = freq.get(k) || { label: k, count: 0, amount: 0 };
    f.count++; f.amount += e.amount;
    freq.set(k, f);
  }
  return {
    count: list.length,
    amount: list.reduce((s, e) => s + e.amount, 0),
    usual: months.length ? usual : null,
    top: [...freq.values()].sort((a, b) => b.count - a.count || b.amount - a.amount).slice(0, 3),
  };
}

export const topExpenses = (entries, month, user, n = 5) =>
  pick(entries, { month, user, type: '출금' }).sort((a, b) => b.amount - a.amount).slice(0, n);

export function budgetStatus(entries, budgets, month, user) {
  const spent = new Map(byCategory(entries, month, user).rows.map(r => [r.category, r.amount]));
  return budgets
    .filter(b => b.user === user && b.amount > 0)
    .map(b => {
      const s = spent.get(b.category) || 0;
      return { category: b.category, budget: b.amount, spent: s, pct: s / b.amount };
    })
    .sort((a, b) => b.pct - a.pct);
}

/** 자주 반복되는 기록 (빠른 입력용): 메모+카테고리 묶음, 가장 흔한 금액 */
export function frequentItems(entries, user, since, n = 6) {
  const groups = new Map();
  for (const e of entries) {
    if (e.user !== user || e.type !== '출금' || !e.memo || e.date < since) continue;
    const k = `${e.memo}\u0000${e.category}`;
    const g = groups.get(k) || { memo: e.memo, category: e.category, count: 0, amounts: new Map() };
    g.count++;
    g.amounts.set(e.amount, (g.amounts.get(e.amount) || 0) + 1);
    groups.set(k, g);
  }
  return [...groups.values()]
    .filter(g => g.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, n)
    .map(g => {
      const [modeAmount, modeCount] = [...g.amounts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
      // 같은 금액이 자주 나오면 그 금액, 아니면 중앙값(100원 단위)
      const all = [...g.amounts].flatMap(([amt, c]) => Array(c).fill(amt)).sort((a, b) => a - b);
      const median = Math.round(all[Math.floor(all.length / 2)] / 100) * 100;
      return { memo: g.memo, category: g.category, count: g.count, amount: modeCount / g.count >= 0.4 ? modeAmount : median };
    });
}

/** 메모 → 가장 많이 쓴 카테고리 (자동 선택용) */
export function memoCategories(entries, user) {
  const map = new Map();
  for (const e of entries) {
    if (!e.memo) continue;
    const key = e.memo.trim();
    const m = map.get(key) || new Map();
    const w = e.user === user ? 2 : 1;
    m.set(`${e.type}\u0000${e.category}`, (m.get(`${e.type}\u0000${e.category}`) || 0) + w);
    map.set(key, m);
  }
  const out = new Map();
  for (const [memo, m] of map) {
    const [best] = [...m].sort((a, b) => b[1] - a[1]);
    const [type, category] = best[0].split('\u0000');
    out.set(memo, { type, category });
  }
  return out;
}
