import path from 'node:path';
import { loadEnvFile, env } from './util';
import { openDb, initSchema, createScanJob, updateScanJob } from './db';
import { runScan, runMetaLink } from './media/scanner';

loadEnvFile(path.join(process.cwd(), '.env'));
loadEnvFile(path.join(__dirname, '..', '.env'));

async function main() {
  const args = process.argv.slice(2);
  const flag = (name: string): string | null => {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] ? args[i + 1] : null;
  };
  const has = (name: string) => args.includes(name);

  const jobId = has('--job') ? flag('--job') : null;
  const linkOnly = has('--link-only');
  const mediaRoot = flag('--media-root');

  if (linkOnly && jobId) {
    throw new Error('No es combinen --link-only i --job');
  }

  const dbPath = env('DB_PATH', '/opt/hermes/data/hermes.db');
  const db = openDb(dbPath);
  initSchema(db);

  try {
    if (linkOnly) {
      const counters = await runMetaLink(db);
      console.log(`Enllaç metadades: ${counters.updatedTitles} actualitzats, ${counters.errors.length} errors`);
      return;
    }

    let id: string;
    if (jobId) {
      id = jobId;
      const existing = db.prepare('SELECT id FROM scan_jobs WHERE id = ?').get(jobId) as { id: string } | undefined;
      if (existing) {
        updateScanJob(db, id, { status: 'running' });
      } else {
        db.prepare('INSERT INTO scan_jobs (id, status) VALUES (?, \'running\')').run(jobId);
      }
    } else {
      id = createScanJob(db);
    }

    let counters;
    try {
      counters = await runScan(db, { mediaRoot: mediaRoot ?? undefined });
      if (!linkOnly) {
        const linkCounters = await runMetaLink(db);
        counters.updatedTitles += linkCounters.updatedTitles;
        counters.errors.push(...linkCounters.errors);
      }
    } catch (e) {
      updateScanJob(db, id, { status: 'failed', errors: [(e as Error).message] });
      console.error('Escaneig fallit:', e);
      process.exitCode = 1;
      return;
    }

    updateScanJob(db, id, {
      status: 'completed',
      new_titles: counters.newTitles,
      updated_titles: counters.updatedTitles,
      missing_episodes: counters.missingEpisodes,
      quarantined: counters.quarantined,
      errors: counters.errors,
    });
    console.log(
      `Escaneig completat (${id.slice(0, 8)}): ${counters.newTitles} nous, ${counters.updatedTitles} actualitzats, ${counters.missingEpisodes} missing, ${counters.quarantined} en quarantena, ${counters.errors.length} errors`
    );
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});