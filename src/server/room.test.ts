// 서버 통합 테스트 — 사람 2명 + AI 2명으로 한 판 완주.
// 실행: AI_STEP_MS=50 npx tsx src/server/room.test.ts
import assert from 'node:assert';
import { boot, ColyseusTestServer } from '@colyseus/testing';
import appConfig from './app.config';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const colyseus: ColyseusTestServer = await boot(appConfig);
  console.log('서버 통합 테스트');
  try {
    const room = await colyseus.createRoom('sevenpoker', {});

    const states: Record<number, any> = {};
    const errors: string[] = [];
    const c1 = await colyseus.connectTo(room, { name: '갑' });
    c1.onMessage('state', (s: any) => (states[0] = s));
    c1.onMessage('error', (e: any) => errors.push(`c1:${e?.message}`));
    c1.onMessage('waiting', () => undefined);
    c1.onMessage('joined', () => undefined);
    const c2 = await colyseus.connectTo(room, { name: '을' });
    c2.onMessage('state', (s: any) => (states[1] = s));
    c2.onMessage('error', (e: any) => errors.push(`c2:${e?.message}`));
    c2.onMessage('waiting', () => undefined);
    c2.onMessage('joined', () => undefined);
    const clients = [c1, c2];
    await sleep(150);

    // 2명만으로는 시작 안 됨 → AI 채우고 시작
    assert.ok(!states[0], '시작 전에는 게임 상태 없음');
    c1.send('fillAi');
    await sleep(200);
    assert.ok(states[0] && states[1], '두 클라 모두 상태 수신');
    assert.equal(states[0].phase, 'choose');
    assert.equal(states[0].myCards.length, 4);
    assert.equal(states[0].seats.length, 4);
    console.log('  ✓ 사람 2 + AI 2 → 게임 시작, 각자 4장');

    // 상대 비공개 카드 내용이 전송되지 않는지
    assert.ok(!('cards' in states[0].seats[1]), '상대 카드 내용은 전송 안 됨');
    assert.equal(states[0].seats[1].hiddenCount, 4);
    console.log('  ✓ 상대 카드 숨김 (조작 방지 핵심)');

    // 잘못된 선택 거부
    c1.send('choose', { discardId: states[0].myCards[0].id, openId: states[0].myCards[0].id });
    await sleep(150);
    assert.ok(errors.some((e) => e.startsWith('c1:')), '버림=공개 같은 카드 거부');
    console.log('  ✓ 잘못된 선택 거부 (서버 권위)');

    // 두 사람 모두 정상 선택 (AI 는 자동) → 베팅 시작
    for (const i of [0, 1]) {
      const my = states[i].myCards;
      clients[i].send('choose', { discardId: my[0].id, openId: my[1].id });
    }
    await sleep(600); // AI 선택 대기
    assert.equal(states[0].phase, 'betting');
    assert.equal(states[0].street, 1);
    assert.equal(states[0].myCards.length, 3);
    console.log('  ✓ 전원 선택 → 1차 베팅 시작');

    // 콜/체크만으로 한 판 완주 (AI 가 다이/베팅해도 콜·체크로 따라감)
    let guard = 300;
    while (states[0].phase !== 'ended' && guard-- > 0) {
      for (const i of [0, 1]) {
        const v = states[i];
        if (v.phase === 'betting' && v.current === v.mySeat && v.actions.length > 0) {
          const action = v.actions.includes('check') ? 'check' : v.actions.includes('call') ? 'call' : 'die';
          clients[i].send('bet', { action });
        }
      }
      await sleep(80);
    }
    assert.equal(states[0].phase, 'ended', '한 판이 끝까지 진행됨');
    assert.ok(states[0].result, '결과 수신');
    const total = states[0].seats.reduce((s: number, x: any) => s + x.chips, 0);
    assert.equal(total, 400000, '칩 총합 보존');
    console.log('  ✓ 한 판 완주 → 결과·정산 (칩 총합 보존)');

    // 한판 더
    c1.send('rematch');
    await sleep(200);
    assert.ok(states[0].phase === 'choose', '재대국 시작');
    console.log('  ✓ 한판 더');

    await colyseus.shutdown();
    console.log('\n서버 통합 테스트 통과 ✅');
  } catch (e) {
    await colyseus.shutdown();
    throw e;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
