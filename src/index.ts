import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import express, { Request, Response, NextFunction } from 'express';
import { loadEnvFile, env, escLike, safeStat, ensureDir } from './util';
import { openDb, initSchema } from './db';
import * as dbq from './db';
import * as auth from './auth';
import * as ff from './lib/ffmpeg';
import { srtToVtt } from './lib/srt';
import { anilistCandidates } from './lib/anilist';
import { tmdbEnabled, tmdbSearch, tmdbOverviewEn } from './lib/tmdb';

loadEnvFile(path.join(process.cwd(), '.env'));
loadEnvFile(path.join(__dirname, '..', '.env'));

const DB_PATH = env('DB_PATH', '/opt/hermes/data/hermes.db');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
ensureDir(path.dirname(DB_PATH));

const db = openDb(DB_PATH);
initSchema(db);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const asyncH = (fn: (req: Request, res: Response) => Promise<void> | void) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).catch(next);
};

function activeUser(req: Request): string | null {
  const id = String(req.header('X-User-Id') || '');
  return id && auth.getUserById(db, id) ? id : null;
}

app.set('json spaces', 2);

// ── Cache de remux (àudio alternatiu) ───────────────────────────────────────
// Lock en memòria perquè diverses peticions concurrents del mateix remux
// comparteixin UNA construcció ffmpeg en lloc de duplicar-la.

const remuxInFlight = new Map<string, Promise<string>>();

function withRemuxLock(key: string, build: () => Promise<string>): Promise<string> {
  const existing = remuxInFlight.get(key);
  if (existing) return existing;
  const p = build().finally(() => remuxInFlight.delete(key));
  remuxInFlight.set(key, p);
  return p;
}

/** Neteja la cache de remux: fitxers de més de 30 dies + límit de 30 GB (elimina els més vells). */
function setupRemuxCleanup(intervalMs = 6 * 60 * 60 * 1000): void {
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  const CAP = 30 * 1024 ** 3;
  const invalid = (p: string): boolean => {
    try {
      const st = fs.statSync(p);
      return !st.isFile() || st.size <= 1024;
    } catch {
      return true;
    }
  };
  const run = () => {
    const dir = env('REMUX_DIR', '/opt/hermes/data/remux');
    if (!safeStat(dir)?.isDirectory()) return;
    const now = Date.now();
    let live: { p: string; mtime: number; size: number }[] = [];
    try {
      live = fs
        .readdirSync(dir)
        .map((n) => {
          const p = path.join(dir, n);
          if (invalid(p)) return null;
          const st = fs.statSync(p);
          return { p, mtime: st.mtimeMs, size: st.size };
        })
        .filter((e): e is { p: string; mtime: number; size: number } => e !== null);
    } catch {
      return;
    }
    for (const e of live) {
      if (now - e.mtime <= THIRTY_DAYS) continue;
      try {
        fs.rmSync(e.p, { force: true });
      } catch {
        /* ignore */
      }
    }
    live = live.filter((e) => fs.existsSync(e.p));
    let total = live.reduce((s, e) => s + e.size, 0);
    if (total <= CAP) return;
    live.sort((a, b) => a.mtime - b.mtime);
    for (const e of live) {
      if (total <= CAP) break;
      try {
        fs.rmSync(e.p, { force: true });
        total -= e.size;
      } catch {
        /* ignore */
      }
    }
  };
  try {
    run();
  } catch {
    /* no fatal */
  }
  setInterval(run, intervalMs).unref();
}

setupRemuxCleanup();

// ── Estàtics (frontend SPA) ─────────────────────────────────────────────────
app.use(express.static(PUBLIC_DIR, { etag: false, maxAge: 0 }));

// ── Catàleg ─────────────────────────────────────────────────────────────────

app.get('/api/titles', (req, res) => {
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || '24'), 10) || 24));
  const q = String(req.query.q || '').trim();
  const type = String(req.query.type || '').trim();
  const genre = String(req.query.genre || '').trim();
  const yearRaw = String(req.query.year || '').trim();
  const year = yearRaw ? parseInt(yearRaw, 10) || null : null;
  const data = dbq.listTitles(db, { q: q ? escLike(q) : undefined, type: type || undefined, genre: genre || undefined, year, page, limit });
  res.json(data);
});

app.get('/api/titles/:id', (req, res) => {
  const title = dbq.getTitle(db, req.params.id);
  if (!title) {
    res.status(404).json({ error: 'Títol no trobat' });
    return;
  }
  const userId = activeUser(req);
  const episodes = dbq.getEpisodes(db, req.params.id).map((ep) => ({
    ...ep,
    progress: userId ? dbq.getProgress(db, userId, String(ep.id)) : null,
  }));
  res.json({ ...title, episodes });
});

app.get('/api/titles/:id/continue', (req, res) => {
  const title = dbq.getTitle(db, req.params.id);
  if (!title) {
    res.status(404).json({ error: 'Títol no trobat' });
    return;
  }
  const userId = activeUser(req);
  res.json(userId ? dbq.getTitleContinue(db, userId, req.params.id) : null);
});

// ── Progrés i "Continua veient" ─────────────────────────────────────────────

app.post('/api/progress', (req, res) => {
  const userId = activeUser(req);
  if (userId) {
    // Acceptem snake_case (especificació §7) i camelCase (client actual)
    const b = req.body || {};
    const episodeId = String(b.episodeId ?? b.episode_id ?? '');
    const positionSeconds = Number(b.positionSeconds ?? b.position_seconds ?? 0) || 0;
    const completed = !!(b.completed ?? b.completed);
    if (!episodeId || !dbq.getEpisode(db, episodeId)) {
      res.status(400).json({ error: 'Episodi invàlid' });
      return;
    }
    dbq.upsertProgress(db, userId, episodeId, positionSeconds, completed);
  }
  res.status(204).end();
});

app.get('/api/progress/:episodeId', (req, res) => {
  const userId = activeUser(req);
  if (!userId) {
    res.status(401).json({ error: 'Cal una sessió' });
    return;
  }
  const ep = dbq.getEpisode(db, req.params.episodeId);
  if (!ep) {
    res.status(404).json({ error: 'Episodi no trobat' });
    return;
  }
  const p = dbq.getProgress(db, userId, req.params.episodeId);
  res.json(p);
});

app.get('/api/continue-watching', (req, res) => {
  const userId = activeUser(req);
  res.json(userId ? dbq.continueWatching(db, userId) : []);
});

// ── Watchlist ("La meva llista") ────────────────────────────────────────────

app.get('/api/me/watchlist/ids', (req, res) => {
  const userId = activeUser(req);
  res.json(userId ? dbq.getWatchlistIds(db, userId) : []);
});

app.get('/api/me/watchlist', (req, res) => {
  const userId = activeUser(req);
  res.json(userId ? dbq.getWatchlistTitles(db, userId) : []);
});

app.post('/api/me/watchlist/:titleId', (req, res) => {
  const userId = activeUser(req);
  if (!userId) {
    res.status(401).json({ error: 'Cal una sessió' });
    return;
  }
  res.json(dbq.setWatchlist(db, userId, req.params.titleId, true));
});

app.delete('/api/me/watchlist/:titleId', (req, res) => {
  const userId = activeUser(req);
  res.json(dbq.setWatchlist(db, userId || '', req.params.titleId, false));
});

// ── Preferències personal ───────────────────────────────────────────────────

app.get('/api/me/preferences', (req, res) => {
  const userId = activeUser(req);
  res.json(userId ? dbq.getPreferences(db, userId) : {});
});

app.put('/api/me/preferences', (req, res) => {
  const userId = activeUser(req);
  if (userId) dbq.setPreferences(db, userId, req.body || {});
  res.json({ ok: true });
});

// ── Metadades (revisió) ─────────────────────────────────────────────────────

app.get('/api/metadata/unresolved', (req, res) => {
  res.json(dbq.unresolvedTitles(db));
});

app.get(
  '/api/metadata/candidates/:titleId',
  asyncH(async (req, res) => {
    const title = dbq.getTitle(db, req.params.titleId);
    if (!title) {
      res.status(404).json({ error: 'Títol no trobat' });
      return;
    }
    const q = String(req.query.q || '').trim();
    const query = q || String(title.catalan_title || title.original_title);
    const isAnime = (title.type as string) === 'anime_series' || (title.type as string) === 'anime_movie';
    try {
      if (isAnime) {
        res.json(await anilistCandidates(query));
      } else if (tmdbEnabled()) {
        const kind = title.type === 'series' ? 'tv' : 'movie';
        res.json(await tmdbSearch(query, kind));
      } else {
        res.json([]);
      }
    } catch (e) {
      res.json([]);
    }
  })
);

app.post(
  '/api/metadata/confirm',
  asyncH(async (req, res) => {
    const b = req.body || {};
    const { titleId, externalId, externalSource, title, year, synopsis, posterUrl, genres } = b;
    const t = dbq.getTitle(db, String(titleId));
    if (!t || !externalId || !externalSource) {
      res.status(400).json({ error: 'Dades incompletes' });
      return;
    }
    let synopsisFallback: string | null = null;
    const src = String(externalSource);
    if (src === 'tmdb' && !synopsis && tmdbEnabled()) {
      try {
        synopsisFallback = await tmdbOverviewEn(String(externalId), t.type === 'series' ? 'tv' : 'movie');
      } catch {
        synopsisFallback = null;
      }
    }
    dbq.confirmTitleMetadata(db, String(titleId), {
      externalId: String(externalId),
      externalSource: src === 'anilist' ? 'anilist' : 'tmdb',
      title: String(title || t.original_title),
      year: year ? Number(year) || null : null,
      synopsis: synopsis ? String(synopsis) : null,
      synopsisFallback,
      posterUrl: posterUrl ? String(posterUrl) : null,
      genres: Array.isArray(genres) ? genres.map(String) : [],
    });
    res.json({ ok: true });
  })
);

app.get('/api/quarantine', (req, res) => {
  res.json(dbq.listQuarantine(db));
});

// ── Perfils i autenticació ──────────────────────────────────────────────────

app.get('/api/profiles', (req, res) => {
  res.json(auth.listProfiles(db, activeUser(req)));
});

app.post('/api/profiles', (req, res) => {
  const name = String((req.body || {}).displayName || '').trim();
  const password = req.body?.password ? String(req.body.password) : null;
  if (!name) {
    res.status(400).json({ error: 'El nom és obligatori' });
    return;
  }
  if (auth.getUserByName(db, name)) {
    res.status(409).json({ error: 'Aquest nom ja existeix' });
    return;
  }
  const profile = auth.createProfile(db, name, password);
  res.status(201).json(profile);
});

app.post('/api/login', (req, res) => {
  const name = String((req.body || {}).displayName || '').trim();
  const password = String((req.body || {}).password || '');
  const user = auth.getUserByName(db, name);
  if (!user || !user.password_hash || !auth.verifyPassword(password, user.password_hash)) {
    res.status(401).json({ error: 'Nom o contrasenya incorrectes' });
    return;
  }
  res.json({ id: user.id, display_name: user.display_name });
});

app.delete('/api/profiles/:id', (req, res) => {
  const id = req.params.id;
  const deleted = auth.deleteProfile(db, id);
  if (!deleted) {
    res.status(404).json({ error: 'Perfil no trobat' });
    return;
  }
  res.json({ deleted: true, currentDestroyed: id === activeUser(req) });
});

app.patch('/api/profiles/:id', (req, res) => {
  const id = req.params.id;
  const name = String((req.body || {}).displayName || '');
  const r = auth.renameProfile(db, id, name);
  if (!r.ok) {
    res.status(r.error === 'Perfil no trobat' ? 404 : 400).json({ error: r.error });
    return;
  }
  res.json({ id, display_name: name.trim() });
});

// ── Escaneig ────────────────────────────────────────────────────────────────

app.post('/api/scan', (req, res) => {
  const roots = ['movies', 'anime', 'series', 'tv']
    .map((c) => path.join(env('MEDIA_ROOT', '/srv/media'), c))
    .filter((p) => safeStat(p)?.isDirectory());
  if (!roots.length) {
    res.status(503).json({ error: 'Cap directori de media disponible' });
    return;
  }
  const jobId = dbq.createScanJob(db);
  const cli = path.join(__dirname, 'scanner.js');
  const child = spawn(process.execPath, [cli, '--job', jobId], {
    cwd: path.join(__dirname, '..', '..'),
    env: process.env,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  child.on('error', () => {
    dbq.updateScanJob(db, jobId, { status: 'failed', errors: ['No s\'ha pogut iniciar el procés scanner'] });
  });
  res.json({ jobId });
});

app.get('/api/scan/jobs', (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit || '10'), 10) || 10));
  res.json(dbq.listScanJobs(db, limit));
});

app.get('/api/scan/:jobId', (req, res) => {
  const job = dbq.getScanJob(db, req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Feina no trobada' });
    return;
  }
  res.json({
    status: job.status,
    found: Number(job.new_titles || 0) + Number(job.updated_titles || 0),
    updated: Number(job.updated_titles || 0),
    missing: Number(job.missing_episodes || 0),
    quarantined: Number(job.quarantined || 0),
    errors: Array.isArray(job.errors) ? job.errors : (job.errors ? JSON.parse(String(job.errors)) : []),
    started_at: job.started_at || null,
    completed_at: job.completed_at || null,
  });
});

app.get('/api/stats', (req, res) => {
  res.json(dbq.libraryStats(db));
});

// ── Reproductor: pistes, subtítols, streaming ───────────────────────────────

app.get(
  '/api/episodes/:id/tracks',
  asyncH(async (req, res) => {
    const ep = dbq.getEpisode(db, req.params.id);
    if (!ep || ep.status !== 'active') {
      res.status(404).json({ error: 'Episodi no trobat' });
      return;
    }
    try {
      res.json(await ff.getTracks(String(ep.file_path)));
    } catch (e) {
      res.status(500).json({ error: `No s'han pogut llegir les pistes: ${(e as Error).message}` });
    }
  })
);

app.post('/api/episodes/:id/prefetch', (req, res) => {
  const ep = dbq.getEpisode(db, req.params.id);
  if (!ep || ep.status !== 'active') {
    res.status(404).json({ error: 'Episodi no trobat' });
    return;
  }
  void (async () => {
    try {
      const tracks = await ff.getTracks(String(ep.file_path));
      if (tracks.audios.length <= 1) return;
      const remuxDir = ensureDir(env('REMUX_DIR', '/opt/hermes/data/remux'));
      const key = String(ep.file_hash);
      // Generar totes les pistes alternatives (excepte la per defecte), amb
      // concurrència màxima de 2 per no ofegar la CPU mentre es reprodueix.
      const alts = tracks.audios.slice(1);
      let i = 0;
      const worker = (): Promise<void> => {
        const a = alts[i++];
        if (!a) return Promise.resolve();
        const lockKey = `${key}_a${a.index}`;
        return withRemuxLock(lockKey, () => ff.buildRemuxFile(String(ep.file_path), tracks, a.index, remuxDir, key))
          .catch(() => {})
          .then(worker);
      };
      const workers = Array.from({ length: Math.min(2, alts.length) }, () => worker());
      await Promise.all(workers);
    } catch {
      /* es prefereix no fer fallar el client */
    }
  })();
  res.json({ ok: true });
});

app.get(
  '/api/episodes/:id/subtitles/embedded/:idx',
  asyncH(async (req, res) => {
    const ep = dbq.getEpisode(db, req.params.id);
    if (!ep || ep.status !== 'active') {
      res.status(404).json({ error: 'Episodi no trobat' });
      return;
    }
    const idx = parseInt(req.params.idx, 10);
    if (!Number.isInteger(idx)) {
      res.status(400).json({ error: 'Índex invàlid' });
      return;
    }
    try {
      // L'índex que fa servir el client és el GLOBAL del flux; ffmpeg espera la
      // posició dins els fluxos de subtítols (`-map 0:s:N`).
      const tracks = await ff.getTracks(String(ep.file_path));
      const sub = (tracks.subtitles || []).find((s) => s.index === idx);
      if (!sub) {
        res.status(404).json({ error: 'Subtítol no trobat' });
        return;
      }
      const vtt = await ff.extractEmbeddedSubtitleVtt(String(ep.file_path), sub.mapPos);
      res.set('Content-Type', 'text/vtt; charset=utf-8');
      res.set('Cache-Control', 'no-store');
      res.send(vtt);
    } catch (e) {
      res.status(500).json({ error: `Subtítol no disponible: ${(e as Error).message}` });
    }
  })
);

app.get(
  '/api/subtitles/:id',
  asyncH(async (req, res) => {
    const ep = dbq.getEpisode(db, req.params.id);
    if (!ep || !ep.subtitle_path || !safeStat(String(ep.subtitle_path))) {
      res.status(404).json({ error: 'Subtítol no trobat' });
      return;
    }
    const file = String(ep.subtitle_path);
    const text = fs.readFileSync(file, 'utf8');
    res.set('Content-Type', 'text/vtt; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    if (/\.vtt$/i.test(file)) {
      res.send(text);
    } else {
      res.send(srtToVtt(text));
    }
  })
);

function streamFileWithRange(res: Response, file: string, mime: string): void {
  const stat = fs.statSync(file);
  const total = stat.size;
  const range = res.req.headers.range;
  res.set('Accept-Ranges', 'bytes');
  res.set('Content-Type', mime);
  if (!range) {
    res.set('Content-Length', String(total));
    res.status(200);
    const streamAll = fs.createReadStream(file);
    streamAll.pipe(res);
    return;
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  if (!m) {
    res.set('Content-Range', `bytes */${total}`);
    res.status(416).end();
    return;
  }
  let start = m[1] ? parseInt(m[1], 10) : 0;
  let end = m[2] ? parseInt(m[2], 10) : total - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start >= total) {
    res.set('Content-Range', `bytes */${total}`);
    res.status(416).end();
    return;
  }
  end = Math.min(end, total - 1);
  if (start < 0) start = Math.max(0, total + start);
  res.status(206);
  res.set('Content-Range', `bytes ${start}-${end}/${total}`);
  res.set('Content-Length', String(end - start + 1));
  const stream = fs.createReadStream(file, { start, end });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

async function streamEpisode(res: Response, episodeId: string, audioRaw: string | null | undefined): Promise<void> {
  const ep = dbq.getEpisode(db, episodeId);
  if (!ep || (ep.status as string) !== 'active') {
    res.status(404).json({ error: 'Episodi no trobat' });
    return;
  }
  const file = String(ep.file_path);
  if (!safeStat(file)) {
    res.status(404).json({ error: 'El fitxer ja no existeix al disc' });
    return;
  }
  const audio = audioRaw != null && audioRaw !== '' ? parseInt(audioRaw, 10) : null;

  if (audio == null) {
    res.set('Content-Type', ff.videoMime(file));
    res.set('X-Accel-Redirect', `/internal-media/${encodeURI(dbq.mediaRelPath(file))}`);
    res.set('Accept-Ranges', 'bytes');
    res.status(200).end();
    return;
  }

  // Àudio alternatiu: remux a la cache (persistent dins data/) i servir amb Range.
  const key = String(ep.file_hash);
  const remuxDir = ensureDir(env('REMUX_DIR', '/opt/hermes/data/remux'));
  const cached = path.join(remuxDir, `${key}_a${audio}.mp4`);
  if (fs.existsSync(cached) && fs.statSync(cached).size > 1024) {
    streamFileWithRange(res, cached, 'video/mp4');
    return;
  }
  try {
    const tracks = await ff.getTracks(file);
    if (!tracks.audios.some((a) => a.index === audio)) {
      res.status(404).json({ error: 'Pista d\'àudio no trobada' });
      return;
    }
    const lockKey = `${key}_a${audio}`;
    const built = await withRemuxLock(lockKey, () => ff.buildRemuxFile(file, tracks, audio, remuxDir, key));
    streamFileWithRange(res, built, 'video/mp4');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      res.status(404).json({ error: 'Pista d\'àudio no trobada' });
      return;
    }
    res.status(500).json({ error: `No s'ha pogut generar el remux: ${(e as Error).message}` });
  }
}

app.get('/api/stream/:id', asyncH(async (req, res) => {
  await streamEpisode(res, req.params.id, req.query.audio as string | undefined);
}));

app.get('/api/titles/:titleId/stream/:episodeId', asyncH(async (req, res) => {
  await streamEpisode(res, req.params.episodeId, req.query.audio as string | undefined);
}));

// ── Fallback API ────────────────────────────────────────────────────────────

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Ruta no trobada' });
});

// ── Arrencada ───────────────────────────────────────────────────────────────

const PORT = Number(env('PORT', '3000'));
app.listen(PORT, () => {
  console.log(`Hermes API escoltant a http://127.0.0.1:${PORT} (DB: ${DB_PATH})`);
});

export { db };