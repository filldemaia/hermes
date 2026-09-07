import path from 'node:path';
import Database from 'better-sqlite3';
import { loadEnvFile, env } from './util';
import { openDb, initSchema } from './db';

loadEnvFile(path.join(process.cwd(), '.env'));
loadEnvFile(path.join(__dirname, '..', '.env'));

/**
 * Inicialitza la base de dades:
 *  - crea l'esquema v2 (catàleg TMDb, idempotent),
 *  - opcionalment importa usuaris des d'un backup.
 * El catàleg el pobla el sincronitzador TMDb automàticament.
 */
async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] ? args[i + 1] : null;
  };

  const from = flag('--from');
  const dbPath = env('DB_PATH', '/opt/hermes/data/hermes.db');

  require('node:fs').mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = openDb(dbPath);
  initSchema(db);

  let copiedUsers = 0;
  if (from) {
    const src = new Database(path.resolve(from), { readonly: true });
    try {
      const hasUsers = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
      if (!hasUsers && src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get()) {
        const rows = src.prepare('SELECT id, display_name, created_at, updated_at FROM users').all() as {
          id: string;
          display_name: string;
          created_at: string;
          updated_at: string;
        }[];
        const ins = db.prepare('INSERT OR IGNORE INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)');
        for (const r of rows) {
          ins.run(r.id, r.display_name, r.created_at, r.updated_at);
          copiedUsers++;
        }
      }
    } finally {
      src.close();
    }
  }

  const stats = {
    users: (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c,
    titles: (db.prepare('SELECT COUNT(*) AS c FROM titles').get() as { c: number }).c,
  };
  console.log(`Base de dades llesta: ${JSON.stringify(stats)} (usuaris copiats: ${copiedUsers})`);
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
