// Chart.js 래퍼 — 색은 CSS 변수에서 읽어 라이트/다크 모드를 따라감
import { USER_VAR } from './config.js';

let charts = [];

export function destroyAll() {
  charts.forEach(c => c.destroy());
  charts = [];
}

const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const won = n => `${Math.round(n).toLocaleString('ko-KR')}원`;

export function short(n) {
  const a = Math.abs(n);
  if (a >= 1e8) return `${+(n / 1e8).toFixed(1)}억`;
  if (a >= 1e4) return `${+(n / 1e4).toFixed(a >= 1e6 ? 0 : 1)}만`;
  if (a >= 1e3) return `${+(n / 1e3).toFixed(1)}천`;
  return String(n);
}

function make(canvas, config) {
  if (!canvas) return;
  if (!window.Chart) {
    canvas.parentElement.innerHTML = '<p class="note">차트를 불러오지 못했어요. 인터넷 연결을 확인하세요.</p>';
    return;
  }
  const C = window.Chart;
  C.defaults.font.family = css('--font');
  C.defaults.font.size = 11;
  C.defaults.color = css('--text-3');
  C.defaults.borderColor = css('--line');
  charts.push(new C(canvas, config));
}

const tooltip = label => ({
  backgroundColor: css('--text'),
  titleColor: css('--bg'),
  bodyColor: css('--bg'),
  titleFont: { weight: '600' },
  padding: 10,
  cornerRadius: 8,
  displayColors: false,
  callbacks: { label },
});

const base = (extra = {}) => ({
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 300 },
  interaction: { mode: 'index', intersect: false },
  plugins: { legend: { display: false }, tooltip: tooltip(c => `${c.dataset.label} ${won(c.parsed.y)}`) },
  ...extra,
});

const axes = (yFormat = short) => ({
  x: { grid: { display: false }, border: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 6 } },
  y: { grid: { color: css('--line') }, border: { display: false }, ticks: { callback: yFormat, maxTicksLimit: 4, padding: 6 } },
});

const monthTick = ym => `${Number(ym.slice(5))}월`;

export function trend(canvas, rows) {
  make(canvas, {
    data: {
      labels: rows.map(r => monthTick(r.month)),
      datasets: [
        { type: 'line', label: '남은 돈', data: rows.map(r => (r.income || r.expense ? r.net : null)),
          borderColor: css('--good'), backgroundColor: css('--good'), borderWidth: 2, tension: 0.3,
          pointRadius: 0, pointHoverRadius: 4, order: 0 },
        { type: 'bar', label: '수입', data: rows.map(r => r.income), backgroundColor: css('--bar-soft'),
          borderRadius: 3, stack: 'in', order: 1 },
        { type: 'bar', label: '변동 지출', data: rows.map(r => r.variable), backgroundColor: css('--text'),
          stack: 'out', order: 1 },
        { type: 'bar', label: '고정비', data: rows.map(r => r.fixed), backgroundColor: css('--bar-mid'),
          borderRadius: { topLeft: 3, topRight: 3 }, stack: 'out', order: 1 },
      ],
    },
    options: base({
      datasets: { bar: { barPercentage: 0.8, categoryPercentage: 0.7 } },
      scales: { ...axes(), x: { ...axes().x, stacked: true }, y: { ...axes().y, stacked: true } },
    }),
  });
}

/** 누적 지출 페이스: 이번 달 선 + 평소 범위 띠 + 지난달 점선 */
export function pace(canvas, p, color = css('--text')) {
  const days = Array.from({ length: p.len }, (_, i) => i + 1);
  const cur = p.cur.map((v, i) => (i < p.day ? v : null));
  const ds = [];
  if (p.base) {
    ds.push({ label: '평소 최대', data: p.base.hi, borderWidth: 0, pointRadius: 0, fill: '+1', backgroundColor: css('--band') });
    ds.push({ label: '평소 최소', data: p.base.lo, borderWidth: 0, pointRadius: 0, fill: false });
    ds.push({ label: '평소', data: p.base.avg, borderColor: css('--text-3'), borderWidth: 1, pointRadius: 0, borderDash: [2, 3] });
    if (p.base.last) ds.push({ label: '지난달', data: p.base.last, borderColor: css('--bar-mid'), borderWidth: 1.5, pointRadius: 0, borderDash: [5, 4] });
  }
  ds.push({ label: '이번 달', data: cur, borderColor: color, backgroundColor: color, borderWidth: 2.5, tension: 0.15,
    pointRadius: days.map(d => (d === p.day ? 4 : 0)), pointHoverRadius: 4 });
  make(canvas, {
    type: 'line',
    data: { labels: days, datasets: ds },
    options: base({
      plugins: {
        legend: { display: false },
        tooltip: { ...tooltip(c => (c.dataset.label.startsWith('평소 ') ? null : `${c.dataset.label} ${won(c.parsed.y)}`)),
          filter: c => !c.dataset.label.startsWith('평소 ') && c.parsed.y != null,
          callbacks: { title: c => `${c[0].label}일`, label: c => `${c.dataset.label} ${won(c.parsed.y)}` } },
      },
      scales: {
        x: { grid: { display: false }, border: { display: false },
          ticks: { maxRotation: 0, autoSkip: false, callback: (v, i) => ([0, 9, 19].includes(i) || i === p.len - 1 ? `${i + 1}일` : '') } },
        y: axes().y,
      },
    }),
  });
}

/** 두 사람의 '평소 대비 %' 추이 (100% = 평소와 같음) */
export function paceIndex(canvas, len, series) {
  const days = Array.from({ length: len }, (_, i) => i + 1);
  make(canvas, {
    type: 'line',
    data: {
      labels: days,
      datasets: [
        { label: '평소', data: days.map(() => 100), borderColor: css('--text-3'), borderWidth: 1, borderDash: [3, 3], pointRadius: 0 },
        ...Object.entries(series).map(([user, vals]) => ({
          label: user, data: vals, borderColor: css(USER_VAR[user]), backgroundColor: css(USER_VAR[user]),
          borderWidth: 2.5, tension: 0.2, pointRadius: 0, pointHoverRadius: 4, spanGaps: false,
        })),
      ],
    },
    options: base({
      plugins: {
        legend: { display: false },
        tooltip: { ...tooltip(c => `${c.dataset.label} ${Math.round(c.parsed.y)}%`), filter: c => c.dataset.label !== '평소',
          callbacks: { title: c => `${c[0].label}일`, label: c => `${c.dataset.label} 평소의 ${Math.round(c.parsed.y)}%` } },
      },
      scales: {
        x: { grid: { display: false }, border: { display: false },
          ticks: { maxRotation: 0, autoSkip: false, callback: (v, i) => ([0, 9, 19].includes(i) || i === len - 1 ? `${i + 1}일` : '') } },
        y: { ...axes(v => `${v}%`).y, suggestedMin: 50, suggestedMax: 150 },
      },
    }),
  });
}

export function categoryTrend(canvas, months, values, color) {
  make(canvas, {
    type: 'bar',
    data: { labels: months.map(monthTick), datasets: [{ label: '지출', data: values, backgroundColor: color, borderRadius: 3, barPercentage: 0.6 }] },
    options: base({ scales: axes() }),
  });
}
