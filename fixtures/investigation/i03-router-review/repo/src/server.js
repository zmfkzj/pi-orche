import { createServer } from 'node:http';
import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 3000);
const app = createApp();
const server = createServer(app.handler);
server.listen(port, () => {
  console.log('minihttp listening on', server.address().port);
});
