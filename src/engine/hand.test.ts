// 족보 평가 테스트 — 실행: npx tsx src/engine/hand.test.ts
import assert from 'node:assert/strict';
import { card } from './cards';
import { eval5, evalBest, evalOpen, compareValue, CAT, catName } from './hand';

let passed = 0;
function test(name: string, fn: () => void): void {
  try { fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { console.error(`❌ ${name}`); console.error(e); process.exitCode = 1; }
}

const h = (specs: string) => specs.split(' ').map(card);
const v5 = (specs: string) => eval5(h(specs));

test('족보 판정 — 13개 등급 전부', () => {
  assert.equal(v5('s10 sJ sQ sK sA').cat, CAT.ROYAL_STRAIGHT_FLUSH);
  assert.equal(v5('sA s2 s3 s4 s5').cat, CAT.BACK_STRAIGHT_FLUSH);
  assert.equal(v5('s5 s6 s7 s8 s9').cat, CAT.STRAIGHT_FLUSH);
  assert.equal(v5('sA dA hA cA s9').cat, CAT.FOUR);
  assert.equal(v5('sK dK hK s2 d2').cat, CAT.FULL_HOUSE);
  assert.equal(v5('s2 s5 s9 sJ sK').cat, CAT.FLUSH);
  assert.equal(v5('s10 dJ hQ cK sA').cat, CAT.MOUNTAIN);
  assert.equal(v5('sA d2 h3 c4 s5').cat, CAT.BACK_STRAIGHT);
  assert.equal(v5('s4 d5 h6 c7 s8').cat, CAT.STRAIGHT);
  assert.equal(v5('sQ dQ hQ s2 d7').cat, CAT.TRIPLE);
  assert.equal(v5('sQ dQ h7 c7 s2').cat, CAT.TWO_PAIR);
  assert.equal(v5('sQ dQ h7 c4 s2').cat, CAT.PAIR);
  assert.equal(v5('sQ d9 h7 c4 s2').cat, CAT.HIGH);
});

test('등급 순서 — 위가 아래를 전부 이김', () => {
  const chain = [
    's10 sJ sQ sK sA', // 로열
    'hA h2 h3 h4 h5', // 백SF
    's5 s6 s7 s8 s9', // SF
    'sA dA hA cA s9', // 포카드
    'sK dK hK s2 d2', // 풀하우스
    's2 s5 s9 sJ sK', // 플러시
    'd10 dJ hQ cK hA', // 마운틴
    'dA d2 h3 c4 c5', // 백스트레이트
    's4 d5 h6 c7 c8', // 스트레이트
    'sQ dQ hQ s2 d7', // 트리플
    'sJ dJ h7 c7 s2', // 투페어
    'sJ dJ h7 c4 s2', // 원페어
    'sQ d9 h7 c4 s2', // 탑
  ];
  for (let i = 0; i + 1 < chain.length; i++) {
    const a = v5(chain[i]); const b = v5(chain[i + 1]);
    assert.ok(compareValue(a, b) > 0, `${catName(a.cat)} > ${catName(b.cat)} 실패`);
  }
});

test('한국식: 마운틴 > 백스트레이트 > 일반 스트레이트', () => {
  const mountain = v5('d10 dJ hQ cK hA');
  const back = v5('dA d2 h3 c4 c5');
  const straight = v5('d9 d10 hJ cQ cK'); // K높은 일반 스트레이트
  assert.ok(compareValue(mountain, back) > 0);
  assert.ok(compareValue(back, straight) > 0);
});

test('같은 등급 — 숫자 비교', () => {
  assert.ok(compareValue(v5('s4 d5 h6 c7 c8'), v5('s3 d4 h5 c6 c7')) > 0); // 8높은 > 7높은
  assert.ok(compareValue(v5('sK dK h7 c4 s2'), v5('sQ dQ hA cK s9')) > 0); // K페어 > Q페어
  assert.ok(compareValue(v5('sQ dQ h9 c4 s2'), v5('hQ cQ h7 c4 s2')) > 0); // 같은 페어 → 킥커
});

test('숫자까지 같으면 무늬로 가림 (무승부 없음)', () => {
  const a = v5('sQ dQ h9 c5 d3'); // 페어 무늬 ♠◆
  const b = v5('hQ cQ s9 d5 h3'); // 페어 무늬 ♥♣
  assert.ok(compareValue(a, b) > 0);
  assert.ok(compareValue(b, a) < 0);
});

test('A 포함 같은 무늬 5장이 연속 아니면 그냥 플러시', () => {
  assert.equal(v5('sA s2 s3 s4 s6').cat, CAT.FLUSH);
});

test('evalBest — 7장 중 최고 5장 선택', () => {
  // A페어 + 스페이드 플러시 → 플러시 선택
  const v = evalBest(h('sA dA s3 s7 s9 sJ h2'));
  assert.equal(v.cat, CAT.FLUSH);
  // 트리플 + 페어 흩어진 7장 → 풀하우스 조합
  const v2 = evalBest(h('sK dK hK s4 d4 h9 c2'));
  assert.equal(v2.cat, CAT.FULL_HOUSE);
});

test('evalOpen — 공개 카드 보스 비교', () => {
  assert.ok(compareValue(evalOpen(h('s8 h8')), evalOpen(h('sA dK'))) > 0); // 페어 > 하이카드
  assert.ok(compareValue(evalOpen(h('s8')), evalOpen(h('h8'))) > 0); // 같은 숫자 → ♠ > ♥
  assert.ok(compareValue(evalOpen(h('sA d8 c2')), evalOpen(h('hK dQ cJ'))) > 0); // A하이 > K하이
});

console.log(`\n족보 테스트 ${passed}개 통과`);
