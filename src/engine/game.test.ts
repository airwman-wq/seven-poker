// 게임 진행 테스트 — 실행: npx tsx src/engine/game.test.ts
import assert from 'node:assert/strict';
import { card } from './cards';
import { SevenPokerGame, BASE_BET, aiChoose, aiAct } from './game';
import { buildView } from './view';

let passed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { console.error(`❌ ${name}`); console.error(e); process.exitCode = 1; }
}

const c = (s: string) => card(s);

// 2인 대본 게임: 0번은 A페어→트리플(A), 1번은 K페어. 0번이 계속 보스.
// 추가 분배 순서(스트리트마다 0번→1번): s9 d8 / c2 c6 / dA hQ / h3 dJ
function scripted(chips?: number[]): SevenPokerGame {
  const g = new SevenPokerGame(2, chips);
  g.players[0].cards = ['sA', 'hA', 'd5', 'c9'].map(c);
  g.players[1].cards = ['sK', 'hK', 'c4', 'd3'].map(c);
  g.deck = ['dJ', 'h3', 'hQ', 'dA', 'c6', 'c2', 'd8', 's9'].map(c); // pop은 뒤에서부터
  return g;
}
function chooseBoth(g: SevenPokerGame): void {
  g.choose(0, c('c9').id, c('d5').id);
  g.choose(1, c('d3').id, c('c4').id);
}

test('시작: 앤티·4장 분배·choose 단계', () => {
  const g = new SevenPokerGame(2);
  assert.equal(g.phase, 'choose');
  assert.equal(g.pot, BASE_BET * 2);
  for (const p of g.players) {
    assert.equal(p.cards.length, 4);
    assert.equal(p.chips, 100000 - BASE_BET);
  }
});

test('choose 검증: 같은 카드/남의 카드/중복 선택 거부', () => {
  const g = scripted();
  assert.throws(() => g.choose(0, c('sA').id, c('sA').id)); // 버림=공개 같음
  assert.throws(() => g.choose(0, c('sK').id, c('sA').id)); // 내 카드 아님
  g.choose(0, c('c9').id, c('d5').id);
  assert.throws(() => g.choose(0, c('hA').id, c('sA').id)); // 이미 선택함
  assert.equal(g.phase, 'choose'); // 1번이 아직
});

test('전원 선택 → 1차 베팅, 공개 카드 높은 쪽이 보스', () => {
  const g = scripted();
  chooseBoth(g);
  assert.equal(g.phase, 'betting');
  assert.equal(g.street, 1);
  assert.equal(g.boss, 0); // d5 > c4
  assert.equal(g.current, 0);
  assert.equal(g.players[0].cards.length, 3);
  assert.deepEqual(g.availableActions(0), ['check', 'bbing', 'half', 'die']);
});

test('차례 아닌 좌석·불가 액션 거부', () => {
  const g = scripted();
  chooseBoth(g);
  assert.throws(() => g.act(1, 'check')); // 차례 아님
  assert.throws(() => g.act(0, 'call')); // 콜할 베팅이 없음
  assert.throws(() => g.act(0, 'ddadang')); // 앞 베팅 없으면 따당 불가
});

test('삥→콜로 라운드 종료, 다음 카드 공개 분배', () => {
  const g = scripted();
  chooseBoth(g);
  g.act(0, 'bbing');
  assert.equal(g.currentBet, BASE_BET);
  assert.deepEqual(g.availableActions(1), ['call', 'ddadang', 'half', 'die']);
  g.act(1, 'call');
  assert.equal(g.street, 2);
  assert.equal(g.pot, 4000); // 앤티 2000 + 삥·콜 2000
  assert.equal(g.players[0].cards.length, 4);
  assert.equal(g.players[0].openIds.length, 2); // d5 + s9
  assert.ok(g.players[0].openIds.includes(c('s9').id));
});

test('따당: 직전 베팅의 2배', () => {
  const g = scripted();
  chooseBoth(g);
  g.act(0, 'bbing'); // 1000
  g.act(1, 'ddadang'); // 2000으로
  assert.equal(g.currentBet, 2000);
  assert.equal(g.toCall(0), 1000); // 0번은 1000 더 내야 함
  assert.equal(g.players[1].chips, 100000 - 1000 - 2000); // 앤티 + 따당
});

test('다이 → 남은 한 명이 즉시 판돈 가져감 (패 비공개)', () => {
  const g = scripted();
  chooseBoth(g);
  g.act(0, 'bbing');
  g.act(1, 'die');
  assert.equal(g.phase, 'ended');
  assert.ok(g.result);
  assert.equal(g.result!.winner, 0);
  assert.equal(g.result!.bySurrender, true);
  assert.equal(g.result!.payout, 3000);
  assert.ok(g.result!.hands.every((h) => h === null));
  assert.equal(g.players[0].chips, 100000 - 1000 - 1000 + 3000); // 앤티+삥 내고 3000 회수
});

test('5라운드 완주 → 쇼다운: 트리플 A가 K페어 이김, 판돈 정산', () => {
  const g = scripted();
  chooseBoth(g);
  g.act(0, 'bbing'); g.act(1, 'call'); // 1차: 판돈 4000
  g.act(0, 'check'); g.act(1, 'check'); // 2차
  g.act(0, 'check'); g.act(1, 'bbing'); g.act(0, 'call'); // 3차: 판돈 6000
  assert.equal(g.street, 4);
  g.act(0, 'half'); // 판돈 6000의 절반 = 3000 레이즈 → 판돈 9000
  assert.equal(g.currentBet, 3000);
  g.act(1, 'call'); // 판돈 12000
  assert.equal(g.street, 5);
  assert.equal(g.players[0].cards.length, 7);
  assert.equal(g.players[0].openIds.length, 4); // 마지막 카드는 비공개
  g.act(0, 'check'); g.act(1, 'check'); // 5차(마지막)
  assert.equal(g.phase, 'ended');
  const r = g.result!;
  assert.equal(r.winner, 0);
  assert.equal(r.bySurrender, false);
  assert.equal(r.payout, 12000);
  assert.equal(r.hands[0]!.value.cards.filter((x) => x.rank === 14).length, 3); // 트리플 A 사용
  assert.equal(g.players[0].chips, 106000);
  assert.equal(g.players[1].chips, 94000);
});

test('칩 부족 콜 = 올인, 이후 베팅 생략하고 끝까지 분배 후 쇼다운', () => {
  const g = scripted([100000, 1500]);
  chooseBoth(g);
  g.act(0, 'bbing');
  g.act(1, 'call'); // 남은 500만 냄 → 올인
  assert.equal(g.players[1].allIn, true);
  assert.equal(g.phase, 'ended'); // 베팅 가능 인원 1명 → 끝까지 자동 진행
  assert.equal(g.players[0].cards.length, 7);
  assert.equal(g.players[1].cards.length, 7);
  const r = g.result!;
  assert.equal(r.winner, 0); // 트리플 A
  assert.equal(r.payout, 3500); // 앤티 2000 + 삥 1000 + 올인 500
  assert.equal(g.players[0].chips, 100000 - 2000 + 3500);
  assert.equal(g.players[1].chips, 0);
});

test('뷰: 상대 비공개 카드는 장수만 보임', () => {
  const g = scripted();
  chooseBoth(g);
  const v = buildView(g, 1, ['나', '상대']);
  assert.equal(v.mySeat, 1);
  assert.equal(v.myCards.length, 3);
  assert.equal(v.seats[0].hiddenCount, 2);
  assert.equal(v.seats[0].openCards.length, 1);
  assert.equal(v.seats[0].openCards[0].id, c('d5').id);
  // 직렬화해도 상대 비공개 카드 정보가 없는지
  assert.ok(!JSON.stringify(v.seats[0]).includes(`"id":${c('sA').id},`));
});

test('AI: 선택과 베팅이 끝까지 진행됨 (4인 무작위 1판)', () => {
  for (let trial = 0; trial < 50; trial++) {
    const g = new SevenPokerGame(4);
    for (let i = 0; i < 4; i++) {
      const { discardId, openId } = aiChoose(g, i);
      g.choose(i, discardId, openId);
    }
    let guard = 200;
    while (g.phase === 'betting' && guard-- > 0) {
      g.act(g.current, aiAct(g, g.current));
    }
    assert.equal(g.phase, 'ended', 'AI 게임이 끝나지 않음');
    // 칩 보존: 총합 = 4 * 100000
    const total = g.players.reduce((s, p) => s + p.chips, 0);
    assert.equal(total, 400000);
  }
});

console.log(`\n게임 테스트 ${passed}개 통과`);
