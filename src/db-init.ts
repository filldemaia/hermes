import path from 'node:path';
import Database from 'better-sqlite3';
import { loadEnvFile, env } from './util';
import { openDb, initSchema } from './db';

loadEnvFile(path.join(process.cwd(), '.env'));
loadEnvFile(path.join(__dirname, '..', '.env'));

/**
 * Inicialitza la base de dades:
 *  - crea l'esquema (idempotent),
 *  - opcionalment importa usuaris + cache de metadades des d'un backup
 *    (p. ex. la còpia recuperada del Sep 1),
 *  - amb --clean elimina títols/episodis/quarantena obsolets per
 *    reconstruir la biblioteca des de zero amb el scanner.
 */
async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] ? args[i + 1] : null;
  };
  const has = (name: string) => args.includes(name);

  const from = flag('--from');
  const clean = has('--clean');
  const dbPath = env('DB_PATH', '/opt/hermes/data/hermes.db');

  require('node:fs').mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = openDb(dbPath);
  initSchema(db);

  const copyCount = { users: 0, cache: 0 };
  if (from) {
    const src = new Database(path.resolve(from), { readonly: true });
    try {
      const hasUsers = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c;
      if (!hasUsers && src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get()) {
        const rows = src.prepare('SELECT id, display_name, created_at, updated_at FROM users').all() as { id: string; display_name: string; created_at: string; updated_at: string }[];
        const ins = db.prepare('INSERT OR IGNORE INTO users (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)');
        for (const r of rows) {
          ins.run(r.id, r.display_name, r.created_at, r.updated_at);
          copyCount.users++;
        }
      }
      const hasCache = (db.prepare('SELECT COUNT(*) AS c FROM metadata_cache').get() as { c: number }).c;
      if (!hasCache && src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata_cache'").get()) {
        const rows = src.prepare('SELECT external_id, external_source, data, fetched_at FROM metadata_cache').all() as {
          external_id: string;
          external_source: string;
          data: string;
          fetched_at: string;
        }[];
        const ins = db.prepare('INSERT OR IGNORE INTO metadata_cache (id, external_id, external_source, data, fetched_at) VALUES (?, ?, ?, ?, ?)');
        for (const r of rows) {
          ins.run(require('node:crypto').randomUUID(), r.external_id, r.external_source, r.data, r.fetched_at);
          copyCount.cache++;
        }
      }
    } finally {
      src.close();
    }
  }

  if (clean) {
    db.exec('DELETE FROM quarantine; DELETE FROM episodes; DELETE FROM titles; DELETE FROM watch_progress;');
    console.log('Biblioteca netejada (títols, episodis, quarantena i progrés eliminats).');
  }

  const stats = {
    users: (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c,
    titles: (db.prepare('SELECT COUNT(*) AS c FROM titles').get() as { c: number }).c,
    episodes: (db.prepare('SELECT COUNT(*) AS c FROM episodes').get() as { c: number }).c,
    cache: (db.prepare('SELECT COUNT(*) AS c FROM metadata_cache').get() as { c: number }).c,
  };
  console.log(`Base de dades llesta: ${JSON.stringify(stats)} (copiats: ${JSON.stringify(copyCount)})`);
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});