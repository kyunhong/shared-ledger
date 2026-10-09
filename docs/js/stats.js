// 통계 계산 (순수 함수) — 날짜는 모두 'YYYY-MM-DD', 월은 'YYYY-MM' 문자열

const pad = n => String(n).padStart(2, '0');

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

export const dayOfWeek = date => new Date(`${date}T00:00`).getDay();

function pick(entries, { month, user, type }) {
  return entries.filter(e =>
    (!month || e.date.startsWith(month)) &&
    (!user || user === 'all' || e.user === user) &&
    (!type || e.type === type));
}

export function summary(entries, month, user) {
  let income = 0, expense = 0;
  for (const e of pick(entries, { month, user })) {
    if (e.type === '입금') income += e.amount; else expense += e.amount;
  }
  const net = income - expense;
  return { income, expense, net, rate: income > 0 ? net / income : null };
}

export const monthly = (entries, months, user) =>
  months.map(month => ({ month, ...summary(entries, month, user) }));

export function byCategory(entries, month, user, type = '출금') {
  const map = new Map();
  let total = 0;
  for (const e of pick(entries, { month, user, type })) {
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
  return months.map(month =>
    pick(entries, { month, user, type: '출금' })
      .filter(e => e.category === category)
      .reduce((s, e) => s + e.amount, 0));
}

/** 이번 달이 몇 % 지났는지 (지난 달이면 1) */
export function monthProgress(month, today) {
  return month === ymOf(today) ? Number(today.slice(8, 10)) / daysIn(month) : month < ymOf(today) ? 1 : 0;
}

/**
 * 절약 대결: 각자 최근 3개월(기록 있는 달) 평균 지출과 비교.
 * 진행 중인 달은 오늘까지의 페이스로 환산해 공정하게 비교.
 */
export function savingsBattle(entries, month, users, today) {
  const progress = monthProgress(month, today);
  const rows = users.map(user => {
    const spent = summary(entries, month, user).expense;
    const prev = monthRange(addMonths(month, -1), 3)
      .map(m => summary(entries, m, user).expense)
      .filter(v => v > 0);
    if (!prev.length || progress === 0) return { user, spent, baseline: null, expected: null, pct: null };
    const baseline = prev.reduce((a, b) => a + b, 0) / prev.length;
    const expected = baseline * progress;
    return { user, spent, baseline, expected, pct: expected > 0 ? (expected - spent) / expected : null, months: prev.length };
  });
  const ranked = rows.filter(r => r.pct != null);
  const winner = ranked.length === users.length && ranked[0].pct !== ranked[1]?.pct
    ? ranked.reduce((a, b) => (b.pct > a.pct ? b : a)).user
    : null;
  return { rows, winner, partial: progress < 1 };
}

export function daily(entries, month, user) {
  const days = Array(daysIn(month)).fill(0);
  for (const e of pick(entries, { month, user, type: '출금' })) days[Number(e.date.slice(8, 10)) - 1] += e.amount;
  return days;
}

/** 요일별 하루 평균 지출 (일=0 … 토=6), 오늘 이후 날짜는 제외 */
export function weekdayAvg(entries, months, user, today) {
  const sum = Array(7).fill(0), cnt = Array(7).fill(0);
  for (const m of months) {
    for (let d = 1; d <= daysIn(m); d++) {
      const ds = `${m}-${pad(d)}`;
      if (ds > today) break;
      cnt[dayOfWeek(ds)] += 1;
    }
  }
  const set = new Set(months);
  for (const e of pick(entries, { user, type: '출금' })) {
    if (set.has(ymOf(e.date)) && e.date <= today) sum[dayOfWeek(e.date)] += e.amount;
  }
  return sum.map((s, i) => (cnt[i] ? s / cnt[i] : 0));
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
