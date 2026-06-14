// 멀티플레이 네트워크 — 서버(Colyseus) 접속 래퍼.
// 접속 실패/타임아웃이면 호출부가 알림 후 로비로 되돌린다.
import { Client, Room } from '@colyseus/sdk';
import type { GameView } from '../engine/view';

export type NetMsg = 'choose' | 'bet' | 'rematch' | 'fillAi';

export interface NetHandle {
  send(type: NetMsg, payload?: unknown): void;
  leave(): void;
}

export type NetState = GameView & { turnRemainMs: number | null };

// 서버 주소:
//  1) 빌드 시 VITE_POKER_SERVER 지정 시 그걸 사용
//  2) localhost 개발 → ws://localhost:2567 (별도 서버)
//  3) 배포(같은 앱이 클라+WS 서빙) → 같은 오리진
function endpoint(): string {
  const env = (import.meta.env.VITE_POKER_SERVER as string | undefined) || '';
  if (env) return env;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1') return `${proto}://${host}:2567`;
  return `${proto}://${location.host}`;
}

// 현재 접속 인원 — 서버 /online 폴링. 실패 시 null.
export async function fetchOnlineCount(): Promise<number | null> {
  if (typeof __DEMO__ !== 'undefined' && __DEMO__) return null; // 데모: 서버 없음 — 폴링 안 함
  try {
    const base = endpoint().replace(/^ws/, 'http');
    const r = await fetch(base + '/online', { cache: 'no-store' });
    const j = await r.json();
    return typeof j.count === 'number' ? j.count : null;
  } catch { return null; }
}

export interface NetCallbacks {
  onState: (v: NetState) => void;
  onWaiting: (w: { count: number; max: number; names: string[] }) => void;
  onError: (msg: string) => void;
  onLeave: () => void;
  onJoined?: (name: string) => void;
}

// 게임 방 접속. timeoutMs 안에 못 붙으면 throw.
// code 를 주면 같은 코드끼리만 매칭(친구 초대 방).
export async function connectGame(cb: NetCallbacks, timeoutMs = 3500, name = '', code = ''): Promise<NetHandle> {
  const client = new Client(endpoint());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const join = client.joinOrCreate('sevenpoker', code ? { name, code } : { name });
  void join.then((lateRoom) => {
    if (expired) void lateRoom.leave().catch(() => undefined);
  }).catch(() => undefined);
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new Error('서버 접속 시간 초과'));
    }, timeoutMs);
  });
  let room: Room;
  try {
    room = await Promise.race([join, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  room.onMessage('state', (v: NetState) => cb.onState(v));
  room.onMessage('waiting', (w: { count: number; max: number; names: string[] }) => cb.onWaiting(w));
  room.onMessage('error', (e: { message?: string }) => cb.onError(e?.message ?? '오류'));
  room.onMessage('joined', (m: { name?: string }) => cb.onJoined?.(m?.name ?? ''));
  room.onLeave(() => cb.onLeave());
  return {
    send: (type, payload) => room.send(type, payload),
    leave: () => { try { room.leave(); } catch { /* 무시 */ } },
  };
}
