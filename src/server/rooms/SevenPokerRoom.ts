// 7포커 방 — 서버 권위. 엔진을 여기서 실행하고 각 액션을 검증한다.
// 4인석: 사람 + AI 채움. 게임 중 사람이 나가면 그 좌석은 AI가 이어 두고,
// 새 사람이 들어오면 AI 좌석을 인수한다 (gostop 방과 같은 패턴).

import { Room, Client } from 'colyseus';
import { SevenPokerGame, aiChoose, aiAct, BASE_BET, START_CHIPS, BetAction } from '../../engine/game';
import { buildView } from '../../engine/view';
import { online } from '../online';

const SEATS = 4;
const AI_WAIT_MS = Number(process.env.AI_WAIT_MS ?? 0); // >0 이면 그 시간 뒤 자동 AI 채움. 0=버튼으로만
const AI_STEP_MS = Number(process.env.AI_STEP_MS ?? 900); // AI 액션 사이 간격 (연출 시간)
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS ?? 30000); // 사람 입력 제한시간 (사람 2명 이상일 때만). 0=끔

export class SevenPokerRoom extends Room {
  maxClients = SEATS;
  private game?: SevenPokerGame;
  private seats: string[] = []; // seat index -> sessionId ('AI' = 서버 AI)
  private names: string[] = [];
  private aiSeats = new Set<number>();
  private chips: number[] = Array.from({ length: SEATS }, () => START_CHIPS); // 판 사이에 유지
  private waitTimer?: ReturnType<typeof setTimeout>;
  private aiTimer = false; // AI 자동 진행 예약 여부
  private turnTimer?: { clear(): void };
  private turnDeadline: number | null = null;
  private turnWaitKey = '';

  onCreate(): void {
    // 버림 1장 + 공개 1장 선택
    this.onMessage('choose', (client, msg: { discardId: number; openId: number }) => {
      if (!this.game || this.game.phase !== 'choose') return;
      const seat = this.seats.indexOf(client.sessionId);
      if (seat < 0) return;
      try {
        this.game.choose(seat, Number(msg?.discardId), Number(msg?.openId));
        this.broadcastState();
        this.maybeAuto();
      } catch (e) { client.send('error', { message: (e as Error).message }); }
    });
    // 베팅 액션
    this.onMessage('bet', (client, msg: { action: BetAction }) => {
      if (!this.game || this.game.phase !== 'betting') return;
      const seat = this.seats.indexOf(client.sessionId);
      if (seat < 0) return;
      try {
        this.game.act(seat, msg?.action);
        this.broadcastState();
        this.maybeAuto();
      } catch (e) { client.send('error', { message: (e as Error).message }); }
    });
    // 한판 더
    this.onMessage('rematch', (client) => {
      if (!this.game || this.game.phase !== 'ended') return;
      if (this.seats.indexOf(client.sessionId) < 0) return;
      this.startGame();
    });
    // 'AI로 채우고 바로 시작' — 대기 중인 사람 누구나
    this.onMessage('fillAi', (client) => {
      if (this.game || this.seats.indexOf(client.sessionId) < 0) return;
      if (this.waitTimer) clearTimeout(this.waitTimer);
      this.fillWithAi();
    });
  }

  onJoin(client: Client, options?: { name?: string }): void {
    online.inc();
    const raw = (options?.name || '').trim().slice(0, 12);
    // AI 좌석이 있으면 사람이 인수 (진행 중이면 그 패·칩 그대로 이어받음)
    const aiSeat = this.seats.findIndex((s, i) => s === 'AI' && this.aiSeats.has(i));
    if (aiSeat >= 0) {
      this.seats[aiSeat] = client.sessionId;
      this.aiSeats.delete(aiSeat);
      this.names[aiSeat] = this.uniqueName(raw || `손님${1000 + ((aiSeat * 7919) % 9000)}`);
      this.broadcast('joined', { name: this.names[aiSeat] }, { except: client });
      if (this.game && this.game.phase === 'ended') this.startGame();
      else this.broadcastState();
      return;
    }
    const seat = this.seats.length;
    this.seats.push(client.sessionId);
    this.names[seat] = this.uniqueName(raw || `손님${1000 + ((seat * 7919) % 9000)}`);
    if (seat > 0) this.broadcast('joined', { name: this.names[seat] }, { except: client });
    if (this.seats.length === SEATS) {
      if (this.waitTimer) clearTimeout(this.waitTimer);
      this.lock(); // 4명 다 사람 — 잠금
      this.startGame();
    } else {
      this.broadcastWaiting();
      if (AI_WAIT_MS > 0) {
        if (this.waitTimer) clearTimeout(this.waitTimer);
        this.waitTimer = setTimeout(() => this.fillWithAi(), AI_WAIT_MS);
      }
    }
  }

  onLeave(client: Client): void {
    online.dec();
    const seat = this.seats.indexOf(client.sessionId);
    if (seat < 0) return;
    if (!this.game) { // 시작 전 — 좌석 정리
      this.seats.splice(seat, 1);
      this.names.splice(seat, 1);
      this.broadcastWaiting();
      return;
    }
    // 진행 중/종료 후 — 그 좌석을 AI 로 전환, 새 사람이 인수할 수 있게 방 개방
    this.seats[seat] = 'AI';
    this.aiSeats.add(seat);
    this.names[seat] = 'AI';
    try { this.unlock(); } catch { /* 무시 */ }
    this.broadcastState();
    this.maybeAuto(); // 그 좌석 차례였으면 AI 가 이어 둠
  }

  // 닉 겹침 방지 — 같은 닉이면 뒤에 숫자
  private uniqueName(nm: string): string {
    if (!this.names.includes(nm)) return nm;
    let i = 2;
    while (this.names.includes(`${nm} ${i}`)) i++;
    return `${nm} ${i}`;
  }

  private fillWithAi(): void {
    if (this.game || this.seats.length === 0) return;
    let n = 1;
    while (this.seats.length < SEATS) {
      const i = this.seats.length;
      this.seats.push('AI');
      this.aiSeats.add(i);
      this.names[i] = this.uniqueName(`AI ${n++}`);
    }
    this.startGame();
  }

  private startGame(): void {
    // 빈털터리는 재충전 (게임머니)
    for (let i = 0; i < SEATS; i++) if (this.chips[i] < BASE_BET * 2) this.chips[i] = START_CHIPS;
    this.game = new SevenPokerGame(SEATS, this.chips);
    this.broadcastState();
    this.maybeAuto();
  }

  // 자동 진행: choose 단계의 AI 선택, AI 차례의 베팅. 판이 끝나면 칩 동기화.
  private maybeAuto(): void {
    const g = this.game;
    if (!g) return;
    if (g.phase === 'ended') { this.chips = g.players.map((p) => p.chips); return; }
    if (this.aiTimer) return;
    const need = g.phase === 'choose'
      ? [...this.aiSeats].some((s) => !g.players[s].chosen)
      : this.aiSeats.has(g.current);
    if (!need) return;
    this.aiTimer = true;
    this.clock.setTimeout(() => {
      this.aiTimer = false;
      const g2 = this.game;
      if (!g2 || g2.phase === 'ended') return;
      try {
        if (g2.phase === 'choose') {
          for (const s of this.aiSeats) {
            if (!g2.players[s].chosen) { const m = aiChoose(g2, s); g2.choose(s, m.discardId, m.openId); }
          }
        } else if (this.aiSeats.has(g2.current)) {
          g2.act(g2.current, aiAct(g2, g2.current));
        }
      } catch (e) { console.error('AI 자동 진행 오류:', e); return; }
      this.broadcastState();
      this.maybeAuto();
    }, AI_STEP_MS);
  }

  // 사람 입력 대기 제한시간 — 사람 2명 이상인 방에서만 (혼자 AI 와 둘 땐 무제한)
  private scheduleTurnTimer(): void {
    const g = this.game;
    const clear = () => {
      this.turnTimer?.clear(); this.turnTimer = undefined;
      this.turnDeadline = null; this.turnWaitKey = '';
    };
    const humans = this.seats.filter((s) => s !== 'AI').length;
    if (TURN_TIMEOUT_MS <= 0 || !g || g.phase === 'ended' || humans < 2) { clear(); return; }
    let key = '';
    if (g.phase === 'choose') {
      if (g.players.some((p, i) => !p.chosen && !this.aiSeats.has(i))) key = `choose`;
    } else if (!this.aiSeats.has(g.current)) {
      key = `bet:${g.street}:${g.current}:${g.currentBet}`;
    }
    if (!key) { clear(); return; }
    if (key === this.turnWaitKey && this.turnTimer) return; // 같은 대기 상태 — 데드라인 유지
    this.turnTimer?.clear();
    this.turnWaitKey = key;
    this.turnDeadline = Date.now() + TURN_TIMEOUT_MS;
    this.turnTimer = this.clock.setTimeout(() => this.onTurnTimeout(key), TURN_TIMEOUT_MS);
  }

  // 시간 초과 — 선택은 자동 선택, 베팅은 체크 가능하면 체크·아니면 다이
  private onTurnTimeout(key: string): void {
    const g = this.game;
    if (!g || key !== this.turnWaitKey) return;
    this.turnTimer = undefined; this.turnDeadline = null; this.turnWaitKey = '';
    try {
      if (g.phase === 'choose') {
        for (let i = 0; i < g.players.length; i++) {
          if (!g.players[i].chosen) { const m = aiChoose(g, i); g.choose(i, m.discardId, m.openId); }
        }
      } else if (g.phase === 'betting') {
        g.act(g.current, g.availableActions(g.current).includes('check') ? 'check' : 'die');
      }
    } catch (e) { console.error('턴 타임아웃 처리 오류:', e); return; }
    this.broadcastState();
    this.maybeAuto();
  }

  private broadcastWaiting(): void {
    this.broadcast('waiting', { count: this.seats.length, max: SEATS, names: [...this.names] });
  }

  private broadcastState(): void {
    if (!this.game) return;
    this.scheduleTurnTimer();
    const turnRemainMs = this.turnDeadline != null ? Math.max(0, this.turnDeadline - Date.now()) : null;
    for (const c of this.clients) {
      const seat = this.seats.indexOf(c.sessionId);
      if (seat < 0) continue;
      c.send('state', { ...buildView(this.game, seat, this.names), turnRemainMs });
    }
  }
}
