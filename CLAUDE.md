# CLAUDE.md

## 프로젝트 메모 (seven-poker)

- 한국식 7포커. 클라(Vite TS) + Colyseus 서버 + 공유 엔진(`src/engine`). 클라·서버가 같은 엔진/뷰를 씀. gostop 프로젝트와 같은 구조.
- 규칙 기준: `RULES.md` (마운틴/백스트레이트 포함 한국식 족보, 삥/콜/따당/하프/다이, 사이드팟 없음).
- 검증 명령: `npm test`(족보+게임) · `npx tsc --noEmit` · `npx vite build` · 서버 실행 `npm run server`(포트 2567).
- 서버 권위: 클라는 화면·입력만. 모든 판정은 서버(또는 솔로 모드의 로컬 엔진)에서.
- 답변은 한국어, 평범한 단어로(비유 금지) — 사용자 전역 규칙.
