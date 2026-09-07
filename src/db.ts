import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './util';

export interface ProgressState {
  position_seconds: number;
  completed: boolean;
}

export interface PendingScanJob {
  status: string;
  new_titles: number;
  updated_titles: number;
  missing_episodes: number;
  quarantined: number;
  errors: string;
}

export function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${Number(env('DB_BUSY_TIMEOUT', '10000'))}`);
  return db;
}

/** Esquema idèntic al sistema original + extensions afegides (auth, llista, preferències). */
export function initSchema(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  password_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS titles (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('movie', 'series', 'anime_movie', 'anime_series')),
  original_title TEXT NOT NULL,
  catalan_title TEXT,
  year INTEGER,
  synopsis_ca TEXT,
  synopsis_fallback TEXT,
  poster_url TEXT,
  genres TEXT NOT NULL DEFAULT '[]',
  external_id TEXT,
  external_source TEXT CHECK (external_source IN ('tmdb', 'anilist') OR external_source IS NULL),
  root_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'indexed' CHECK (status IN ('indexed', 'quarantined', 'missing')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  title_id TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  season_number INTEGER,
  episode_number INTEGER,
  episode_title TEXT,
  file_path TEXT NOT NULL,
  subtitle_path TEXT,
  duration_seconds INTEGER,
  file_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'missing')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(title_id, season_number, episode_number)
);

CREATE TABLE IF NOT EXISTS watch_progress (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  position_seconds INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, episode_id)
);

CREATE TABLE IF NOT EXISTS metadata_cache (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL,
  external_source TEXT NOT NULL CHECK (external_source IN ('tmdb', 'anilist')),
  data TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(external_id, external_source)
);

CREATE TABLE IF NOT EXISTS scan_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  new_titles INTEGER NOT NULL DEFAULT 0,
  updated_titles INTEGER NOT NULL DEFAULT 0,
  missing_episodes INTEGER NOT NULL DEFAULT 0,
  quarantined INTEGER NOT NULL DEFAULT 0,
  errors TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS quarantine (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS watchlist (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title_id TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, title_id)
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_titles_type ON titles(type);
CREATE INDEX IF NOT EXISTS idx_titles_status ON titles(status);
CREATE INDEX IF NOT EXISTS idx_titles_external_id ON titles(external_id, external_source);
CREATE INDEX IF NOT EXISTS idx_titles_year ON titles(year);
CREATE INDEX IF NOT EXISTS idx_episodes_title_id ON episodes(title_id);
CREATE INDEX IF NOT EXISTS idx_episodes_file_hash ON episodes(file_hash);
CREATE INDEX IF NOT EXISTS idx_episodes_status ON episodes(status);
CREATE INDEX IF NOT EXISTS idx_watchlist_user ON watchlist(user_id);
CREATE INDEX IF NOT EXISTS ux_quarantine_path ON quarantine(path);
`);

  // Migracions suaus (no trenquen bases velles)
  const cols = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('password_hash')) {
    db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
  }
}

export interface TitleFilters {
  q?: string;
  type?: string;
  genre?: string;
  year?: number | null;
  page: number;
  limit: number;
}

export function mediaRelPath(filePath: string): string {
  const root = env('MEDIA_ROOT', '/srv/media');
  const rel = filePath.startsWith(root + '/') ? filePath.slice(root.length + 1) : path.basename(filePath);
  return rel;
}

/** Extreu la URL del backdrop (fons hero) des de la cache de metadades. */
export function backdropUrlFor(db: Database.Database, t: { external_id: string | null; external_source: string | null; poster_url: string | null }): string | null {
  if (t.external_id && t.external_source) {
    const row = db
      .prepare('SELECT data FROM metadata_cache WHERE external_id = ? AND external_source = ?')
      .get(t.external_id, t.external_source) as { data: string } | undefined;
    if (row) {
      try {
        const data = JSON.parse(row.data);
        if (data.bannerUrl) return data.bannerUrl;
      } catch {
        /* ignore */
      }
    }
  }
  return t.poster_url;
}

export function listTitles(db: Database.Database, f: TitleFilters): { data: Record<string, unknown>[]; total: number; page: number; totalPages: number } {
  const where: string[] = ["status = 'indexed'"];
  const params: unknown[] = [];
  if (f.type) {
    where.push('type = ?');
    params.push(f.type);
  }
  if (f.genre) {
    where.push("EXISTS (SELECT 1 FROM json_each(titles.genres) g WHERE g.value = ?)");
    params.push(f.genre);
  }
  if (f.year) {
    where.push('year = ?');
    params.push(f.year);
  }
  if (f.q) {
    where.push("(original_title LIKE ? ESCAPE '\\' OR catalan_title LIKE ? ESCAPE '\\')");
    params.push(`%${f.q}%`, `%${f.q}%`);
  }
  const whereSql = where.join(' AND ');
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM titles WHERE ${whereSql}`).get(...params) as { c: number }).c;
  const rows = db
    .prepare(
      `SELECT t.*, (SELECT COUNT(*) FROM episodes e WHERE e.title_id = t.id AND e.status = 'active') AS episode_count
       FROM titles t WHERE ${whereSql}
       ORDER BY COALESCE(NULLIF(t.catalan_title, ''), t.original_title) COLLATE NOCASE ASC, t.id ASC
       LIMIT ? OFFSET ?`
    )
    .all(...params, f.limit, (f.page - 1) * f.limit) as Record<string, unknown>[];
  const out = rows.map((r) => {
    const row = { ...r, genres: JSON.parse(String(r.genres)) };
    (row as Record<string, unknown>).backdrop_url = backdropUrlFor(db, row as never);
    return row;
  });
  const totalPages = Math.max(1, Math.ceil(total / f.limit));
  return { data: out, total, page: f.page, totalPages };
}

export function getTitle(db: Database.Database, id: string): Record<string, unknown> | null {
  const t = db.prepare("SELECT * FROM titles WHERE id = ? AND status = 'indexed'").get(id) as Record<string, unknown> | undefined;
  if (!t) return null;
  t.backdrop_url = backdropUrlFor(db, t as never);
  t.genres = JSON.parse(String(t.genres));
  return t;
}

export function getEpisodes(db: Database.Database, titleId: string): Record<string, unknown>[] {
  return db
    .prepare(
      "SELECT * FROM episodes WHERE title_id = ? AND status = 'active' ORDER BY COALESCE(season_number, 0), COALESCE(episode_number, 0), file_path ASC"
    )
    .all(titleId) as Record<string, unknown>[];
}

export function getEpisode(db: Database.Database, id: string): Record<string, unknown> | null {
  return (db.prepare("SELECT * FROM episodes WHERE id = ?").get(id) as Record<string, unknown>) || null;
}

export function getProgress(db: Database.Database, userId: string, episodeId: string): ProgressState | null {
  const r = db.prepare('SELECT position_seconds, completed FROM watch_progress WHERE user_id = ? AND episode_id = ?').get(userId, episodeId) as
    | { position_seconds: number; completed: number }
    | undefined;
  if (!r) return null;
  return { position_seconds: r.position_seconds, completed: !!r.completed };
}

export function upsertProgress(db: Database.Database, userId: string, episodeId: string, positionSeconds: number, completed: boolean): void {
  db.prepare(
    `INSERT INTO watch_progress (id, user_id, episode_id, position_seconds, completed, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, episode_id) DO UPDATE SET
       position_seconds = excluded.position_seconds,
       completed = excluded.completed,
       updated_at = datetime('now')`
  ).run(require('crypto').randomUUID(), userId, episodeId, Math.max(0, Math.floor(positionSeconds || 0)), completed ? 1 : 0);
}

export function continueWatching(db: Database.Database, userId: string, limit = 20): Record<string, unknown>[] {
  return db
    .prepare(
      `SELECT wp.position_seconds AS position_seconds,
              wp.completed AS completed,
              e.id AS episode_id,
              e.title_id AS title_id,
              e.season_number AS season_number,
              e.episode_number AS episode_number,
              e.episode_title AS episode_title,
              e.duration_seconds AS duration_seconds,
              t.original_title AS original_title,
              t.poster_url AS poster_url,
              t.type AS type
       FROM watch_progress wp
       JOIN episodes e ON e.id = wp.episode_id AND e.status = 'active'
       JOIN titles t ON t.id = e.title_id AND t.status = 'indexed'
       WHERE wp.user_id = ? AND (wp.position_seconds > 0 OR wp.completed = 1)
       ORDER BY wp.updated_at DESC
       LIMIT ?`
    )
    .all(userId, limit) as Record<string, unknown>[];
}

export function getWatchlistIds(db: Database.Database, userId: string): string[] {
  const rows = db.prepare('SELECT title_id FROM watchlist WHERE user_id = ?').all(userId) as { title_id: string }[];
  return rows.map((r) => r.title_id);
}

export function getTitleContinue(db: Database.Database, userId: string, titleId: string): Record<string, unknown> | null {
  return (db
    .prepare(
      `SELECT wp.position_seconds AS position_seconds,
              wp.completed AS completed,
              wp.updated_at AS updated_at,
              e.id AS episode_id,
              e.title_id AS title_id,
              e.season_number AS season_number,
              e.episode_number AS episode_number,
              e.episode_title AS episode_title,
              e.duration_seconds AS duration_seconds
       FROM watch_progress wp
       JOIN episodes e ON e.id = wp.episode_id AND e.status = 'active'
       WHERE wp.user_id = ? AND e.title_id = ? AND wp.completed = 0
       ORDER BY wp.updated_at DESC
       LIMIT 1`
    )
    .get(userId, titleId) as Record<string, unknown> | undefined) || null;
}

export function libraryStats(db: Database.Database): Record<string, number> {
  const one = (sql: string): number => (db.prepare(sql).get() as { c: number }).c;
  return {
    titles: one('SELECT COUNT(*) AS c FROM titles'),
    episodes: one('SELECT COUNT(*) AS c FROM episodes'),
    movies: one("SELECT COUNT(*) AS c FROM titles WHERE type='movie'"),
    series: one("SELECT COUNT(*) AS c FROM titles WHERE type IN ('series','anime_series')"),
    anime: one("SELECT COUNT(*) AS c FROM titles WHERE type IN ('anime_series','anime_movie')"),
    users: one('SELECT COUNT(*) AS c FROM users'),
    quarantine: one('SELECT COUNT(*) AS c FROM quarantine'),
    unresolved: one('SELECT COUNT(*) AS c FROM titles WHERE external_id IS NULL AND status = \'indexed\''),
  };
}

export function getWatchlistTitles(db: Database.Database, userId: string): Record<string, unknown>[] {
  const rows = db
    .prepare(
      `SELECT t.*, (SELECT COUNT(*) FROM episodes e WHERE e.title_id = t.id AND e.status = 'active') AS episode_count
       FROM watchlist w
       JOIN titles t ON t.id = w.title_id AND t.status = 'indexed'
       WHERE w.user_id = ?
       ORDER BY w.created_at DESC`
    )
    .all(userId) as Record<string, unknown>[];
  return rows.map((r) => ({ ...r, genres: JSON.parse(String(r.genres)) }));
}

export function setWatchlist(db: Database.Database, userId: string, titleId: string, saved: boolean): { saved: boolean } {
  if (saved) {
    db.prepare('INSERT OR IGNORE INTO watchlist (user_id, title_id) VALUES (?, ?)').run(userId, titleId);
  } else {
    db.prepare('DELETE FROM watchlist WHERE user_id = ? AND title_id = ?').run(userId, titleId);
  }
  return { saved };
}

export function getPreferences(db: Database.Database, userId: string): Record<string, unknown> {
  const row = db.prepare('SELECT data FROM user_preferences WHERE user_id = ?').get(userId) as { data: string } | undefined;
  if (!row) return {};
  try {
    return JSON.parse(row.data);
  } catch {
    return {};
  }
}

export function setPreferences(db: Database.Database, userId: string, data: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO user_preferences (user_id, data, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`
  ).run(userId, JSON.stringify(data));
}

export function unresolvedTitles(db: Database.Database): Record<string, unknown>[] {
  return db
    .prepare(
      `SELECT id, type, original_title, catalan_title, year FROM titles
       WHERE status = 'indexed' AND (external_id IS NULL OR external_source IS NULL)
       ORDER BY created_at ASC`
    )
    .all() as Record<string, unknown>[];
}

export function listQuarantine(db: Database.Database): Record<string, unknown>[] {
  return db.prepare('SELECT path, reason, created_at FROM quarantine ORDER BY created_at DESC').all() as Record<string, unknown>[];
}

export function metadataCacheGet(db: Database.Database, externalId: string, source: string): { data: unknown } | null {
  const row = db.prepare('SELECT data FROM metadata_cache WHERE external_id = ? AND external_source = ?').get(externalId, source) as
    | { data: string }
    | undefined;
  if (!row) return null;
  try {
    return { data: JSON.parse(row.data) };
  } catch {
    return null;
  }
}

export function metadataCachePut(db: Database.Database, externalId: string, source: string, data: unknown): void {
  db.prepare(
    `INSERT INTO metadata_cache (id, external_id, external_source, data, fetched_at) VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(external_id, external_source) DO UPDATE SET data = excluded.data, fetched_at = datetime('now')`
  ).run(require('crypto').randomUUID(), externalId, source, JSON.stringify(data));
}

export function confirmTitleMetadata(
  db: Database.Database,
  titleId: string,
  candidate: {
    externalId: string;
    externalSource: string;
    title: string;
    year: number | null;
    synopsis: string | null;
    synopsisFallback?: string | null;
    posterUrl: string | null;
    genres: string[];
    bannerUrl?: string | null;
  }
): void {
  // synopsis_ca només s'omple si la fonte ja ens ha donat text en català (TMDB ca-ES).
  // AniList va sempre a synopsis_fallback. La xarxa en-US (si cal) també va a fallback.
  const isTmdb = candidate.externalSource === 'tmdb';
  const synopsisCa = isTmdb && candidate.synopsis ? candidate.synopsis : null;
  const synopsisFallback = isTmdb ? (candidate.synopsisFallback ?? null) : (candidate.synopsis ?? null);
  db.prepare(
    `UPDATE titles SET external_id = ?, external_source = ?, year = ?, poster_url = ?, genres = ?, synopsis_ca = ?, synopsis_fallback = ?
     WHERE id = ?`
  ).run(
    candidate.externalId,
    candidate.externalSource,
    candidate.year ?? null,
    candidate.posterUrl,
    JSON.stringify(candidate.genres),
    synopsisCa,
    synopsisFallback,
    titleId
  );
  metadataCachePut(db, candidate.externalId, candidate.externalSource, {
    title: candidate.title,
    year: candidate.year,
    synopsis: candidate.synopsis,
    synopsisFallback,
    genres: candidate.genres,
    posterUrl: candidate.posterUrl,
    bannerUrl: candidate.bannerUrl ?? null,
  });
}

export function createScanJob(db: Database.Database): string {
  const id = require('crypto').randomUUID();
  db.prepare('INSERT INTO scan_jobs (id, status, started_at) VALUES (?, ?, datetime(\'now\'))').run(id, 'running');
  return id;
}

export function updateScanJob(
  db: Database.Database,
  id: string,
  update: Partial<{ status: string; new_titles: number; updated_titles: number; missing_episodes: number; quarantined: number; errors: string[] }>
): void {
  const cur = db.prepare('SELECT * FROM scan_jobs WHERE id = ?').get(id) as PendingScanJob | undefined;
  if (!cur) return;
  const vals: (string | number)[] = [];
  const sets: string[] = [];
  const curErrors = (() => {
    try {
      return JSON.parse(cur.errors);
    } catch {
      return [];
    }
  })() as string[];
  const nextErrors = update.errors ?? curErrors;
  if (nextErrors.length !== curErrors.length || JSON.stringify(nextErrors) !== JSON.stringify(curErrors)) {
    sets.push('errors = ?');
    vals.push(JSON.stringify(nextErrors.slice(0, 50)));
  }
  const fields: [string, number | string][] = [
    ['new_titles', update.new_titles ?? cur.new_titles],
    ['updated_titles', update.updated_titles ?? cur.updated_titles],
    ['missing_episodes', update.missing_episodes ?? cur.missing_episodes],
    ['quarantined', update.quarantined ?? cur.quarantined],
  ];
  for (const [k, v] of fields) {
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (update.status) {
    sets.push('status = ?');
    vals.push(update.status);
    if (update.status === 'completed' || update.status === 'failed') {
      sets.push("completed_at = datetime('now')");
    }
  }
  db.prepare(`UPDATE scan_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
}

export function getScanJob(db: Database.Database, id: string): Record<string, unknown> | null {
  return (db.prepare('SELECT * FROM scan_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined) || null;
}

export function listScanJobs(db: Database.Database, limit = 10): Record<string, unknown>[] {
  return db
    .prepare(
      `SELECT id, status, started_at, completed_at, new_titles, updated_titles, missing_episodes, quarantined, errors
       FROM scan_jobs ORDER BY started_at DESC LIMIT ?`
    )
    .all(limit) as Record<string, unknown>[];
}

/** Títols indexats marcats com a missing quan el seu directori ha desaparegut. */
export function markStaleTitles(db: Database.Database, liveRoots: Set<string>): number {
  const rows = db.prepare("SELECT id FROM titles WHERE status = 'indexed'").all() as { id: string }[];
  let n = 0;
  const st = db.prepare("UPDATE titles SET status = 'missing' WHERE id = ?");
  for (const r of rows) {
    const t = db.prepare('SELECT root_path FROM titles WHERE id = ?').get(r.id) as { root_path: string };
    if (t && !liveRoots.has(t.root_path)) {
      st.run(r.id);
      n++;
    }
  }
  return n;
}

/** Marca els episodis no trobats a l'escaneig com a missing. */
export function markMissingEpisodesFor(db: Database.Database, titleId: string, liveHashes: Set<string>): number {
  const rows = db.prepare("SELECT id, file_hash FROM episodes WHERE title_id = ? AND status = 'active'").all(titleId) as {
    id: string;
    file_hash: string;
  }[];
  let n = 0;
  const st = db.prepare("UPDATE episodes SET status = 'missing' WHERE id = ?");
  for (const r of rows) {
    if (!liveHashes.has(r.file_hash)) {
      st.run(r.id);
      n++;
    }
  }
  return n;
}

export function getTitleByRootPath(db: Database.Database, rootPath: string): Record<string, unknown> | null {
  return (db.prepare('SELECT * FROM titles WHERE root_path = ?').get(rootPath) as Record<string, unknown>) || null;
}

export function insertTitle(
  db: Database.Database,
  t: {
    id: string;
    type: string;
    original_title: string;
    catalan_title: string | null;
    year: number | null;
    root_path: string;
    status: string;
    genres: string[];
    synopsis_ca?: string | null;
  }
): void {
  db.prepare('INSERT OR IGNORE INTO titles (id, type, original_title, catalan_title, year, genres, root_path, status, synopsis_ca, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))').run(
    t.id,
    t.type,
    t.original_title,
    t.catalan_title ?? t.original_title,
    t.year,
    JSON.stringify(t.genres),
    t.root_path,
    t.status,
    t.synopsis_ca ?? null
  );
}

export function insertEpisode(
  db: Database.Database,
  e: {
    id: string;
    title_id: string;
    season_number: number | null;
    episode_number: number | null;
    episode_title: string | null;
    file_path: string;
    subtitle_path: string | null;
    duration_seconds: number | null;
    file_hash: string;
  }
): void {
  db.prepare('INSERT OR IGNORE INTO episodes (id, title_id, season_number, episode_number, episode_title, file_path, subtitle_path, duration_seconds, file_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))').run(
    e.id,
    e.title_id,
    e.season_number,
    e.episode_number,
    e.episode_title,
    e.file_path,
    e.subtitle_path,
    e.duration_seconds,
    e.file_hash
  );
}

export function quarantinePath(db: Database.Database, p: string, reason: string): void {
  db.prepare('INSERT OR IGNORE INTO quarantine (id, path, reason) VALUES (?, ?, ?)').run(require('crypto').randomUUID(), p, reason);
}

export function ensureDataDir(): string {
  const dir = path.resolve(env('DB_PATH', '/opt/hermes/data/hermes.db')).replace(/hermes\.db$/, '');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}