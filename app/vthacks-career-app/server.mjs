import { createServer } from 'node:http';
import next from 'next';

const hostname = '0.0.0.0';
const port = Number(process.env.DATABRICKS_APP_PORT ?? process.env.PORT ?? 8000);
const app = next({ dev: false, hostname, port });
const handle = app.getRequestHandler();
await app.prepare();
createServer((req, res) => handle(req, res)).listen(port, hostname, () => {
  console.log(`Application listening on http://${hostname}:${port}`);
});
