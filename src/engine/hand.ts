// 족보 평가 — 한국식 7포커 (RULES.md 기준).
// 마운틴(10JQKA) > 백스트레이트(A2345) > 일반 스트레이트, 무승부 없음(무늬로 가림).

import { Card, SUIT_ORDER } from './cards';

// 족보 등급 — 클수록 높음
export const CAT = {
  HIGH: 1,
  PAIR: 2,
  TWO_PAIR: 3,
  TRIPLE: 4,
  STRAIGHT: 5,
  BACK_STRAIGHT: 6,
  MOUNTAIN: 7,
  FLUSH: 8,
  FULL_HOUSE: 9,
  FOUR: 10,
  STRAIGHT_FLUSH: 11,
  BACK_STRAIGHT_FLUSH: 12,
  ROYAL_STRAIGHT_FLUSH: 13,
} as const;

const CAT_NAMES: Record<number, string> = {
  1: '탑', 2: '원페어', 3: '투페어', 4: '트리플', 5: '스트레이트',
  6: '백스트레이트', 7: '마운틴', 8: '플러시', 9: '풀하우스', 10: '포카드',
  11: '스트레이트 플러시', 12: '백스트레이트 플러시', 13: '로열 스트레이트 플러시',
};

export function catName(cat: number): string {
  return CAT_NAMES[cat] ?? '?';
}

export interface HandValue {
  cat: number; // 족보 등급
  ranks: number[]; // 등급 안 비교용 숫자 배열 (중요한 순)
  topSuit: number; // 그래도 같으면 결정 카드의 무늬 (SUIT_ORDER 값)
  cards: Card[]; // 족보를 이룬 5장 (표시용)
}

// 큰 쪽이 양수. 0은 이론상 안 나옴(무늬까지 같은 카드는 없음) — 보스 비교 등 부분 패에서만 0 가능.
export function compareValue(a: HandValue, b: HandValue): number {
  if (a.cat !== b.cat) return a.cat - b.cat;
  const n = Math.max(a.ranks.length, b.ranks.length);
  for (let i = 0; i < n; i++) {
    const d = (a.ranks[i] ?? 0) - (b.ranks[i] ?? 0);
    if (d !== 0) return d;
  }
  return a.topSuit - b.topSuit;
}

// 5장 평가
export function eval5(cards: Card[]): HandValue {
  if (cards.length !== 5) throw new Error('eval5는 5장 필요');
  const sorted = [...cards].sort((a, b) => b.rank - a.rank || SUIT_ORDER[b.suit] - SUIT_ORDER[a.suit]);
  const isFlush = sorted.every((c) => c.suit === sorted[0].suit);

  // 숫자별 묶음 — [숫자, 장수], 장수 내림차순 → 숫자 내림차순
  const byRank = new Map<number, Card[]>();
  for (const c of sorted) {
    const g = byRank.get(c.rank) ?? [];
    g.push(c);
    byRank.set(c.rank, g);
  }
  const groups = [...byRank.entries()].sort((a, b) => b[1].length - a[1].length || b[0] - a[0]);

  // 스트레이트 판별 (5장 숫자 전부 다를 때만)
  const ranksDesc = sorted.map((c) => c.rank);
  const distinct = groups.length === 5;
  const isMountain = distinct && ranksDesc.join(',') === '14,13,12,11,10';
  const isBack = distinct && ranksDesc.join(',') === '14,5,4,3,2';
  const isRun = distinct && ranksDesc[0] - ranksDesc[4] === 4;
  const isStraight = isRun || isBack; // 마운틴은 isRun에 포함

  const top = (cs: Card[]) => Math.max(...cs.map((c) => SUIT_ORDER[c.suit]));

  if (isFlush && isMountain) return { cat: CAT.ROYAL_STRAIGHT_FLUSH, ranks: [14], topSuit: top(sorted), cards: sorted };
  if (isFlush && isBack) return { cat: CAT.BACK_STRAIGHT_FLUSH, ranks: [5], topSuit: top(sorted), cards: sorted };
  if (isFlush && isStraight) return { cat: CAT.STRAIGHT_FLUSH, ranks: [ranksDesc[0]], topSuit: top(sorted), cards: sorted };

  if (groups[0][1].length === 4) {
    return { cat: CAT.FOUR, ranks: [groups[0][0], groups[1][0]], topSuit: top(groups[0][1]), cards: sorted };
  }
  if (groups[0][1].length === 3 && groups[1][1].length === 2) {
    return { cat: CAT.FULL_HOUSE, ranks: [groups[0][0], groups[1][0]], topSuit: top(groups[0][1]), cards: sorted };
  }
  if (isFlush) return { cat: CAT.FLUSH, ranks: ranksDesc, topSuit: SUIT_ORDER[sorted[0].suit], cards: sorted };
  if (isMountain) return { cat: CAT.MOUNTAIN, ranks: [14], topSuit: top(sorted), cards: sorted };
  if (isBack) return { cat: CAT.BACK_STRAIGHT, ranks: [5], topSuit: top(sorted), cards: sorted };
  if (isStraight) return { cat: CAT.STRAIGHT, ranks: [ranksDesc[0]], topSuit: top(sorted), cards: sorted };

  if (groups[0][1].length === 3) {
    return { cat: CAT.TRIPLE, ranks: [groups[0][0], groups[1][0], groups[2][0]], topSuit: top(groups[0][1]), cards: sorted };
  }
  if (groups[0][1].length === 2 && groups[1][1].length === 2) {
    return { cat: CAT.TWO_PAIR, ranks: [groups[0][0], groups[1][0], groups[2][0]], topSuit: top(groups[0][1]), cards: sorted };
  }
  if (groups[0][1].length === 2) {
    return { cat: CAT.PAIR, ranks: [groups[0][0], groups[1][0], groups[2][0], groups[3][0]], topSuit: top(groups[0][1]), cards: sorted };
  }
  return { cat: CAT.HIGH, ranks: ranksDesc, topSuit: SUIT_ORDER[sorted[0].suit], cards: sorted };
}

// 5~7장 중 5장 조합 전부 평가해 최고 족보 반환
export function evalBest(cards: Card[]): HandValue {
  if (cards.length < 5) throw new Error('evalBest는 5장 이상 필요');
  if (cards.length === 5) return eval5(cards);
  let best: HandValue | null = null;
  const n = cards.length;
  const idx = [0, 1, 2, 3, 4];
  // n장 중 5장 조합 열거
  while (true) {
    const v = eval5(idx.map((i) => cards[i]));
    if (!best || compareValue(v, best) > 0) best = v;
    // 다음 조합
    let i = 4;
    while (i >= 0 && idx[i] === n - 5 + i) i--;
    if (i < 0) break;
    idx[i]++;
    for (let j = i + 1; j < 5; j++) idx[j] = idx[j - 1] + 1;
  }
  return best!;
}

// 공개 카드(1~4장)만으로 보스 비교용 값 계산 — 포카드/트리플/투페어/페어/하이카드만 가능.
export function evalOpen(cards: Card[]): HandValue {
  if (cards.length === 0) return { cat: 0, ranks: [], topSuit: 0, cards: [] };
  const sorted = [...cards].sort((a, b) => b.rank - a.rank || SUIT_ORDER[b.suit] - SUIT_ORDER[a.suit]);
  const byRank = new Map<number, Card[]>();
  for (const c of sorted) {
    const g = byRank.get(c.rank) ?? [];
    g.push(c);
    byRank.set(c.rank, g);
  }
  const groups = [...byRank.entries()].sort((a, b) => b[1].length - a[1].length || b[0] - a[0]);
  const sizes = groups.map((g) => g[1].length);
  const ranks = groups.map((g) => g[0]);
  const top = (cs: Card[]) => Math.max(...cs.map((c) => SUIT_ORDER[c.suit]));
  if (sizes[0] === 4) return { cat: CAT.FOUR, ranks, topSuit: top(groups[0][1]), cards: sorted };
  if (sizes[0] === 3) return { cat: CAT.TRIPLE, ranks, topSuit: top(groups[0][1]), cards: sorted };
  if (sizes[0] === 2 && sizes[1] === 2) return { cat: CAT.TWO_PAIR, ranks, topSuit: top(groups[0][1]), cards: sorted };
  if (sizes[0] === 2) return { cat: CAT.PAIR, ranks, topSuit: top(groups[0][1]), cards: sorted };
  return { cat: CAT.HIGH, ranks, topSuit: SUIT_ORDER[sorted[0].suit], cards: sorted };
}
