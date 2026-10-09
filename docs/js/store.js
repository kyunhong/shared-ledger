// localStorage 래퍼 — 사파리 비공개 모드 등에서 실패해도 앱이 멈추지 않도록
const PREFIX = new URLSearchParams(location.search).has('demo') ? 'ledger-demo.' : 'ledger.';

export function load(key, fallback = null) {
  try {
    const v = localStorage.getItem(PREFIX + key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}

export function save(key, value) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch { /* 저장 공간 없음 */ }
}

export function remove(key) {
  try { localStorage.removeItem(PREFIX + key); } catch { /* 무시 */ }
}
