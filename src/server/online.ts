// 전역 접속 인원 카운터 — 단일 프로세스 내 모든 방이 공유. onJoin/onLeave 에서 증감.
let count = 0;
export const online = {
  inc(): void { count += 1; },
  dec(): void { count = Math.max(0, count - 1); },
  get(): number { return count; },
};
