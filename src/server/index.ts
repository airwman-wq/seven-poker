// 서버 진입점.  실행: npm run server
import { listen } from '@colyseus/tools';
import app from './app.config';

listen(app);
