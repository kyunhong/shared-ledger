// Chart.js 래퍼 — 색은 CSS 변수에서 읽어 라이트/다크 모드를 따라감
import { USER_COLORS } from './config.js';

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
    canvas.parentElement.innerHTML = '<p class="muted center">차트를 불러오지 못했어요 (인터넷 연결 확인)</p>';
    return;
  }
  const C = window.Chart;
  C.defaults.font.family = css('--font');
  C.defaults.font.size = 11;
  C.defaults.color = css('--text-2');
  C.defaults.borderColor = css('--line');
  charts.push(new C(canvas, config));
}

const baseOptions = (extra = {}) => ({
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 350 },
  interaction: { mode: 'index', intersect: false },
  plugins: {
    legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true, padding: 14 } },
    tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${won(c.parsed.y ?? c.parsed)}` } },
  },
  ...extra,
});

const monthTick = ym => `${Number(ym.slice(5))}월`;

export function trend(canvas, rows) {
  make(canvas, {
    data: {
      labels: rows.map(r => monthTick(r.month)),
      datasets: [
        { type: 'bar', label: '수입', data: rows.map(r => r.income), backgroundColor: css('--income'), borderRadius: 4, order: 2 },
        { type: 'bar', label: '지출', data: rows.map(r => r.expense), backgroundColor: css('--expense'), borderRadius: 4, order: 2 },
        { type: 'line', label: '남은 돈', data: rows.map(r => (r.income || r.expense ? r.net : null)), borderColor: css('--accent'), backgroundColor: css('--accent'),
          tension: 0.35, pointRadius: 2.5, borderWidth: 2, order: 1 },
      ],
    },
    options: baseOptions({
      scales: { x: { grid: { display: false } }, y: { ticks: { callback: short, maxTicksLimit: 5 } } },
    }),
  });
}

export function donut(canvas, rows, colorOf) {
  make(canvas, {
    type: 'doughnut',
    data: {
      labels: rows.map(r => r.category),
      datasets: [{ data: rows.map(r => r.amount), backgroundColor: rows.map(r => colorOf(r.category)), borderColor: css('--card'), borderWidth: 2 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '70%', animation: { duration: 350 },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${c.label}: ${won(c.parsed)}` } } },
    },
  });
}

export function categoryTrend(canvas, months, values, color) {
  make(canvas, {
    type: 'bar',
    data: { labels: months.map(monthTick), datasets: [{ label: '지출', data: values, backgroundColor: color, borderRadius: 4 }] },
    options: baseOptions({
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${won(c.parsed.y)}` } } },
      scales: { x: { grid: { display: false } }, y: { ticks: { callback: short, maxTicksLimit: 4 } } },
    }),
  });
}

export function rateCompare(canvas, months, series) {
  make(canvas, {
    type: 'line',
    data: {
      labels: months.map(monthTick),
      datasets: Object.entries(series).map(([user, rates]) => ({
        label: user, data: rates.map(r => (r == null ? null : Math.round(r * 1000) / 10)),
        borderColor: USER_COLORS[user], backgroundColor: USER_COLORS[user],
        tension: 0.35, pointRadius: 3, borderWidth: 2, spanGaps: true,
      })),
    },
    options: baseOptions({
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true } },
        tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${c.parsed.y}%` } },
      },
      scales: { x: { grid: { display: false } }, y: { ticks: { callback: v => `${v}%`, maxTicksLimit: 5 } } },
    }),
  });
}

export function userCompare(canvas, categories, series) {
  make(canvas, {
    type: 'bar',
    data: {
      labels: categories,
      datasets: Object.entries(series).map(([user, data]) => ({
        label: user, data, backgroundColor: USER_COLORS[user], borderRadius: 4, barPercentage: 0.8, categoryPercentage: 0.7,
      })),
    },
    options: baseOptions({
      indexAxis: 'y',
      interaction: { mode: 'index', intersect: false, axis: 'y' },
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true } },
        tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${won(c.parsed.x)}` } },
      },
      scales: { x: { ticks: { callback: short, maxTicksLimit: 4 } }, y: { grid: { display: false } } },
    }),
  });
}

export function weekday(canvas, values, labels) {
  const max = Math.max(...values);
  make(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: '하루 평균', data: values,
        backgroundColor: values.map(v => (v === max && v > 0 ? css('--expense') : css('--bar-soft'))), borderRadius: 6 }],
    },
    options: baseOptions({
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` 하루 평균 ${won(c.parsed.y)}` } } },
      scales: { x: { grid: { display: false } }, y: { ticks: { callback: short, maxTicksLimit: 4 } } },
    }),
  });
}
