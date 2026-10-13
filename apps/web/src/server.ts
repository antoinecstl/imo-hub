import { createPool } from '@imo/db';
import { buildApp } from './app.ts';

const db = createPool();
const app = buildApp(db);
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    await db.end();
    process.exit(0);
  });
}
