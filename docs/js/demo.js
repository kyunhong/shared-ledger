// 데모 모드 (주소 뒤에 ?demo 를 붙이면 실행) — 서버 없이 가짜 데이터로 화면을 확인
const CATEGORIES = [
  ['월급', '입금', '💰', '#22A06B', 1], ['부수입', '입금', '💵', '#4BCE97', 2], ['기타입금', '입금', '📥', '#7EE2B8', 3],
  ['식비', '출금', '🍚', '#F97316', 10], ['카페·간식', '출금', '☕', '#A16207', 11], ['주유', '출금', '⛽', '#EF4444', 12],
  ['교통', '출금', '🚌', '#3B82F6', 13], ['포켓몬카드', '출금', '🃏', '#EAB308', 14], ['쇼핑', '출금', '🛍️', '#EC4899', 15],
  ['데이트', '출금', '💕', '#F43F5E', 16], ['생활·주거', '출금', '🏠', '#6366F1', 17], ['통신·구독', '출금', '📱', '#06B6D4', 18],
  ['의료·건강', '출금', '💊', '#10B981', 19], ['경조사·선물', '출금', '🎁', '#8B5CF6', 20], ['기타지출', '출금', '📦', '#64748B', 99],
].map(([name, type, icon, color, order]) => ({ name, type, icon, color, order }));

// [카테고리, 월 평균 횟수, 최소, 최대, 메모 후보]
const HABITS = {
  지은: [['식비', 14, 6000, 18000, ['점심', '김밥', '편의점']], ['카페·간식', 12, 3000, 9000, ['라떼', '빵']],
    ['쇼핑', 3, 15000, 90000, ['옷', '화장품']], ['교통', 8, 1500, 15000, ['버스', '택시']], ['데이트', 4, 20000, 70000, ['영화', '저녁']],
    ['통신·구독', 2, 9900, 55000, ['휴대폰', '넷플릭스']], ['생활·주거', 2, 10000, 60000, ['생필품']]],
  홍균: [['식비', 16, 7000, 20000, ['점심', '국밥', '라면']], ['포켓몬카드', 4, 5000, 45000, ['151 팩', '부스터 박스', '싱글카드']],
    ['주유', 3, 40000, 70000, ['주유']], ['카페·간식', 6, 2500, 6000, ['아아']], ['데이트', 4, 20000, 80000, ['데이트']],
    ['통신·구독', 2, 9900, 60000, ['휴대폰', '유튜브']], ['기타지출', 1, 5000, 30000, ['기타']]],
};

const pad = n => String(n).padStart(2, '0');

export function createDemoBackend() {
  let seed = 42;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const between = (a, b) => Math.round((a + rand() * (b - a)) / 100) * 100;

  const now = new Date();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const entries = [];
  let n = 0;
  const add = (date, user, type, amount, category, memo = '') => {
    if (date > today) return;
    entries.push({ id: `demo-${++n}`, date, user, type, amount, category, memo,
      createdAt: new Date(`${date}T12:00`).toISOString(), updatedAt: '' });
  };

  for (let k = -6; k <= 0; k++) {
    const d = new Date(now.getFullYear(), now.getMonth() + k, 1);
    const ym = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    const days = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    add(`${ym}-25`, '지은', '입금', 3120000, '월급', '급여');
    add(`${ym}-21`, '홍균', '입금', 3380000, '월급');
    if (rand() < 0.4) add(`${ym}-${pad(10 + Math.floor(rand() * 10))}`, '홍균', '입금', between(30000, 150000), '부수입', '카드 판매');
    for (const [user, habits] of Object.entries(HABITS)) {
      const thrift = user === '지은' ? 1 - (k + 6) * 0.03 : 1 + (k + 6) * 0.02; // 지은은 점점 절약, 홍균은 점점 증가
      for (const [cat, times, min, max, memos] of habits) {
        const count = Math.max(0, Math.round(times * thrift * (0.8 + rand() * 0.4)));
        for (let i = 0; i < count; i++) {
          add(`${ym}-${pad(1 + Math.floor(rand() * days))}`, user, '출금', between(min, max) , cat, memos[Math.floor(rand() * memos.length)]);
        }
      }
    }
  }

  let categories = CATEGORIES;
  let budgets = [
    { user: '홍균', category: '포켓몬카드', amount: 80000 }, { user: '홍균', category: '식비', amount: 280000 },
    { user: '홍균', category: '주유', amount: 150000 }, { user: '지은', category: '식비', amount: 250000 },
    { user: '지은', category: '카페·간식', amount: 70000 }, { user: '지은', category: '쇼핑', amount: 150000 },
  ];

  return async (action, p) => {
    await new Promise(r => setTimeout(r, 300));
    switch (action) {
      case 'ping': return 'pong';
      case 'bootstrap': return { users: ['지은', '홍균'], entries: structuredClone(entries), categories, budgets, serverTime: new Date().toISOString() };
      case 'addEntry': {
        const found = entries.find(e => e.id === p.entry.id);
        if (found) return found;
        const e = { ...p.entry, createdAt: new Date().toISOString(), updatedAt: '' };
        entries.push(e);
        return e;
      }
      case 'updateEntry': {
        const i = entries.findIndex(e => e.id === p.entry.id);
        if (i < 0) throw new Error('해당 내역을 찾을 수 없습니다.');
        entries[i] = { ...entries[i], ...p.entry, updatedAt: new Date().toISOString() };
        return entries[i];
      }
      case 'deleteEntry': {
        const i = entries.findIndex(e => e.id === p.id);
        if (i >= 0) entries.splice(i, 1);
        return { id: p.id };
      }
      case 'saveCategory': {
        const c = p.category;
        const key = p.originalName || c.name;
        const i = categories.findIndex(x => x.name === key);
        categories = i >= 0 ? categories.map((x, j) => (j === i ? { ...x, ...c } : x)) : [...categories, c];
        if (p.originalName && p.originalName !== c.name) {
          entries.forEach(e => { if (e.category === p.originalName) e.category = c.name; });
          budgets = budgets.map(b => (b.category === p.originalName ? { ...b, category: c.name } : b));
        }
        return categories.sort((a, b) => a.order - b.order);
      }
      case 'deleteCategory':
        if (entries.some(e => e.category === p.name)) throw new Error('이미 사용 중인 카테고리는 삭제할 수 없어요. 이름 변경을 이용하세요.');
        categories = categories.filter(c => c.name !== p.name);
        return categories;
      case 'saveBudget': {
        const b = p.budget;
        budgets = budgets.filter(x => !(x.user === b.user && x.category === b.category));
        if (b.amount > 0) budgets.push(b);
        return budgets;
      }
      case 'changePin': return true;
      default: throw new Error(`알 수 없는 요청: ${action}`);
    }
  };
}
