// 표준 52장 카드 정의 — 서버/클라 공유.
// 숫자(rank): 2~14 (J=11, Q=12, K=13, A=14). 무늬 순위: ♠ > ◆ > ♥ > ♣ (동점 가림용).

export type Suit = 's' | 'd' | 'h' | 'c';

export interface Card {
  id: number; // 0~51 고유 번호 (suit 색인 * 13 + rank 색인)
  rank: number; // 2~14
  suit: Suit;
}

export const SUITS: Suit[] = ['s', 'd', 'h', 'c'];

// 무늬 동점 가림 순위 — 클수록 높음
export const SUIT_ORDER: Record<Suit, number> = { s: 4, d: 3, h: 2, c: 1 };

export const SUIT_SYMBOL: Record<Suit, string> = { s: '♠', d: '◆', h: '♥', c: '♣' };

export function makeDeck(): Card[] {
  const deck: Card[] = [];
  for (let si = 0; si < 4; si++) {
    for (let r = 2; r <= 14; r++) {
      deck.push({ id: si * 13 + (r - 2), rank: r, suit: SUITS[si] });
    }
  }
  return deck;
}

// 제자리 셔플 (Fisher–Yates). rng 주입 가능(테스트 재현용).
export function shuffle<T>(arr: T[], rng: () => number = Math.random): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function rankLabel(rank: number): string {
  if (rank === 14) return 'A';
  if (rank === 13) return 'K';
  if (rank === 12) return 'Q';
  if (rank === 11) return 'J';
  return String(rank);
}

export function cardName(c: Card): string {
  return `${SUIT_SYMBOL[c.suit]}${rankLabel(c.rank)}`;
}

// 테스트·스크립트용: 'sA', 'h10', 'cJ' 같은 표기로 카드 생성
export function card(spec: string): Card {
  const suit = spec[0] as Suit;
  const rs = spec.slice(1);
  const rank = rs === 'A' ? 14 : rs === 'K' ? 13 : rs === 'Q' ? 12 : rs === 'J' ? 11 : Number(rs);
  if (!SUITS.includes(suit) || !(rank >= 2 && rank <= 14)) throw new Error(`잘못된 카드 표기: ${spec}`);
  return { id: SUITS.indexOf(suit) * 13 + (rank - 2), rank, suit };
}
