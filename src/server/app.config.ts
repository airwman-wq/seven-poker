// Colyseus 앱 설정 — 방 정의 + 헬스체크 + 정적 클라(dist) 서빙(배포 시 한 앱으로).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import config from '@colyseus/tools';
import { SevenPokerRoom } from './rooms/SevenPokerRoom';
import { online } from './online';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../../dist'); // 빌드된 클라

export default config({
  initializeGameServer: (gameServer) => {
    // filterBy('code') — 같은 방 코드끼리만 매칭(친구 초대). 코드 없으면 일반 자동 매칭끼리.
    gameServer.define('sevenpoker', SevenPokerRoom).filterBy(['code']);
  },
  initializeExpress: (app) => {
    app.get('/health', (_req, res) => { res.send('ok'); });
    // 현재 접속 인원 — 로비에서 폴링해 표시.
    app.get('/online', (_req, res) => { res.header('Access-Control-Allow-Origin', '*'); res.json({ count: online.get() }); });
    // 배포: 같은 앱이 빌드된 클라(dist)도 서빙. 없으면(개발) 조용히 무시.
    app.use(express.static(DIST));
    app.get(/^(?!\/(matchmake|health)).*/, (_req, res) => {
      res.sendFile(path.join(DIST, 'index.html'), (err?: Error) => { if (err) res.status(404).end(); });
    });
  },
});
