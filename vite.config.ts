import { defineConfig } from 'vite';

// 로컬/서버 빌드는 루트('/'), GitHub Pages 데모 빌드는 '/seven-poker/' 하위 경로.
// Pages 빌드 시 환경변수 GH_PAGES=1 로 base를 바꾼다.
export default defineConfig({
  base: process.env.GH_PAGES ? '/seven-poker/' : '/',
});
