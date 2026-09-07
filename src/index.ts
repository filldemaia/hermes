import path from 'node:path';
import fs from 'node:fs';
import express, { Request, Response, NextFunction } from 'express';
import { loadEnvFile, env, escLike, safeStat, ensureDir } from './util';
import { openDb, initSchema } from './db';
import * as dbq from './db';
import * as auth from './auth';
import * as ff from './lib/ffmpeg';
import { startCatalogSync, runCatalogSync, syncStatus } from './catalog/sync';
import { sourceSyncStatus } from './catalog/sources';

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

// ── Rate limiting bàsic (per IP, finestra fixa 60 s) ────────────────────────
// El streaming de vídeo té límit més alt per no interferir la reproducció.

const RATE_LIMIT = Number(env('RATE_LIMIT', '120')); // peticions/minut API normal
const RATE_LIMIT_STREAM = Number(env('RATE_LIMIT_STREAM', '600')); // reproducció
const isStreamPath = (p: string): boolean =>
  p.startsWith('/api/stream/') ||
  p.startsWith('/api/titles/') && /\/(stream|tracks|subtitles)/.test(p) ||
  p.startsWith('/api/episodes/');

const rateBuckets = new Map<string, { count: number; reset: number }>();

function clientIp(req: Request): string {
  return String(
    req.header('CF-Connecting-IP') ||
    req.header('X-Forwarded-For')?.split(',')[0]?.trim() ||
    req.socket.remoteAddress ||
    ''
  );
}

app.use('/api', (req, res, next) => {
  const now = Date.now();
  const ip = clientIp(req);
  const limit = isStreamPath(req.path) ? RATE_LIMIT_STREAM : RATE_LIMIT;
  let b = rateBuckets.get(ip);
  if (!b || now >= b.reset) {
    b = { count: 0, reset: now + 60_000 };
    rateBuckets.set(ip, b);
    if (rateBuckets.size > 10_000) {
      for (const [k, v] of rateBuckets) if (now >= v.reset) rateBuckets.delete(k);
    }
  }
  b.count++;
  res.set('X-RateLimit-Limit', String(limit));
  res.set('X-RateLimit-Remaining', String(Math.max(0, limit - b.count)));
  if (b.count > limit) {
    const retry = Math.ceil((b.reset - now) / 1000);
    res.set('Retry-After', String(retry));
    res.status(429).json({ error: 'Massa peticions. Torna-ho a provar en un minut.' });
    return;
  }
  next();
});

// Neteja periòdica dels buckets caducats
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) if (now >= v.reset) rateBuckets.delete(k);
}, 120_000).unref();

setupRemuxCleanup();

// ── Lock de remux (àudio alternatiu del contingut lliure) ───────────────────

const remuxInFlight = new Map<string, Promise<string>>();

function withRemuxLock(key: string, build: () => Promise<string>): Promise<string> {
  const existing = remuxInFlight.get(key);
  if (existing) return existing;
  const p = build().finally(() => remuxInFlight.delete(key));
  remuxInFlight.set(key, p);
  return p;
}

/** Neteja la cache de remux: fitxers de més de 30 dies + cap de 30 GB (els més vells fora). */
function setupRemuxCleanup(intervalMs = 6 * 60 * 60 * 1000): void {
  const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
  const CAP = 30 * 1024 ** 3;
  const run = () => {
    const dir = env('REMUX_DIR', '/opt/hermes/data/remux');
    if (!safeStat(dir)?.isDirectory()) return;
    let live: { p: string; mtime: number; size: number }[] = [];
    try {
      live = fs
        .readdirSync(dir)
        .map((n) => {
          const p = path.join(dir, n);
          const st = safeStat(p);
          if (!st?.isFile() || st.size <= 1024) return null;
          return { p, mtime: st.mtimeMs, size: st.size };
        })
        .filter((e): e is { p: string; mtime: number; size: number } => e !== null);
    } catch {
      return;
    }
    const now = Date.now();
    for (const e of live) {
      if (now - e.mtime > THIRTY_DAYS) {
        try {
          fs.rmSync(e.p, { force: true });
        } catch {
          /* ignore */
        }
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
    /* no és fatal */
  }
  setInterval(run, intervalMs).unref();
}

// ── Estàtics (frontend SPA) ─────────────────────────────────────────────────
app.use(express.static(PUBLIC_DIR, { etag: false, maxAge: 0 }));

// ── Catàleg (TMDb, contingut en català) ─────────────────────────────────────

app.get('/api/titles', (req, res) => {
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || '24'), 10) || 24));
  const q = String(req.query.q || '').trim();
  const type = String(req.query.type || '').trim();
  const genre = String(req.query.genre || '').trim();
  const provider = String(req.query.provider || '').trim();
  const sort = String(req.query.sort || 'popularity').trim();
  const yearRaw = String(req.query.year || '').trim();
  const freeRaw = String(req.query.free ?? '').trim();
  let animeRaw = String(req.query.anime ?? '').trim();
  if (animeRaw === '') {
    // Filtre per defecte segons la preferència de l'usuari (show_anime, per defecte actiu)
    const userId = activeUser(req);
    if (userId) {
      const prefs = dbq.getPreferences(db, userId) as { show_anime?: boolean };
      if (prefs.show_anime === false) animeRaw = '0';
    }
  }
  const data = dbq.listTitles(db, {
    q: q ? escLike(q) : undefined,
    type: type || undefined,
    genre: genre || undefined,
    provider: provider || undefined,
    sort,
    year: yearRaw ? parseInt(yearRaw, 10) || null : null,
    anime: animeRaw === '' ? null : animeRaw === '1' || animeRaw === 'true',
    free: freeRaw === '' ? null : freeRaw === '1' || freeRaw === 'true',
    page,
    limit,
  });
  res.json(data);
});

app.get('/api/genres', (req, res) => {
  const type = String(req.query.type || '').trim();
  const min = Math.max(1, parseInt(String(req.query.min || '3'), 10) || 3);
  res.json(dbq.listGenres(db, type || undefined, min));
});

app.get('/api/titles/:id', (req, res) => {
  const title = dbq.getTitle(db, req.params.id);
  if (!title) {
    res.status(404).json({ error: 'Títol no trobat' });
    return;
  }
  const userId = activeUser(req);
  res.json({ ...title, progress: userId ? dbq.getProgress(db, userId, req.params.id) : null });
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
    const b = req.body || {};
    const titleId = String(b.titleId ?? b.title_id ?? b.episodeId ?? b.episode_id ?? '');
    const positionSeconds = Number(b.positionSeconds ?? b.position_seconds ?? 0) || 0;
    const completed = !!(b.completed ?? b.completed);
    if (!titleId || !dbq.getTitle(db, titleId)) {
      res.status(400).json({ error: 'Títol invàlid' });
      return;
    }
    dbq.upsertProgress(db, userId, titleId, positionSeconds, completed);
  }
  res.status(204).end();
});

app.get('/api/progress/:titleId', (req, res) => {
  const userId = activeUser(req);
  if (!userId) {
    res.status(401).json({ error: 'Cal una sessió' });
    return;
  }
  res.json(dbq.getProgress(db, userId, req.params.titleId));
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

// ── Perfils i autenticació ──────────────────────────────────────────────────

app.get('/api/profiles', (req, res) => {
  res.json(auth.listProfiles(db, activeUser(req)));
});

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,20}$/;

app.post('/api/profiles', (req, res) => {
  const name = String((req.body || {}).displayName || '').trim();
  const password = req.body?.password ? String(req.body.password) : null;
  if (!name) {
    res.status(400).json({ error: "El nom d'usuari és obligatori" });
    return;
  }
  if (!USERNAME_RE.test(name)) {
    res.status(400).json({ error: "El nom ha de tenir 3-20 caràcters: lletres, números, punt, guió o guió baix" });
    return;
  }
  if (password != null && password.length < 6) {
    res.status(400).json({ error: 'La contrasenya ha de tenir com a mínim 6 caràcters' });
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
  if (!USERNAME_RE.test(name.trim())) {
    res.status(400).json({ error: "El nom ha de tenir 3-20 caràcters: lletres, números, punt, guió o guió baix" });
    return;
  }
  const r = auth.renameProfile(db, id, name);
  if (!r.ok) {
    res.status(r.error === 'Perfil no trobat' ? 404 : 400).json({ error: r.error });
    return;
  }
  res.json({ id, display_name: name.trim() });
});

// ── Sincronització del catàleg ──────────────────────────────────────────────

app.get('/api/sync/status', (req, res) => {
  res.json({ ...syncStatus(db), sources: sourceSyncStatus(db) });
});

app.post('/api/sync', asyncH(async (_req, res) => {
  // Sense bloquejar la resposta: el cicle corre en segon pla.
  void runCatalogSync(db);
  res.json({ ok: true });
}));

app.get('/api/stats', (req, res) => {
  res.json(dbq.libraryStats(db));
});

// ── Reproductor (només contingut lliure amb fitxer local) ───────────────────

function playableTitle(id: string): Record<string, unknown> | null {
  const t = dbq.getTitle(db, id);
  if (!t || !t.is_free || !t.file_path) return null;
  const file = String(t.file_path);
  return safeStat(file) ? { ...t, file } : null;
}

async function handleTracks(req: Request, res: Response): Promise<void> {
  const t = playableTitle(req.params.id);
  if (!t) {
    res.status(404).json({ error: 'Contingut no reproduïble' });
    return;
  }
  try {
    res.json(await ff.getTracks(String(t.file)));
  } catch (e) {
    res.status(500).json({ error: `No s'han pogut llegir les pistes: ${(e as Error).message}` });
  }
}

async function handleEmbeddedSubtitle(req: Request, res: Response): Promise<void> {
  const t = playableTitle(req.params.id);
  if (!t) {
    res.status(404).json({ error: 'Contingut no reproduïble' });
    return;
  }
  const idx = parseInt(req.params.idx, 10);
  if (!Number.isInteger(idx)) {
    res.status(400).json({ error: 'Índex invàlid' });
    return;
  }
  try {
    const tracks = await ff.getTracks(String(t.file));
    const sub = (tracks.subtitles || []).find((s) => s.index === idx);
    if (!sub) {
      res.status(404).json({ error: 'Subtítol no trobat' });
      return;
    }
    const vtt = await ff.extractEmbeddedSubtitleVtt(String(t.file), sub.mapPos);
    res.set('Content-Type', 'text/vtt; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.send(vtt);
  } catch (e) {
    res.status(500).json({ error: `Subtítol no disponible: ${(e as Error).message}` });
  }
}

// ── Rutes de reproducció (àlies /api/episodes per compatibilitat client) ────

app.get('/api/titles/:id/tracks', asyncH(handleTracks));
app.get('/api/episodes/:id/tracks', asyncH(handleTracks));
app.get('/api/titles/:id/subtitles/embedded/:idx', asyncH(handleEmbeddedSubtitle));
app.get('/api/episodes/:id/subtitles/embedded/:idx', asyncH(handleEmbeddedSubtitle));

app.post('/api/episodes/:id/prefetch', (req, res) => {
  const t = playableTitle(req.params.id);
  if (!t) {
    res.json({ ok: false });
    return;
  }
  void (async () => {
    try {
      const tracks = await ff.getTracks(String(t.file));
      if (tracks.audios.length <= 1) return;
      const remuxDir = ensureDir(env('REMUX_DIR', '/opt/hermes/data/remux'));
      const key = String(t.id);
      const alts = tracks.audios.slice(1);
      let i = 0;
      const worker = (): Promise<void> => {
        const a = alts[i++];
        if (!a) return Promise.resolve();
        const lockKey = `${key}_a${a.index}`;
        return withRemuxLock(lockKey, () => ff.buildRemuxFile(String(t.file), tracks, a.index, remuxDir, key))
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

// ── Streaming ───────────────────────────────────────────────────────────────

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

/** Stream d'un títol lliure ja resol·lat (amb fitxer existent). */
async function streamTitle(res: Response, t: Record<string, unknown>, audioRaw: string | null | undefined): Promise<void> {
  const file = String(t.file);
  const audio = audioRaw != null && audioRaw !== '' ? parseInt(audioRaw, 10) : null;

  if (audio == null) {
    streamFileWithRange(res, file, ff.videoMime(file));
    return;
  }

  // Àudio alternatiu: remux a la cache i servir amb Range.
  const key = String(t.id);
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

function handleStream(res: Response, id: string, audio: string | null | undefined): Promise<void> {
  const t = playableTitle(id);
  if (!t) {
    res.status(404).json({ error: 'Contingut no reproduïble' });
    return Promise.resolve();
  }
  return streamTitle(res, t, audio);
}

// Rutes de streaming antigues: mantenides com a àlies.
app.get('/api/stream/:id', asyncH(async (req, res) => {
  await handleStream(res, req.params.id, req.query.audio as string | undefined);
}));

app.get('/api/titles/:titleId/stream/:episodeId', asyncH(async (req, res) => {
  await handleStream(res, req.params.titleId, req.query.audio as string | undefined);
}));

// ── Fallback API ────────────────────────────────────────────────────────────

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Ruta no trobada' });
});

// ── Arrencada ───────────────────────────────────────────────────────────────

const PORT = Number(env('PORT', '3000'));
app.listen(PORT, () => {
  console.log(`Hermes API escoltant a http://127.0.0.1:${PORT} (DB: ${DB_PATH})`);
  startCatalogSync(db);
});

export { db };
