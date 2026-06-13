import { defineConfig } from 'vite';

// 로컬/서버 빌드는 루트('/'), GitHub Pages 데모 빌드는 '/seven-poker/' 하위 경로.
// Pages 빌드 시 환경변수 GH_PAGES=1 로 base를 바꾼다.
export default defineConfig({
  base: process.env.GH_PAGES ? '/seven-poker/' : '/',
  // 데모(GitHub Pages) 빌드에선 서버가 없으므로 온라인 대전/접속자 폴링을 끈다.
  define: { __DEMO__: process.env.GH_PAGES ? 'true' : 'false' },
});
