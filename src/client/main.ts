// 7포커 클라이언트 — 화면·입력만 담당 (얇은 클라).
// 솔로: 로컬 엔진 + AI 3명. 멀티: Colyseus 서버 권위, 같은 뷰 구조를 받아 그린다.

import { Card, SUIT_SYMBOL, rankLabel } from '../engine/cards';
import { SevenPokerGame, aiChoose, aiAct, BASE_BET, START_CHIPS, BetAction, ACTION_NAMES } from '../engine/game';
import { evalBest, evalOpen, catName, CAT } from '../engine/hand';
import { buildView, GameView } from '../engine/view';
import { connectGame, fetchOnlineCount, NetHandle } from './net';
import { sfx, voice, bgm, unlock, setSoundEnabled, isSoundEnabled,
  setMusicVolume, setSfxVolume, getMusicVolume, getSfxVolume } from './sound';

type View = GameView & { turnRemainMs?: number | null };
type Mode = 'lobby' | 'solo' | 'multi';

// 데모 빌드 여부 — define 미치환(개발 서버 stale 등)이어도 ReferenceError 안 나게 안전 접근
const DEMO = typeof __DEMO__ !== 'undefined' ? __DEMO__ : false;

const $ = (id: string) => document.getElementById(id)!;
const fmt = (n: number) => n.toLocaleString('ko-KR');
const STREET_NAMES = ['', '1차 베팅', '2차 베팅', '3차 베팅', '4차 베팅', '마지막 베팅'];
const SOLO_NAMES = ['나', 'AI 민수', 'AI 영자', 'AI 철호'];

let mode: Mode = 'lobby';
let net: NetHandle | null = null;
let solo: { game: SevenPokerGame; chips: number[] } | null = null;
let soloTimer: ReturnType<typeof setTimeout> | null = null;
let lastView: View | null = null;
let pick: { discardId: number | null; openId: number | null } = { discardId: null, openId: null };
let pickKey = ''; // 내 손패가 바뀌면 선택 초기화

// ── 화면 전환 ────────────────────────────────────────────────────────────────
let curScreen = '';
function show(id: 'lobby' | 'waiting' | 'game'): void {
  for (const s of ['lobby', 'waiting', 'game']) $(s).classList.toggle('show', s === id);
  if (id !== 'game') $('overlay').classList.remove('show');
  $('autoToggle').style.display = id === 'game' ? 'block' : 'none';
  // 배경음악은 화면이 실제로 바뀔 때만 제어(매 렌더마다 play() 호출 방지)
  if (id !== curScreen) { if (id === 'game') bgm.start(); else bgm.stop(); curScreen = id; }
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(msg: string): void {
  const t = $('toast');
  t.textContent = msg;
  t.style.display = 'block';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.display = 'none'; }, 2500);
}

function myName(): string {
  return ($('nameInput') as HTMLInputElement).value.trim().slice(0, 12);
}

function backToLobby(): void {
  mode = 'lobby';
  net?.leave(); net = null;
  solo = null;
  if (soloTimer) { clearTimeout(soloTimer); soloTimer = null; }
  lastView = null;
  trk.phase = ''; trk.calloutKey = ''; trk.street = 0; trk.myTurn = false; // 다음 게임 시작 멘트 위해 초기화
  scatterEls.forEach((el) => el.remove()); scatterEls = []; // 흩뿌린 칩 정리
  show('lobby');
}

// ── 카드 그리기 ──────────────────────────────────────────────────────────────
function cardEl(c: Card, small = false): HTMLElement {
  const d = document.createElement('div');
  d.className = 'card' + (small ? ' sm' : '') + (c.suit === 'h' || c.suit === 'd' ? ' red' : '');
  d.innerHTML = `<span class="r">${rankLabel(c.rank)}</span><span class="s">${SUIT_SYMBOL[c.suit]}</span>`;
  return d;
}
function backEl(small = false): HTMLElement {
  const d = document.createElement('div');
  d.className = 'card back' + (small ? ' sm' : '');
  return d;
}

// ── 사운드/연출 전환 추적(재렌더 시 중복 발동 방지) ──────────────────────────
const trk = { calloutKey: '', myTurn: false, phase: '', street: 0 };
let justDealt = false;            // 새 판 첫 렌더(상대 뒷장 포함 전부 분배 연출)
let shownIds = new Set<number>(); // 이미 등장(연출 완료)한 카드 id — 새로 받은 카드만 다시 연출
let pendingFly: { seat: number; amount: number } | null = null; // 칩 날리기 예약(좌석+금액)
let seatActs: Record<number, string> = {}; // 좌석별 이번 라운드 마지막 액션(체크/콜/따당…) 표시용
let scatterEls: HTMLElement[] = []; // 중앙에 흩뿌려진(아직 안 모은) 베팅 칩들
let pendingAnte = false;           // 새 판 시작 시 기본 칩(앤티) 걷는 연출 예약
const ACT_SFX: Record<string, () => void> = {
  체크: sfx.check, 삥: sfx.bet, 콜: sfx.chip, 따당: sfx.bet, 하프: sfx.bet, 다이: sfx.die,
};
const AVATAR_HUES = [205, 12, 145, 280, 45, 330];
function avatarHue(name: string): number {
  let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_HUES[h % AVATAR_HUES.length];
}
function avatarHtml(name: string, big = false): string {
  const hue = avatarHue(name);
  const letter = esc((name.trim()[0] ?? '?').toUpperCase());
  return `<div class="avatar${big ? ' big' : ''}" style="--hue:${hue}">${letter}</div>`;
}

// 금액을 액면가별 칩 기둥으로 그림(이모지 미사용, CSS 칩).
// DENOMS: 액면가가 클수록 검정→파랑→초록→빨강. 높은 액면가부터 기둥을 세운다.
const DENOMS: [number, string][] = [[50000, 'k'], [10000, 'b'], [5000, 'g'], [1000, 'r']];
let prevPot = 0;
let prevMyChips = 0;

function renderStacks(el: HTMLElement, amount: number, maxChips: number, animate: boolean): void {
  el.innerHTML = '';
  if (amount <= 0) return;
  let rem = amount, delay = 0;
  for (const [val, color] of DENOMS) {
    let cnt = Math.floor(rem / val); // 액면가별 정확한 칩 수(보유 금액과 일치)
    if (cnt <= 0) continue;
    rem -= cnt * val;
    cnt = Math.min(maxChips, cnt); // 너무 높이 쌓이지 않게 시각적 상한만
    const stack = document.createElement('div');
    stack.className = 'stack';
    for (let i = 0; i < cnt; i++) {
      const c = document.createElement('div');
      c.className = `chip ${color}`;
      if (animate) { c.classList.add('pop'); c.style.animationDelay = `${delay}s`; delay += 0.04; }
      stack.append(c);
    }
    el.append(stack);
  }
}

function fireCallout(seatName: string, label: string, amount: number): void {
  const el = $('callout');
  el.className = '';
  (el.querySelector('.who') as HTMLElement).textContent = seatName;
  (el.querySelector('.act') as HTMLElement).textContent = label + (amount > 0 ? ` ${fmt(amount)}` : '');
  // 리플로우로 애니메이션 재시작
  void el.offsetWidth;
  el.className = 'show' + (label === '다이' ? ' die' : '');
}

// 금액을 액면가별 칩 색 배열로(높은 액면가부터). 베팅 칩 연출의 단위를 정확히 맞춘다.
function chipColors(amount: number, cap: number): string[] {
  const out: string[] = [];
  let rem = amount;
  for (const [val, color] of DENOMS) {
    const cnt = Math.floor(rem / val);
    rem -= cnt * val;
    for (let k = 0; k < cnt; k++) out.push(color);
  }
  return out.slice(0, cap);
}

// 베팅하면 그 자리(내 스택/상대 좌석)에서 칩이 중앙으로 날아가 '랜덤하게 흩뿌려져' 잔류한다.
// 칩 색은 베팅 금액의 액면가와 일치. 흩뿌린 칩들은 베팅 라운드가 끝날 때 gatherChips()로 모은다.
// 칩이 모이는 한 곳 = Total/Call 박스 바로 위 더미(#chipPile). 흩뿌린 칩·앤티·베팅이 모두 여기로.
function scatterTarget(): { cx: number; cy: number } {
  const pile = $('chipPile').getBoundingClientRect();
  if (pile.width) return { cx: pile.left + pile.width / 2, cy: pile.top + pile.height / 2 };
  const b = $('potBox').getBoundingClientRect();
  if (b.width) return { cx: b.left + b.width / 2, cy: b.top - 6 };
  const c = $('center').getBoundingClientRect();
  return { cx: c.left + c.width / 2, cy: c.top + c.height / 2 };
}
function flyChips(seatIdx: number, amount: number, mySeat: number, spread = 18): void {
  const fromEl = seatIdx === mySeat ? $('myStack') : document.querySelector(`.seat[data-seat="${seatIdx}"]`);
  if (!fromEl) return;
  const f = (fromEl as HTMLElement).getBoundingClientRect();
  const sx = f.left + f.width / 2, sy = f.top + f.height / 2;
  const { cx, cy } = scatterTarget();
  const colors = chipColors(amount, 8);
  if (!colors.length) colors.push('r');
  colors.forEach((color, i) => {
    const chip = document.createElement('div');
    chip.className = `flyChip chip ${color}`;
    chip.style.left = `${sx}px`;
    chip.style.top = `${sy}px`;
    document.body.append(chip);
    // potBox 위 한 구역으로 모이게(spread 작을수록 딱 모임)
    const rx = cx + (Math.random() * 2 - 1) * spread;
    const ry = cy + (Math.random() * 2 - 1) * Math.max(4, spread / 2);
    const anim = chip.animate(
      [
        { transform: 'translate(-50%,-50%) scale(.45)', opacity: 0.2 },
        { opacity: 1, offset: 0.2 },
        { transform: `translate(calc(${rx - sx}px - 50%), calc(${ry - sy}px - 50%)) scale(1)`, opacity: 1 },
      ],
      { duration: 460, delay: i * 45, easing: 'cubic-bezier(.1,.8,.2,1)', fill: 'forwards' }, // 출발 빠르게, 끝은 스르르
    );
    anim.onfinish = () => {
      // 최종 위치를 인라인으로 고정한 뒤 애니메이션 취소 — fill:forwards가 transform을 붙들어
      // 위치가 두 배로 어긋나는 것 방지(앤티가 더미가 아니라 출발점 구석에 멈추던 버그).
      chip.style.left = `${rx}px`; chip.style.top = `${ry}px`; chip.style.transform = 'translate(-50%,-50%)';
      anim.cancel();
    };
    scatterEls.push(chip);
  });
}

// 베팅 라운드가 끝나면 흩뿌린 칩들이 가운데 더미로 '싸사삭' 모인다.
function gatherChips(): void {
  if (!scatterEls.length) return;
  const pile = $('chipPile');
  const { cx: tx, cy: ty } = scatterTarget();
  const els = scatterEls;
  scatterEls = [];
  sfx.chip(); // 싸사삭
  els.forEach((el, i) => {
    const r = el.getBoundingClientRect();
    const dx = tx - (r.left + r.width / 2), dy = ty - (r.top + r.height / 2);
    const a = el.animate(
      [
        { transform: 'translate(-50%,-50%)' },
        { transform: `translate(calc(${dx}px - 50%), calc(${dy}px - 50%))` },
      ],
      { duration: 320, delay: i * 22, easing: 'cubic-bezier(.12,.82,.24,1)', fill: 'forwards' }, // 출발 빠르게, 끝은 스르르
    );
    a.onfinish = () => el.remove();
  });
  setTimeout(() => { pile.classList.remove('bump'); void pile.offsetWidth; pile.classList.add('bump'); }, 280 + els.length * 22);
}

const ACT_VOICE: Record<string, Parameters<typeof voice>[0]> = {
  체크: 'check', 삥: 'bbing', 콜: 'call', 따당: 'ddadang', 하프: 'half', 다이: 'die',
};

function runTransitions(v: View): void {
  // 게임 첫 진입 시 시작 멘트
  if (!trk.phase) setTimeout(() => voice('start'), 200);
  // 카드 분배(초이스 진입) / 새 오픈 카드(스트리트 증가) — 라운드 끝나면 흩뿌린 칩 모으고, 좌석 액션 표시 초기화
  if (v.phase === 'choose' && trk.phase !== 'choose') { gatherChips(); sfx.deal(); justDealt = true; shownIds = new Set(); seatActs = {}; pendingAnte = true; }
  if (v.phase === 'betting' && v.street > trk.street && trk.phase) { gatherChips(); sfx.card(); seatActs = {}; }

  // 액션 콜아웃 + 효과음 + 성우 (+ 베팅이면 칩 날리기 예약)
  if (v.lastAction) {
    const a = v.lastAction;
    const k = `${a.seat}:${a.label}:${a.amount}`;
    if (k !== trk.calloutKey) {
      trk.calloutKey = k;
      fireCallout(v.seats[a.seat].name, a.label, a.amount);
      seatActs[a.seat] = a.label + (a.amount > 0 ? ` ${fmt(a.amount)}` : ''); // 그 사람 자리에 표시
      (ACT_SFX[a.label] ?? sfx.chip)();
      if (ACT_VOICE[a.label]) setTimeout(() => voice(ACT_VOICE[a.label]), 120);
      if (a.amount > 0) pendingFly = { seat: a.seat, amount: a.amount };
    }
  }

  // 내 차례 알림
  const myTurn = v.phase === 'betting' && v.current === v.mySeat
    && !v.seats[v.mySeat].folded && !v.seats[v.mySeat].allIn;
  if (myTurn && !trk.myTurn) { sfx.turn(); setTimeout(() => voice('yourturn'), 200); }
  trk.myTurn = myTurn;

  // 종료(승/패) — 흩뿌린 칩 모으고 결과음
  if (v.phase === 'ended' && trk.phase !== 'ended' && v.result) {
    gatherChips();
    if (v.result.winner === v.mySeat) { sfx.win(); setTimeout(() => voice('win'), 350); }
    else { sfx.lose(); setTimeout(() => voice('lose'), 250); }
  }

  trk.phase = v.phase;
  trk.street = v.street;
}

// 카드 분배 연출(2단계):
//  1) 모든 카드가 화면 위 가운데(딜러)에서 '뒷면'으로 날아와 안착
//  2) 안착하면 앞면 있는 카드(내 카드 + 상대 공개 카드)를 한 장씩 제자리에서 뒤집어 공개(상대 히든은 그대로)
// render()에서 '동기' 호출 — getBoundingClientRect로 레이아웃을 잰 직후라 좌표가 정확하고,
// dealAnimUntil이 soloStep보다 먼저 잡혀 연출이 안 끊긴다.
let dealAnimUntil = 0; // 이 시각까지는 솔로 AI가 기다림(연출 안 끊기게)
function animateDeal(): void {
  const cx = window.innerWidth / 2, cy = 4; // 화면 최상단 가운데(딜러)
  const all = Array.from(document.querySelectorAll('.card.dealt')) as HTMLElement[];
  all.forEach((el) => el.classList.remove('dealt'));
  const faces = all.filter((el) => !el.classList.contains('back')); // 앞면 있는 카드 → 뒷면으로 와서 뒤집기
  const backs = all.filter((el) => el.classList.contains('back'));   // 상대 히든 → 그냥 안착
  const FLY = 300;
  const flyFrom = (el: HTMLElement, delay: number): void => {
    const r = el.getBoundingClientRect();
    const dx = cx - (r.left + r.width / 2), dy = cy - (r.top + r.height / 2);
    el.animate(
      [
        { transform: `translate(${dx}px,${dy}px) scale(.3) rotate(-7deg)`, opacity: 0 },
        { opacity: 1, offset: 0.3 },
        { transform: 'none', opacity: 1 },
      ],
      { duration: FLY, delay, easing: 'cubic-bezier(.2,.7,.3,1.04)', fill: 'backwards' },
    );
  };
  // 1) 딜 — 모든 카드 뒷면으로(앞면 카드는 dealback) 위에서 날아와 안착
  backs.forEach((el, i) => flyFrom(el, i * 14));
  const faceStart = backs.length * 14 + 50;
  faces.forEach((el, i) => { el.classList.add('dealback'); flyFrom(el, faceStart + i * 48); });
  // 2) 리빌 — 앞면 카드 한 장씩 제자리에서 3D 회전(2배 빠르게)으로 공개
  const FLIP = 190, GAP = 85;
  const revealStart = faceStart + Math.max(0, faces.length - 1) * 48 + FLY + 100;
  faces.forEach((el, i) => {
    setTimeout(() => {
      if (!el.isConnected) return; // 재렌더로 교체됐으면 skip
      el.animate(
        [
          { transform: 'perspective(700px) rotateY(180deg) scale(1)' },
          { transform: 'perspective(700px) rotateY(90deg) scale(1.14)', offset: 0.5 },
          { transform: 'perspective(700px) rotateY(0deg) scale(1)' },
        ],
        { duration: FLIP, easing: 'cubic-bezier(.4,.05,.25,1)' },
      );
      setTimeout(() => { el.classList.remove('dealback'); sfx.card(); }, FLIP / 2); // edge-on에서 앞면
    }, revealStart + i * GAP);
  });
  const total = revealStart + Math.max(0, faces.length - 1) * GAP + FLIP + 80;
  dealAnimUntil = performance.now() + total;
}

// 버리는 연출 — 버릴 카드가 위(딜러 쪽)로 회전·축소·페이드되며 날아가 사라지고, 공개 카드는 팝.
function discardFly(rect: DOMRect, card: Card, openId: number): void {
  const ghost = cardEl(card); // 실제 버린 카드(날아가며 회전)
  ghost.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;z-index:40;margin:0;`;
  document.body.append(ghost);
  // 카드 위치 기준 가까운 쪽 옆(왼/오른)으로 날아가 사라짐
  const cardCx = rect.left + rect.width / 2;
  const goLeft = cardCx < window.innerWidth / 2;
  const tx = goLeft ? -(cardCx + rect.width) : (window.innerWidth - cardCx + rect.width);
  const rot = goLeft ? -150 : 150;
  sfx.toss();
  const anim = ghost.animate(
    [
      { transform: 'translate(0,0) rotate(0) scale(1)', opacity: 1 },
      { transform: 'translate(0,-16px) scale(1.05)', opacity: 1, offset: 0.16 },
      { transform: `translate(${tx}px, -8px) rotate(${rot}deg) scale(.5)`, opacity: 0 },
    ],
    { duration: 500, easing: 'cubic-bezier(.4,0,.7,1)', fill: 'forwards' },
  );
  anim.onfinish = () => ghost.remove();
  // 공개 카드 팝(렌더된 뒤 잠깐 강조)
  setTimeout(() => {
    const op = document.querySelector(`#myCards .card[data-id="${openId}"]`) as HTMLElement | null;
    if (op) op.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.18)', offset: 0.5 }, { transform: 'scale(1)' }],
      { duration: 320, easing: 'cubic-bezier(.3,1.4,.5,1)' },
    );
  }, 120);
}

// ── 오토(자동 진행) ──────────────────────────────────────────────────────────
let auto = false;
let autoTimer: ReturnType<typeof setTimeout> | null = null;

// 멀티용 자동 베팅 — 내 패(공개+비공개 모두 내가 앎)를 평가해 세기에 맞춰 베팅
function autoBetMulti(v: View): BetAction {
  const pick = (...prefs: BetAction[]): BetAction =>
    prefs.find((a) => v.actions.includes(a)) ?? (v.actions.includes('die') ? 'die' : v.actions[0]);
  const cat = (v.myCards.length >= 5 ? evalBest(v.myCards) : evalOpen(v.myCards)).cat; // 5장 미만이면 evalOpen
  const toCall = v.toCall;
  const unit = v.amounts.bbing;
  if (cat >= CAT.STRAIGHT) return pick('half', 'ddadang', 'bbing', 'call', 'check'); // 강 — 키우기
  if (cat >= CAT.TWO_PAIR) {
    if (toCall === 0) return pick('bbing', 'check');
    return toCall <= Math.max(unit * 4, v.pot / 3) ? pick('call') : pick('call', 'die');
  }
  if (cat >= CAT.PAIR) {
    if (toCall === 0) return pick('check');
    return toCall <= unit * 3 ? pick('call') : 'die';
  }
  if (toCall === 0) return pick('check'); // 약 — 공짜면 보기
  return toCall <= unit * 2 && Math.random() < 0.4 ? pick('call') : (v.actions.includes('die') ? 'die' : pick('check', 'call'));
}

function scheduleAuto(v: View): void {
  if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
  if (!auto) return;
  const me = v.seats[v.mySeat];
  if (v.phase === 'choose' && !me.chosen) {
    autoTimer = setTimeout(() => {
      // 솔로는 엔진 AI 그대로, 멀티는 낮은 패 버리고 높은 패 공개
      if (mode === 'solo' && solo) { const m = aiChoose(solo.game, v.mySeat); sendChoose(m.discardId, m.openId); return; }
      const sorted = [...v.myCards].sort((a, b) => a.rank - b.rank);
      if (sorted.length >= 2) sendChoose(sorted[0].id, sorted[sorted.length - 1].id);
    }, 600);
  } else if (v.phase === 'betting' && v.current === v.mySeat && !me.folded && !me.allIn) {
    autoTimer = setTimeout(() => {
      if (!v.actions.length) return;
      const a = mode === 'solo' && solo ? aiAct(solo.game, v.mySeat) : autoBetMulti(v);
      sendBet(a);
    }, 700);
  } else if (v.phase === 'ended') {
    autoTimer = setTimeout(() => { if (auto) rematch(); }, 2600);
  }
}

// ── 메인 렌더 ────────────────────────────────────────────────────────────────
function render(v: View): void {
  const isRerender = lastView === v; // onPick 등 같은 뷰 재렌더면 사운드 생략
  lastView = v;
  show('game');
  if (!isRerender) runTransitions(v);

  // 손패가 바뀌었으면(새 판 등) 선택 초기화
  const key = v.myCards.map((c) => c.id).join(',');
  if (key !== pickKey) { pickKey = key; pick = { discardId: null, openId: null }; }

  // 상대들
  const opps = $('opps');
  opps.innerHTML = '';
  v.seats.forEach((s, i) => {
    if (i === v.mySeat) return;
    const d = document.createElement('div');
    d.dataset.seat = String(i);
    d.className = 'seat'
      + (v.phase === 'betting' && v.current === i ? ' turn' : '')
      + (s.folded ? ' folded' : '');
    const badges = [
      v.phase !== 'choose' && v.boss === i ? '<span class="badge boss">보스</span>' : '',
      s.allIn ? '<span class="badge allin">올인</span>' : '',
      s.folded ? '<span class="badge">다이</span>' : '',
    ].join(' ');
    d.innerHTML = `
      <div class="top">
        ${avatarHtml(s.name)}
        <div class="who">
          <div class="nm">${esc(s.name)} ${badges}</div>
          <div class="chips">${fmt(s.chips)} G</div>
        </div>
      </div>
      ${s.streetBet > 0 ? `<div class="seatbet">+${fmt(s.streetBet)}</div>` : ''}
      ${seatActs[i] ? `<div class="seatact">${esc(seatActs[i])}</div>` : ''}`;
    const cards = document.createElement('div');
    cards.className = 'cards';
    const oppCards: HTMLElement[] = [];
    if (v.phase === 'choose' && !s.chosen) {
      for (let k = 0; k < 4; k++) { const el = backEl(true); if (justDealt) el.classList.add('dealt'); oppCards.push(el); }
    } else {
      // 뒷면(히든)을 먼저 깔고 공개 카드를 위로 — 많이 겹쳐도 앞면이 안 가려지게
      for (let k = 0; k < s.hiddenCount; k++) { const el = backEl(true); if (justDealt) el.classList.add('dealt'); oppCards.push(el); }
      for (const c of s.openCards) {
        const el = cardEl(c, true);
        if (justDealt || !shownIds.has(c.id)) el.classList.add('dealt'); // 새로 받은 공개 카드만 연출
        shownIds.add(c.id);
        oppCards.push(el);
      }
    }
    oppCards.forEach((el) => cards.append(el));
    d.append(cards);
    opps.append(d);
  });

  // 중앙
  $('street').textContent =
    v.phase === 'choose' ? '카드 선택 — 1장 버리고 1장 공개'
    : v.phase === 'betting' ? STREET_NAMES[v.street]
    : '결과';
  renderStacks($('chipPile'), v.pot, 8, v.pot > prevPot);
  prevPot = v.pot;
  $('potTotal').textContent = fmt(v.pot);
  $('potCall').textContent = fmt(v.toCall);
  $('seed').textContent = `시드 ${fmt(v.baseBet)}`;

  // 내 영역
  const meSeat = v.seats[v.mySeat];
  $('me').classList.toggle('turn', v.phase === 'betting' && v.current === v.mySeat);
  const myBadges = [
    v.phase !== 'choose' && v.boss === v.mySeat ? '<span class="badge boss">보스</span>' : '',
    meSeat.folded ? '<span class="badge">다이</span>' : '',
    meSeat.allIn ? '<span class="badge allin">올인</span>' : '',
  ].join(' ');
  $('myInfo').innerHTML = `
    ${avatarHtml(meSeat.name)}
    <div class="who"><div class="nm">${esc(meSeat.name)} ${myBadges}
      ${seatActs[v.mySeat] ? `<span class="seatact inline">${esc(seatActs[v.mySeat])}</span>` : ''}</div>
      <div class="chips">${fmt(meSeat.chips)} G${meSeat.streetBet > 0 ? ` · 베팅 +${fmt(meSeat.streetBet)}` : ''}</div></div>`;
  // 내 보유 칩 스택(낮게) — 칩이 늘 때만 pop
  renderStacks($('myStack'), meSeat.chips, 12, meSeat.chips > prevMyChips);
  prevMyChips = meSeat.chips;
  // 내 현재 족보(투페어/트리플/풀하우스…) 표시
  $('myHand').textContent = v.myCards.length
    ? `내 패: ${catName((v.myCards.length >= 5 ? evalBest(v.myCards) : evalOpen(v.myCards)).cat)}`
    : '';
  renderTimer(v);
  renderMyCards(v);
  renderActions(v);

  // 카드 분배 연출 — 새로 등장한 카드(.dealt)가 있으면 위에서 날아오게.
  // 동기 호출: 빌드 직후라 좌표 정확 + dealAnimUntil이 soloStep보다 먼저 잡혀 연출이 안 끊김.
  if (document.querySelector('.card.dealt')) animateDeal();
  justDealt = false;
  // 칩 날리기(베팅 직후) — 새 DOM 좌표 기준으로 실행
  if (pendingFly != null) { const pf = pendingFly; pendingFly = null; requestAnimationFrame(() => flyChips(pf.seat, pf.amount, v.mySeat)); }
  // 새 판 시작 — 각 자리에서 기본 칩(앤티) 걷는 연출
  if (pendingAnte) {
    pendingAnte = false;
    const ms = v.mySeat, amt = v.baseBet, n = v.seats.length;
    // 앤티는 흩뿌리지 말고 potBox 위에 딱 모이게(spread 작게)
    for (let i = 0; i < n; i++) setTimeout(() => flyChips(i, amt, ms, 5), 140 + i * 110);
  }

  // 오토 진행 예약
  scheduleAuto(v);

  // 결과
  if (v.phase === 'ended' && v.result) showResult(v);
  else $('overlay').classList.remove('show');
}

function renderTimer(v: View): void {
  const wrap = $('timerWrap');
  const bar = $('timerBar') as HTMLElement;
  const myTurn = (v.phase === 'betting' && v.current === v.mySeat) || (v.phase === 'choose' && !v.seats[v.mySeat].chosen);
  if (v.turnRemainMs == null || v.phase === 'ended' || !myTurn) { wrap.classList.remove('show'); return; }
  wrap.classList.add('show');
  const total = 20000; // 표시용 기준 시간
  const ratio = Math.max(0, Math.min(1, v.turnRemainMs / total));
  bar.style.width = `${ratio * 100}%`;
  bar.classList.toggle('low', v.turnRemainMs < 6000);
}

let lastMyCardKey = ''; // 내 손패 구성이 바뀌었는지(바뀔 때만 FLIP 슬라이드)
function renderMyCards(v: View): void {
  const box = $('myCards');
  // FLIP 준비 — 손패 구성이 바뀐 경우에만 기존 카드 위치를 기록(선택 토글 재렌더엔 적용 안 함)
  const key = v.myCards.map((c) => c.id).slice().sort((a, b) => a - b).join(',');
  const structural = key !== lastMyCardKey;
  lastMyCardKey = key;
  const oldRects = new Map<number, DOMRect>();
  if (structural) box.querySelectorAll('.card[data-id]').forEach((el) => oldRects.set(Number((el as HTMLElement).dataset.id), el.getBoundingClientRect()));
  box.innerHTML = '';
  const choosing = v.phase === 'choose' && !v.seats[v.mySeat].chosen;
  // 숫자 높은 순으로 정렬해서 족보가 한눈에 보이게
  const sorted = [...v.myCards].sort((a, b) => b.rank - a.rank);
  // 현재 족보를 이루는 카드(강조용) — 선택 중에는 표시 안 함(선택 테두리와 혼동 방지)
  let bestIds = new Set<number>();
  if (!choosing && v.myCards.length) {
    try { bestIds = new Set((v.myCards.length >= 5 ? evalBest(v.myCards) : evalOpen(v.myCards)).cards.map((c) => c.id)); } catch { /* 무시 */ }
  }
  sorted.forEach((c) => {
    const el = cardEl(c);
    el.dataset.id = String(c.id); // 버리기/공개 연출 대상 지정용
    if (justDealt || !shownIds.has(c.id)) el.classList.add('dealt'); // 새로 받은 카드만 연출
    shownIds.add(c.id);
    if (!choosing && !v.myOpenIds.includes(c.id)) el.classList.add('hiddenMark');
    if (!choosing && bestIds.has(c.id)) el.classList.add('best');
    if (choosing) {
      el.classList.add('mine');
      if (pick.discardId === c.id) el.classList.add('selDiscard');
      if (pick.openId === c.id) el.classList.add('selOpen');
      el.onclick = () => onPick(c.id);
    }
    box.append(el);
  });
  // FLIP 재생 — 기존 카드(새로 딜되는 카드 제외)를 옛 위치에서 새 위치로 스르르 이동
  if (structural && oldRects.size) {
    box.querySelectorAll('.card[data-id]').forEach((el) => {
      const c = el as HTMLElement;
      if (c.classList.contains('dealt')) return; // 새 카드는 딜 연출이 담당
      const old = oldRects.get(Number(c.dataset.id));
      if (!old) return;
      const nr = c.getBoundingClientRect();
      const dx = old.left - nr.left, dy = old.top - nr.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
      c.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: 'none' }],
        { duration: 280, easing: 'cubic-bezier(.3,.7,.3,1)' });
    });
  }
}

function onPick(id: number): void {
  sfx.select();
  if (pick.discardId === id) pick.discardId = null;
  else if (pick.openId === id) pick.openId = null;
  else if (pick.discardId == null) pick.discardId = id;
  else if (pick.openId == null) pick.openId = id;
  if (lastView) render(lastView);
}

function renderActions(v: View): void {
  const prompt = $('prompt');
  const box = $('actions');
  box.innerHTML = '';
  prompt.textContent = '';

  if (v.phase === 'choose') {
    if (v.seats[v.mySeat].chosen) { prompt.textContent = '다른 사람의 선택을 기다리는 중…'; return; }
    prompt.textContent =
      pick.discardId == null ? '버릴 카드를 누르세요 (빨간 테두리)'
      : pick.openId == null ? '공개할 카드를 누르세요 (초록 테두리)'
      : '아래 확정을 누르세요';
    const ok = btn('확정', () => {
      if (pick.discardId == null || pick.openId == null) return;
      sendChoose(pick.discardId, pick.openId);
    });
    if (pick.discardId == null || pick.openId == null) ok.setAttribute('disabled', '');
    box.append(ok);
    const reset = btn('다시 선택', () => { pick = { discardId: null, openId: null }; if (lastView) render(lastView); }, 'ghost');
    box.append(reset);
    return;
  }

  if (v.phase === 'betting') {
    const me = v.seats[v.mySeat];
    const myTurn = v.current === v.mySeat && !me.folded && !me.allIn;
    prompt.textContent =
      me.folded ? '다이 — 이번 판은 구경'
      : me.allIn ? '올인 — 결과를 기다리는 중'
      : !myTurn ? `${v.seats[v.current].name} 차례…`
      : v.toCall > 0 ? `콜 하려면 ${fmt(v.toCall)} 필요` : '내 차례';
    const labels: Record<BetAction, string> = {
      check: ACTION_NAMES.check,
      bbing: `${ACTION_NAMES.bbing} ${fmt(v.amounts.bbing)}`,
      call: `${ACTION_NAMES.call} ${fmt(v.amounts.call)}`,
      ddadang: `${ACTION_NAMES.ddadang} ${fmt(v.amounts.ddadang)}`,
      half: `${ACTION_NAMES.half} ${fmt(v.amounts.half)}`,
      die: ACTION_NAMES.die,
    };
    // 베팅 버튼은 하단에 항상 표시 — 지금 할 수 없는 건 비활성
    const ORDER: BetAction[] = ['die', 'check', 'bbing', 'call', 'ddadang', 'half'];
    for (const a of ORDER) {
      const b = btn(labels[a], () => sendBet(a), a === 'die' ? 'danger' : '');
      if (!(myTurn && v.actions.includes(a))) b.setAttribute('disabled', '');
      box.append(b);
    }
  }
}

function btn(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'btn' + (cls ? ` ${cls}` : '');
  b.textContent = label;
  b.onclick = onClick;
  return b;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
}

// 공항 현황판(스플릿 플랩)처럼 자릿수마다 숫자가 굴러 올라가 멈추는 연출.
// 각 자리에 0~9 세로 띠를 두고 두 바퀴 돌려 최종 숫자에 착지(자리마다 시차).
function flipNumber(el: HTMLElement, target: number): void {
  const num = fmt(target); // 콤마 포함 문자열
  const digits: string[] = [];
  let html = '<span class="pre">+</span>';
  for (const ch of num) {
    if (ch === ',') { html += '<span class="comma">,</span>'; continue; }
    const strip = [...'0123456789'.repeat(3)].map((d) => `<span>${d}</span>`).join(''); // 0..29
    html += `<span class="dcell"><span class="dstrip">${strip}</span></span>`;
    digits.push(ch);
  }
  html += '<span class="suf"> 골드</span>';
  el.innerHTML = html;
  const strips = Array.from(el.querySelectorAll('.dstrip')) as HTMLElement[];
  strips.forEach((s) => { s.style.transform = 'translateY(0)'; });
  // 다음 프레임에 목표로 굴림(CSS transition으로 촤라라)
  requestAnimationFrame(() => requestAnimationFrame(() => {
    strips.forEach((s, i) => {
      const d = parseInt(digits[i], 10);
      s.style.transitionDelay = `${i * 70}ms`;
      s.style.transform = `translateY(-${20 + d}em)`; // 두 바퀴(20) + 최종 숫자
    });
  }));
  const totalMs = strips.length * 70 + 1150;
  setTimeout(() => { el.classList.remove('landed'); void el.offsetWidth; el.classList.add('landed'); }, totalMs);
}

// 폭죽·컨페티 축하 연출 — 높은 족보(플러시 이상)나 큰 금액 승리 때.
const CONFETTI_COLORS = ['#f5c542', '#ff6b6b', '#6fb1ff', '#5fd58c', '#ffffff', '#b13ad2'];
function firework(x: number, y: number): void {
  for (let i = 0; i < 24; i++) {
    const p = document.createElement('div');
    p.className = 'spark';
    p.style.left = `${x}px`; p.style.top = `${y}px`;
    p.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    document.body.append(p);
    const ang = (i / 24) * Math.PI * 2, dist = 70 + Math.random() * 80;
    const dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist;
    const a = p.animate(
      [
        { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
        { transform: `translate(calc(${dx}px - 50%), calc(${dy + 40}px - 50%)) scale(.4)`, opacity: 0 },
      ],
      { duration: 900 + Math.random() * 400, easing: 'cubic-bezier(.15,.7,.3,1)', fill: 'forwards' },
    );
    a.onfinish = () => p.remove();
  }
}
function celebrate(): void {
  // 위에서 떨어지는 컨페티
  for (let i = 0; i < 90; i++) {
    const p = document.createElement('div');
    p.className = 'confetti';
    p.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    p.style.left = `${5 + Math.random() * 90}vw`;
    document.body.append(p);
    const dx = (Math.random() * 2 - 1) * 140, dy = window.innerHeight + 40, rot = (Math.random() * 2 - 1) * 720;
    const a = p.animate(
      [
        { transform: 'translateY(-30px) rotate(0)', opacity: 1 },
        { transform: `translate(${dx}px, ${dy}px) rotate(${rot}deg)`, opacity: 1, offset: 0.9 },
        { transform: `translate(${dx}px, ${dy + 40}px) rotate(${rot}deg)`, opacity: 0 },
      ],
      { duration: 2000 + Math.random() * 1400, delay: Math.random() * 500, easing: 'cubic-bezier(.2,.6,.4,1)', fill: 'forwards' },
    );
    a.onfinish = () => p.remove();
  }
  // 불꽃 몇 발(시차)
  const W = window.innerWidth, H = window.innerHeight;
  [[0.25, 0.3], [0.7, 0.25], [0.5, 0.45], [0.85, 0.5]].forEach(([fx, fy], i) =>
    setTimeout(() => { firework(W * fx, H * fy); sfx.chip(); }, 200 + i * 320));
  sfx.win();
}

// ── 결과 ────────────────────────────────────────────────────────────────────
function showResult(v: View): void {
  const r = v.result!;
  const winHand = r.hands[r.winner];
  const won = r.winner === v.mySeat;
  $('winCat').textContent = winHand ? winHand.catLabel : (r.bySurrender ? '전원 다이' : '승리');
  const wc = $('winCards');
  wc.innerHTML = '';
  if (winHand) {
    for (const c of winHand.cards) {
      const el = cardEl(c);
      if (winHand.bestIds.includes(c.id)) el.classList.add('best');
      wc.append(el);
    }
  }
  flipNumber($('winPay'), r.payout); // 0 → 먹은 금액, 현황판식 자릿수 롤링
  // 내가 높은 족보(플러시 이상)나 큰 금액으로 이기면 폭죽 축하
  if (won) {
    const cat = winHand ? evalBest(winHand.cards).cat : 0;
    if (cat >= CAT.FLUSH || r.payout >= v.baseBet * 30) celebrate();
  }
  $('winSub').textContent = `${won ? '🏆 내 승리' : v.seats[r.winner].name + ' 승리'}` + (r.bySurrender ? ' · 전원 다이' : '');
  const rows = $('resultRows');
  rows.innerHTML = '';
  v.seats.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'rrow';
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = (i === r.winner ? '🏆 ' : '') + s.name;
    row.append(nm);
    const h = r.hands[i];
    if (h) {
      const cards = document.createElement('div');
      cards.className = 'cards';
      for (const c of h.cards) {
        const el = cardEl(c, true);
        if (h.bestIds.includes(c.id)) el.classList.add('best');
        cards.append(el);
      }
      row.append(cards);
      const cat = document.createElement('div');
      cat.className = 'cat';
      cat.textContent = h.catLabel;
      row.append(cat);
    } else {
      const cat = document.createElement('div');
      cat.className = 'cat';
      cat.textContent = s.folded ? '다이' : '패 비공개';
      row.append(cat);
    }
    rows.append(row);
  });
  $('overlay').classList.add('show');
}

// ── 입력 전송 (솔로/멀티 분기) ───────────────────────────────────────────────
function sendChoose(discardId: number, openId: number): void {
  // 버리는 연출용: 상태가 바뀌기 전에 버릴 카드 위치·카드 캡처
  const dEl = (document.querySelector('#myCards .card.selDiscard')
    ?? document.querySelector(`#myCards .card[data-id="${discardId}"]`)) as HTMLElement | null; // 오토는 selDiscard 없음 → id로
  const dRect = dEl?.getBoundingClientRect();
  const dCard = lastView?.myCards.find((c) => c.id === discardId) ?? null;
  if (mode === 'solo' && solo) {
    try { solo.game.choose(0, discardId, openId); } catch (e) { toast((e as Error).message); return; }
    renderSolo();
    if (dRect && dCard) discardFly(dRect, dCard, openId);
    soloStep();
  } else if (mode === 'multi' && net) {
    net.send('choose', { discardId, openId });
    if (dRect && dCard) discardFly(dRect, dCard, openId); // 공개 카드 팝은 서버 응답 후라 못 잡을 수 있음(무시됨)
  }
}

function sendBet(action: BetAction): void {
  if (mode === 'solo' && solo) {
    try { solo.game.act(0, action); } catch (e) { toast((e as Error).message); return; }
    renderSolo();
    soloStep();
  } else if (mode === 'multi' && net) {
    net.send('bet', { action });
  }
}

function rematch(): void {
  if (mode === 'solo') startSolo();
  else if (mode === 'multi' && net) net.send('rematch');
}

// ── 솔로 모드 (로컬 엔진 + AI 3명) ───────────────────────────────────────────
function startSolo(): void {
  mode = 'solo';
  const chips = solo?.chips ?? Array.from({ length: 4 }, () => START_CHIPS);
  for (let i = 0; i < 4; i++) if (chips[i] < BASE_BET * 2) chips[i] = START_CHIPS; // 빈털터리 재충전
  solo = { game: new SevenPokerGame(4, chips), chips };
  renderSolo();
  soloStep();
}

function renderSolo(): void {
  if (!solo) return;
  const names = [...SOLO_NAMES];
  if (myName()) names[0] = myName();
  render({ ...buildView(solo.game, 0, names), turnRemainMs: null });
}

// AI 자동 진행 — 한 번에 한 액션씩, 연출 간격을 두고
function soloStep(): void {
  if (soloTimer) { clearTimeout(soloTimer); soloTimer = null; }
  if (!solo) return;
  const g = solo.game;
  if (g.phase === 'ended') { solo.chips = g.players.map((p) => p.chips); return; }
  const aiPending = g.phase === 'choose'
    ? [1, 2, 3].some((s) => !g.players[s].chosen)
    : g.current !== 0;
  if (!aiPending) return;
  // 카드 분배 연출이 진행 중이면 끝날 때까지 기다렸다 진행
  const wait = Math.max(700, dealAnimUntil - performance.now());
  soloTimer = setTimeout(() => {
    if (!solo) return;
    const g2 = solo.game;
    try {
      if (g2.phase === 'choose') {
        for (const s of [1, 2, 3]) {
          if (!g2.players[s].chosen) { const m = aiChoose(g2, s); g2.choose(s, m.discardId, m.openId); }
        }
      } else if (g2.phase === 'betting' && g2.current !== 0) {
        g2.act(g2.current, aiAct(g2, g2.current));
      }
    } catch (e) { console.error('솔로 AI 진행 오류:', e); return; }
    renderSolo();
    soloStep();
  }, wait);
}

// ── 멀티 모드 ────────────────────────────────────────────────────────────────
async function startMulti(): Promise<void> {
  show('waiting');
  $('waitInfo').textContent = '서버 접속 중…';
  try {
    net = await connectGame({
      onState: (v) => { if (mode === 'multi') render(v); },
      onWaiting: (w) => {
        if (mode === 'multi' && (!lastView || lastView.phase === 'ended')) {
          show('waiting');
          $('waitInfo').textContent = `${w.count}/${w.max}명 — ${w.names.join(', ')}`;
        }
      },
      onError: (m) => toast(m),
      onLeave: () => { if (mode === 'multi') { toast('연결이 끊어졌습니다'); backToLobby(); } },
      onJoined: (n) => toast(`${n} 입장`),
    }, 3500, myName());
    mode = 'multi';
    $('waitInfo').textContent = '상대를 기다리는 중…';
  } catch {
    net = null;
    toast('서버에 연결할 수 없습니다 — 혼자 연습을 이용하세요');
    show('lobby');
  }
}

// ── 이벤트 연결 ──────────────────────────────────────────────────────────────
// 첫 탭에서 오디오 잠금 해제 + 모든 버튼에 클릭음
document.addEventListener('pointerdown', () => unlock(), { once: false });
document.addEventListener('click', (e) => {
  if ((e.target as HTMLElement)?.closest('.btn')) sfx.click();
}, true);

$('btnSolo').onclick = () => { unlock(); solo = null; startSolo(); };
$('btnMulti').onclick = () => {
  unlock();
  if (DEMO) { toast('데모에서는 혼자 연습만 가능합니다 (온라인 대전은 서버 필요)'); return; }
  void startMulti();
};
if (DEMO) {
  const mb = $('btnMulti') as HTMLButtonElement;
  mb.textContent = '온라인 대전 (데모 불가)';
  mb.style.opacity = '0.5';
}
$('btnFillAi').onclick = () => { net?.send('fillAi'); };
$('btnWaitLeave').onclick = () => backToLobby();
$('btnRematch').onclick = () => rematch();
$('btnExit').onclick = () => backToLobby();

// 음소거 토글
const soundBtn = $('soundToggle');
soundBtn.textContent = localStorage.getItem('sp_sound') === 'off' ? '🔇' : '🔊';
if (localStorage.getItem('sp_sound') === 'off') setSoundEnabled(false);
soundBtn.onclick = () => {
  const on = !isSoundEnabled();
  setSoundEnabled(on);
  unlock();
  soundBtn.textContent = on ? '🔊' : '🔇';
  localStorage.setItem('sp_sound', on ? 'on' : 'off');
};

// 볼륨 조절 패널(⚙️) — 배경음/효과음 슬라이더
const cfgBtn = $('cfgToggle');
const panel = $('audioPanel');
const volMusic = $('volMusic') as HTMLInputElement;
const volSfx = $('volSfx') as HTMLInputElement;
volMusic.value = String(Math.round(getMusicVolume() * 100));
volSfx.value = String(Math.round(getSfxVolume() * 100));
cfgBtn.onclick = () => { unlock(); panel.classList.toggle('show'); };
volMusic.oninput = () => setMusicVolume(Number(volMusic.value) / 100);
volSfx.oninput = () => { setSfxVolume(Number(volSfx.value) / 100); sfx.chip(); }; // 미리듣기

// 오토(자동 진행) 토글
const autoBtn = $('autoToggle');
autoBtn.onclick = () => {
  auto = !auto;
  autoBtn.classList.toggle('on', auto);
  autoBtn.textContent = auto ? '오토 ON' : '오토 OFF';
  if (auto && lastView) scheduleAuto(lastView); // 켜는 즉시 내 차례면 진행
};

const nameInput = $('nameInput') as HTMLInputElement;
nameInput.value = localStorage.getItem('sp_name') ?? '';
nameInput.onchange = () => localStorage.setItem('sp_name', myName());

// 로비 접속 인원 표시 (5초 폴링)
async function pollOnline(): Promise<void> {
  if (mode === 'lobby') {
    const n = await fetchOnlineCount();
    $('onlineCount').textContent = n != null ? `현재 ${n}명 접속 중` : '';
  }
  setTimeout(() => { void pollOnline(); }, 5000);
}
void pollOnline();
