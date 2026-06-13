// 좌석 시점 뷰 — 서버가 각 클라이언트에 보낼 때 상대 비공개 카드를 숨긴다.
// 솔로 모드도 같은 뷰를 써서 클라 화면 코드가 하나로 유지된다.

import { Card } from './cards';
import { catName } from './hand';
import { BetAction, Phase, SevenPokerGame, ACTION_NAMES, BASE_BET } from './game';

export interface SeatView {
  name: string;
  chips: number;
  streetBet: number; // 이번 라운드 낸 금액 (테이블 표시)
  totalBet: number;
  folded: boolean;
  allIn: boolean;
  chosen: boolean;
  openCards: Card[]; // 공개 카드 (받은 순서)
  hiddenCount: number; // 비공개 장수
  isMe: boolean;
}

export interface ResultView {
  winner: number;
  payout: number;
  bySurrender: boolean;
  // 좌석별 공개 패 — 다이/비공개는 null
  hands: ({ cards: Card[]; catLabel: string; bestIds: number[] } | null)[];
}

export interface GameView {
  phase: Phase;
  street: number; // 1~5
  pot: number;
  baseBet: number;
  current: number;
  boss: number;
  mySeat: number;
  myCards: Card[]; // 내 전체 카드 (받은 순서)
  myOpenIds: number[];
  toCall: number;
  actions: BetAction[]; // 내가 지금 할 수 있는 액션
  amounts: { call: number; bbing: number; ddadang: number; half: number }; // 버튼 금액 표시
  seats: SeatView[];
  result: ResultView | null;
  lastAction: { seat: number; label: string; amount: number } | null;
}

export function buildView(game: SevenPokerGame, mySeat: number, names: string[]): GameView {
  const me = game.players[mySeat];
  const seats: SeatView[] = game.players.map((p, i) => ({
    name: names[i] ?? `좌석${i + 1}`,
    chips: p.chips,
    streetBet: p.streetBet,
    totalBet: p.totalBet,
    folded: p.folded,
    allIn: p.allIn,
    chosen: p.chosen,
    openCards: p.cards.filter((c) => p.openIds.includes(c.id)),
    hiddenCount: p.cards.length - p.openIds.length,
    isMe: i === mySeat,
  }));
  const result: ResultView | null = game.result && {
    winner: game.result.winner,
    payout: game.result.payout,
    bySurrender: game.result.bySurrender,
    hands: game.result.hands.map((h) => h && {
      cards: h.cards,
      catLabel: catName(h.value.cat),
      bestIds: h.value.cards.map((c) => c.id),
    }),
  };
  return {
    phase: game.phase,
    street: game.street,
    pot: game.pot,
    baseBet: BASE_BET,
    current: game.current,
    boss: game.boss,
    mySeat,
    myCards: me.cards,
    myOpenIds: me.openIds,
    toCall: game.phase === 'betting' ? game.toCall(mySeat) : 0,
    actions: game.phase === 'betting' ? game.availableActions(mySeat) : [],
    amounts: {
      call: game.phase === 'betting' ? game.toCall(mySeat) : 0,
      bbing: BASE_BET,
      ddadang: Math.max(0, game.currentBet * 2 - me.streetBet),
      half: game.currentBet + game.halfRaise() - me.streetBet,
    },
    seats,
    result,
    lastAction: game.lastAction && {
      seat: game.lastAction.seat,
      label: ACTION_NAMES[game.lastAction.action],
      amount: game.lastAction.amount,
    },
  };
}
