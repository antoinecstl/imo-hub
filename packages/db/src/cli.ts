import { createPool } from './pool.ts';
import { migrate } from './migrate.ts';

const [command] = process.argv.slice(2);
const db = createPool();
try {
  if (command === 'migrate') {
    const applied = await migrate(db, console.log);
    console.log(applied.length ? `${applied.length} migration(s) appliquée(s)` : 'base à jour');
  } else {
    console.error('usage : db migrate');
    process.exitCode = 1;
  }
} finally {
  await db.end();
}
