// 7포커 게임 상태머신 — 서버 권위로 실행. 규칙은 RULES.md 기준.
// 진행: 4장 분배 → (동시) 1장 버림+1장 공개 → 베팅 → 4·5·6번째(공개)·7번째(비공개) 각 배분 후 베팅 → 쇼다운. 베팅 총 5회.

import { Card, makeDeck, shuffle } from './cards';
import { HandValue, compareValue, evalBest, evalOpen, CAT, catName } from './hand';

export const BASE_BET = 1000; // 삥·앤티 단위
export const START_CHIPS = 100000;

export type Phase = 'choose' | 'betting' | 'ended';
export type BetAction = 'check' | 'bbing' | 'call' | 'ddadang' | 'half' | 'die';

export const ACTION_NAMES: Record<BetAction, string> = {
  check: '체크', bbing: '삥', call: '콜', ddadang: '따당', half: '하프', die: '다이',
};

export interface PlayerState {
  cards: Card[]; // 보유 카드 (버린 카드 제외)
  openIds: number[]; // 공개된 카드 id
  folded: boolean;
  allIn: boolean;
  chips: number;
  streetBet: number; // 이번 베팅 라운드에 낸 금액
  totalBet: number; // 이번 판 누적
  chosen: boolean; // 버림/공개 선택 완료
}

export interface ShowdownHand {
  cards: Card[]; // 공개된 7장
  value: HandValue; // 최고 5장 족보
}

export interface ResultInfo {
  winner: number;
  payout: number;
  bySurrender: boolean; // 나머지 전원 다이로 끝남 (패 비공개)
  hands: (ShowdownHand | null)[]; // 좌석별. 다이/비공개는 null
}

export interface LastAction {
  seat: number;
  action: BetAction;
  amount: number; // 이번 액션으로 낸 금액
}

export class SevenPokerGame {
  players: PlayerState[] = [];
  deck: Card[];
  phase: Phase = 'choose';
  street = 0; // 1~5 베팅 라운드
  pot = 0;
  current = 0; // 현재 액션 좌석
  boss = 0; // 이번 라운드 선
  currentBet = 0; // 이번 라운드 콜 기준 금액
  result: ResultInfo | null = null;
  lastAction: LastAction | null = null;
  private acted: boolean[] = []; // 이번 라운드, 현재 기준액에 대해 액션을 마쳤는지

  constructor(numPlayers: number, chips?: number[], rng: () => number = Math.random) {
    if (numPlayers < 2 || numPlayers > 6) throw new Error('인원은 2~6명');
    this.deck = shuffle(makeDeck(), rng);
    for (let i = 0; i < numPlayers; i++) {
      this.players.push({
        cards: [], openIds: [], folded: false, allIn: false,
        chips: chips?.[i] ?? START_CHIPS, streetBet: 0, totalBet: 0, chosen: false,
      });
    }
    // 앤티 — 전원 기본 단위 1장씩 판돈에
    for (const p of this.players) {
      const ante = Math.min(BASE_BET, p.chips);
      p.chips -= ante;
      p.totalBet += ante;
      this.pot += ante;
      if (p.chips === 0) p.allIn = true;
    }
    // 4장씩 분배 (전부 비공개)
    for (let k = 0; k < 4; k++) for (const p of this.players) p.cards.push(this.deck.pop()!);
  }

  // ── choose 단계: 1장 버리고 1장 공개 (전원 동시) ──────────────────────────
  choose(seat: number, discardId: number, openId: number): void {
    if (this.phase !== 'choose') throw new Error('지금은 선택 단계가 아님');
    const p = this.players[seat];
    if (!p || p.chosen) throw new Error('이미 선택함');
    if (discardId === openId) throw new Error('버릴 카드와 공개할 카드가 같음');
    const di = p.cards.findIndex((c) => c.id === discardId);
    const oi = p.cards.findIndex((c) => c.id === openId);
    if (di < 0 || oi < 0) throw new Error('내 카드가 아님');
    p.cards.splice(di, 1);
    p.openIds = [openId];
    p.chosen = true;
    if (this.players.every((x) => x.chosen)) this.startStreet(1);
  }

  // ── 베팅 라운드 ──────────────────────────────────────────────────────────
  private startStreet(s: number): void {
    this.street = s;
    this.phase = 'betting';
    // 2라운드부터 카드 1장씩 추가 분배 (다이 안 한 전원 — 올인도 받음). 마지막(5라운드) 카드는 비공개.
    if (s > 1) {
      for (const p of this.players) {
        if (p.folded) continue;
        const c = this.deck.pop()!;
        p.cards.push(c);
        if (s < 5) p.openIds.push(c.id);
      }
    }
    this.currentBet = 0;
    for (const p of this.players) p.streetBet = 0;
    this.acted = this.players.map(() => false);
    // 보스: 공개 카드 조합이 가장 높은 사람 (다이 제외)
    let boss = -1;
    let bossV: HandValue | null = null;
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (p.folded) continue;
      const v = evalOpen(p.cards.filter((c) => p.openIds.includes(c.id)));
      if (!bossV || compareValue(v, bossV) > 0) { boss = i; bossV = v; }
    }
    this.boss = boss;
    this.current = boss;
    // 액션 가능한 사람이 1명 이하면 베팅 생략 (올인 대치 등)
    if (this.actableCount() <= 1) { this.endStreet(); return; }
    if (!this.canAct(this.current)) this.advance();
  }

  private actableCount(): number {
    return this.players.filter((p) => !p.folded && !p.allIn).length;
  }

  private canAct(seat: number): boolean {
    const p = this.players[seat];
    return !p.folded && !p.allIn;
  }

  toCall(seat: number): number {
    return Math.max(0, this.currentBet - this.players[seat].streetBet);
  }

  // 판돈 절반 (하프 레이즈 금액)
  halfRaise(): number {
    return Math.ceil(this.pot / 2 / 100) * 100; // 100 단위 올림
  }

  // 좌석이 지금 할 수 있는 액션 목록 (버튼 표시용)
  availableActions(seat: number): BetAction[] {
    if (this.phase !== 'betting' || seat !== this.current || !this.canAct(seat)) return [];
    const p = this.players[seat];
    const toCall = this.toCall(seat);
    const out: BetAction[] = [];
    const othersActable = this.players.some((x, i) => i !== seat && !x.folded && !x.allIn);
    if (toCall === 0) out.push('check');
    else out.push('call');
    if (othersActable) {
      if (this.currentBet === 0 && p.chips >= BASE_BET) out.push('bbing');
      if (this.currentBet > 0 && p.chips >= this.currentBet * 2 - p.streetBet) out.push('ddadang');
      if (p.chips > toCall && this.halfRaise() > 0) out.push('half');
    }
    out.push('die');
    return out;
  }

  act(seat: number, action: BetAction): void {
    if (this.phase !== 'betting') throw new Error('지금은 베팅 단계가 아님');
    if (seat !== this.current) throw new Error('네 차례가 아님');
    if (!this.availableActions(seat).includes(action)) throw new Error(`지금 할 수 없는 액션: ${ACTION_NAMES[action]}`);
    const p = this.players[seat];
    const before = p.streetBet;

    if (action === 'die') {
      p.folded = true;
      this.lastAction = { seat, action, amount: 0 };
      const alive = this.players.filter((x) => !x.folded);
      if (alive.length === 1) { this.settle(this.players.indexOf(alive[0]), true); return; }
      this.acted[seat] = true;
      this.advance();
      return;
    }

    if (action === 'check') {
      // 낼 것 없음
    } else if (action === 'call') {
      this.pay(p, this.toCall(seat)); // 칩 부족이면 올인 콜 (사이드팟 없음 — RULES.md)
    } else if (action === 'bbing') {
      this.pay(p, BASE_BET);
      this.raiseTo(seat, p.streetBet);
    } else if (action === 'ddadang') {
      const target = this.currentBet * 2;
      this.pay(p, target - p.streetBet);
      this.raiseTo(seat, p.streetBet);
    } else if (action === 'half') {
      const target = this.currentBet + this.halfRaise();
      this.pay(p, target - p.streetBet);
      this.raiseTo(seat, p.streetBet);
    }

    this.acted[seat] = true;
    this.lastAction = { seat, action, amount: p.streetBet - before };
    this.advance();
  }

  private pay(p: PlayerState, amount: number): void {
    const actual = Math.min(Math.max(0, amount), p.chips);
    p.chips -= actual;
    p.streetBet += actual;
    p.totalBet += actual;
    this.pot += actual;
    if (p.chips === 0) p.allIn = true;
  }

  // 레이즈 — 기준액 갱신, 다른 사람들은 다시 액션해야 함
  private raiseTo(seat: number, newBet: number): void {
    if (newBet > this.currentBet) {
      this.currentBet = newBet;
      this.acted = this.players.map((_, i) => i === seat);
    }
  }

  private advance(): void {
    const n = this.players.length;
    for (let step = 1; step <= n; step++) {
      const i = (this.current + step) % n;
      if (!this.canAct(i)) continue;
      if (!this.acted[i] || this.players[i].streetBet < this.currentBet) {
        this.current = i;
        return;
      }
    }
    this.endStreet(); // 전원 기준액 맞춤 — 라운드 종료
  }

  private endStreet(): void {
    if (this.street >= 5) { this.showdown(); return; }
    this.startStreet(this.street + 1);
  }

  // ── 정산 ────────────────────────────────────────────────────────────────
  private showdown(): void {
    let winner = -1;
    let bestV: HandValue | null = null;
    const hands: (ShowdownHand | null)[] = this.players.map((p) => {
      if (p.folded) return null;
      return { cards: p.cards, value: evalBest(p.cards) };
    });
    for (let i = 0; i < hands.length; i++) {
      const h = hands[i];
      if (!h) continue;
      if (!bestV || compareValue(h.value, bestV) > 0) { winner = i; bestV = h.value; }
    }
    this.result = { winner, payout: this.pot, bySurrender: false, hands };
    this.players[winner].chips += this.pot;
    this.phase = 'ended';
  }

  private settle(winner: number, bySurrender: boolean): void {
    this.result = { winner, payout: this.pot, bySurrender, hands: this.players.map(() => null) };
    this.players[winner].chips += this.pot;
    this.phase = 'ended';
  }
}

// ── AI ──────────────────────────────────────────────────────────────────────
// 단순 휴리스틱 — 서버 자동 진행·솔로 모드 공용.

// 4장 중 버릴 카드와 공개할 카드 선택
export function aiChoose(game: SevenPokerGame, seat: number): { discardId: number; openId: number } {
  const cards = game.players[seat].cards;
  // 카드 가치: 페어 구성원 > 같은 무늬 다수 > 높은 숫자
  const score = (c: Card) => {
    const pairN = cards.filter((x) => x.rank === c.rank).length;
    const suitN = cards.filter((x) => x.suit === c.suit).length;
    return (pairN - 1) * 100 + (suitN - 1) * 8 + c.rank;
  };
  const sorted = [...cards].sort((a, b) => score(a) - score(b));
  const discard = sorted[0];
  const kept = cards.filter((c) => c.id !== discard.id);
  // 공개: 페어는 숨기고, 페어 아닌 카드 중 가장 높은 것. 전부 묶여 있으면 가장 낮은 것.
  const nonPair = kept.filter((c) => kept.filter((x) => x.rank === c.rank).length === 1);
  const open = (nonPair.length > 0 ? nonPair : kept).sort((a, b) =>
    nonPair.length > 0 ? b.rank - a.rank : a.rank - b.rank)[0];
  return { discardId: discard.id, openId: open.id };
}

// 현재 패 강도 0~10 (베팅 판단용)
function aiStrength(game: SevenPokerGame, seat: number): number {
  const cards = game.players[seat].cards;
  let made = 0; // 만들어진 족보 기준
  if (cards.length >= 5) {
    const v = evalBest(cards);
    made = v.cat >= CAT.STRAIGHT ? 8 + Math.min(2, v.cat - CAT.STRAIGHT)
      : v.cat === CAT.TRIPLE ? 6.5
      : v.cat === CAT.TWO_PAIR ? 5.5
      : v.cat === CAT.PAIR ? (v.ranks[0] >= 11 ? 4.5 : 3.5)
      : 1.5;
  } else {
    const v = evalOpen(cards); // 부분 패 — 페어류만 판단
    made = v.cat === CAT.TRIPLE ? 7 : v.cat === CAT.TWO_PAIR ? 5.5
      : v.cat === CAT.PAIR ? (v.ranks[0] >= 11 ? 4.5 : 3.5)
      : Math.max(0, (Math.max(...cards.map((c) => c.rank)) - 9) * 0.5);
  }
  // 드로우 보너스: 같은 무늬 4장(플러시 드로우), 연속 4장(스트레이트 드로우)
  if (cards.length >= 4 && game.street <= 4) {
    const suitMax = Math.max(...['s', 'd', 'h', 'c'].map((s) => cards.filter((c) => c.suit === s).length));
    if (suitMax >= 4) made = Math.max(made, 5.5);
    const ranks = [...new Set(cards.map((c) => c.rank))].sort((a, b) => a - b);
    for (let i = 0; i + 3 < ranks.length; i++) {
      if (ranks[i + 3] - ranks[i] <= 4) { made = Math.max(made, 5); break; }
    }
  }
  return made;
}

// 베팅 액션 결정
export function aiAct(game: SevenPokerGame, seat: number, rng: () => number = Math.random): BetAction {
  const avail = game.availableActions(seat);
  const s = aiStrength(game, seat) + rng() * 1.5; // 약간의 무작위성
  const toCall = game.toCall(seat);
  const pot = game.pot;
  const pick = (...prefs: BetAction[]) => prefs.find((a) => avail.includes(a)) ?? 'die';

  if (s >= 7.5) { // 강한 패 — 키우기, 가끔 숨기기
    if (rng() < 0.25) return pick('call', 'check');
    return pick(rng() < 0.5 ? 'half' : 'ddadang', 'half', 'bbing', 'call', 'check');
  }
  if (s >= 5) { // 중간 — 따라가기, 가끔 선제 베팅
    if (toCall === 0) return pick(rng() < 0.3 ? 'bbing' : 'check', 'check');
    if (toCall <= Math.max(BASE_BET * 4, pot / 3)) return pick('call');
    return rng() < 0.5 ? pick('call') : 'die';
  }
  // 약한 패 — 공짜면 보고, 싸면 가끔 따라가고, 비싸면 접기
  if (toCall === 0) return pick('check');
  if (toCall <= BASE_BET * 2 && rng() < 0.5) return pick('call');
  return 'die';
}

export { catName };
