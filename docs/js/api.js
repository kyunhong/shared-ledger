import { API_URL } from './config.js';

export const isDemo = new URLSearchParams(location.search).has('demo');

/** 서버가 요청을 거절함 (재시도해도 소용없음) */
export class ApiError extends Error {}
/** 네트워크 문제 (나중에 재시도) */
export class NetworkError extends Error {}

let demoBackend = null;

export async function call(action, payload = {}, pin = '') {
  if (isDemo) {
    if (!demoBackend) demoBackend = (await import('./demo.js')).createDemoBackend();
    try { return await demoBackend(action, payload); } catch (e) { throw new ApiError(e.message); }
  }

  let res;
  try {
    // text/plain 이어야 CORS 사전요청(preflight) 없이 Apps Script에 도달함
    res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, pin, ...payload }),
      redirect: 'follow',
    });
  } catch {
    throw new NetworkError('인터넷 연결을 확인하세요.');
  }
  if (!res.ok) throw new NetworkError(`서버 응답 오류 (${res.status})`);

  let body;
  try { body = await res.json(); } catch { throw new NetworkError('서버 응답을 읽을 수 없습니다.'); }
  if (!body.ok) throw new ApiError(body.error || '알 수 없는 오류');
  return body.data;
}
