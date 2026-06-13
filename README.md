# 7포커 (Seven Poker)

한국식 7포커 — 모바일 세로 화면. 클라이언트(Vite + TypeScript) + Colyseus 서버 + 공유 엔진(`src/engine`).

## 데모

GitHub Pages 데모: **https://airwman-wq.github.io/seven-poker/**

- 데모에서는 **혼자 연습 (AI 3명)** 모드가 서버 없이 바로 동작합니다.
- **온라인 대전**은 Colyseus 서버가 필요해 데모(정적 호스팅)에서는 동작하지 않습니다.
- 소리(효과음·성우·배경음악)는 브라우저 정책상 화면을 한 번 터치/클릭한 뒤부터 재생됩니다.

## 개발

```bash
npm install
npm run dev:server   # (선택) Colyseus 서버 — 온라인 대전
npx vite             # 클라이언트 개발 서버 (http://localhost:5173)
```

검증:

```bash
npm test             # 족보 + 게임 규칙 테스트
npx tsc --noEmit     # 타입 체크
npx vite build       # 프로덕션 빌드
```

## 규칙

`RULES.md` 참고 — 마운틴/백스트레이트 포함 한국식 족보, 삥/콜/따당/하프/다이, 사이드팟 없음.

## 오디오

효과음·성우(한국어)·배경음악은 ElevenLabs로 생성한 mp3(`public/audio/`)를 우선 재생하고,
못 받으면 WebAudio 합성음으로 대체합니다. 우상단에서 음소거(🔊)와 볼륨(⚙️)을 조절할 수 있습니다.
