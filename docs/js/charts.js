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
        { type: 'bar', label: '수입', data: rows.map(r => r.income), backgroundColor: css('--bar-soft'), borderRadius: 3, barPercentage: 0.75, categoryPercentage: 0.7, order: 1 },
        { type: 'bar', label: '지출', data: rows.map(r => r.expense), backgroundColor: css('--text'), borderRadius: 3, barPercentage: 0.75, categoryPercentage: 0.7, order: 1 },
      ],
    },
    options: base({ scales: axes() }),
  });
}

export function categoryTrend(canvas, months, values, color) {
  make(canvas, {
    type: 'bar',
    data: { labels: months.map(monthTick), datasets: [{ label: '지출', data: values, backgroundColor: color, borderRadius: 3, barPercentage: 0.6 }] },
    options: base({ scales: axes() }),
  });
}

export function rateCompare(canvas, months, series) {
  make(canvas, {
    type: 'line',
    data: {
      labels: months.map(monthTick),
      datasets: Object.entries(series).map(([user, rates]) => ({
        label: user,
        data: rates.map(r => (r == null ? null : Math.round(r * 1000) / 10)),
        borderColor: css(USER_VAR[user]), backgroundColor: css(USER_VAR[user]),
        borderWidth: 2, tension: 0.3, pointRadius: 0, pointHoverRadius: 4, spanGaps: true,
      })),
    },
    options: base({
      plugins: { legend: { display: false }, tooltip: tooltip(c => `${c.dataset.label} ${c.parsed.y}%`) },
      scales: axes(v => `${v}%`),
    }),
  });
}

export function weekday(canvas, values, labels) {
  const max = Math.max(...values);
  make(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: '하루 평균', data: values, borderRadius: 3, barPercentage: 0.55,
        backgroundColor: values.map(v => (v === max && v > 0 ? css('--text') : css('--bar-soft'))) }],
    },
    options: base({ scales: axes() }),
  });
}
