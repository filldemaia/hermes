import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { env } from './util';

export interface ProgressState {
  position_seconds: number;
  completed: boolean;
}

export function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${Number(env('DB_BUSY_TIMEOUT', '10000'))}`);
  return db;
}

/**
 * Esquema v2: catàleg TMDb de contingut en català (original o doblat).
 * Els títols ja no neixen de fitxers del disc: el sincronitzador els baixa
 * de TMDb. La reproducció local queda reservada a contingut lliure (is_free).
 */
export function initSchema(db: Database.Database): void {
  // Migració v1→v2 (condicional, només si hi ha esquema antic centrat en fitxers).
  // El catàleg nou el reconstrueix el sincronitzador TMDb.
  const tcols = (db.prepare('PRAGMA table_info(titles)').all() as { name: string }[]).map((c) => c.name);
  const oldTitles = tcols.length > 0 && !tcols.includes('tmdb_id');
  const wpCols = (db.prepare('PRAGMA table_info(watch_progress)').all() as { name: string }[]).map((c) => c.name);
  const oldWp = wpCols.length > 0 && !wpCols.includes('title_id');
  if (oldWp) db.exec('DROP TABLE watch_progress;');
  if (oldTitles) db.exec('DROP TABLE IF EXISTS watchlist; DROP TABLE titles;');
  db.exec(`
DROP TABLE IF EXISTS episodes;
DROP TABLE IF EXISTS scan_jobs;
DROP TABLE IF EXISTS quarantine;
DROP TABLE IF EXISTS metadata_cache;
`);

  db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  password_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS titles (
  id TEXT PRIMARY KEY,              -- tmdb-movie-27205 / tmdb-tv-14743
  tmdb_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('movie', 'series')),
  original_title TEXT NOT NULL,
  catalan_title TEXT,
  year INTEGER,
  synopsis_ca TEXT,
  poster_url TEXT,
  backdrop_url TEXT,
  genres TEXT NOT NULL DEFAULT '[]',
  original_language TEXT,
  popularity REAL NOT NULL DEFAULT 0,
  vote_average REAL NOT NULL DEFAULT 0,
  is_anime INTEGER NOT NULL DEFAULT 0,
  has_ca INTEGER NOT NULL DEFAULT 0,     -- existeix traducció/doblatge en català a TMDb
  is_free INTEGER NOT NULL DEFAULT 0,    -- contingut de drets lliures: reproduïble
  file_path TEXT,                        -- fitxer local (només contingut lliure)
  provider_data TEXT,                    -- JSON watch/providers (regió ES)
  details_synced INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(type, tmdb_id)
);

CREATE TABLE IF NOT EXISTS watch_progress (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title_id TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  position_seconds INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, title_id)
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

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS title_sources (
  title_id TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,                -- '3cat', 'filmincat', ...
  kind TEXT NOT NULL DEFAULT 'link',     -- 'free' | 'flatrate' | 'rent' | 'buy' | 'link'
  url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (title_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_titles_type ON titles(type);
CREATE INDEX IF NOT EXISTS idx_titles_year ON titles(year);
CREATE INDEX IF NOT EXISTS idx_titles_popularity ON titles(popularity DESC);
CREATE INDEX IF NOT EXISTS idx_titles_created ON titles(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_titles_sort_title
  ON titles(COALESCE(NULLIF(catalan_title, ''), original_title) COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_titles_anime ON titles(is_anime);
CREATE INDEX IF NOT EXISTS idx_titles_details ON titles(details_synced);
CREATE INDEX IF NOT EXISTS idx_watchlist_user ON watchlist(user_id);
`);

  // Migracions suaus
  const cols = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('password_hash')) {
    db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
  }
  if (!cols.includes('photo')) {
    db.exec('ALTER TABLE users ADD COLUMN photo TEXT');
  }

  migrateGenresToCa(db);
}

/** Gèneres TMDb en anglès → català (TMDb no té traducció ca dels gèneres). */
const GENRE_EN_TO_CA: Record<string, string> = {
  'Action': 'Acció',
  'Adventure': 'Aventura',
  'Animation': 'Animació',
  'Comedy': 'Comèdia',
  'Crime': 'Crim',
  'Documentary': 'Documental',
  'Drama': 'Drama',
  'Family': 'Familiar',
  'Fantasy': 'Fantasia',
  'History': 'Història',
  'Horror': 'Terror',
  'Music': 'Música',
  'Mystery': 'Misteri',
  'Romance': 'Romàntic',
  'Science Fiction': 'Ciència-ficció',
  'TV Movie': 'Pel·lícula de televisió',
  'War': 'Bèl·lica',
  'Action & Adventure': 'Acció i aventura',
  'Kids': 'Infantil',
  'News': 'Notícies',
  'Reality': 'Realitat',
  'Sci-Fi & Fantasy': 'Ciència-ficció i fantasia',
  'Soap': 'Telenovel·la',
  'Talk': 'Tertúlia',
  'War & Politics': 'Guerra i política',
};

/** Converteix una vegada els gèneres guardats en anglès a català (idempotent). */
function migrateGenresToCa(db: Database.Database): void {
  const rows = db.prepare('SELECT id, genres FROM titles').all() as { id: string; genres: string }[];
  const upd = db.prepare('UPDATE titles SET genres = ? WHERE id = ?');
  for (const r of rows) {
    let arr: unknown[];
    try {
      arr = JSON.parse(r.genres || '[]');
    } catch {
      continue;
    }
    if (!Array.isArray(arr)) continue;
    const mapped = arr.map((g) => (typeof g === 'string' ? GENRE_EN_TO_CA[g] || g : g));
    if (JSON.stringify(mapped) !== JSON.stringify(arr)) {
      upd.run(JSON.stringify(mapped), r.id);
    }
  }
}

export function tmdbRowId(type: 'movie' | 'series', tmdbId: number): string {
  return `tmdb-${type}-${tmdbId}`;
}

// ── Estat de sincronització ─────────────────────────────────────────────────

export function getSyncState(db: Database.Database, key: string): string | null {
  const r = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as { value: string } | undefined;
  return r?.value ?? null;
}

export function setSyncState(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(key, value);
}

// ── Upserts del sincronitzador ──────────────────────────────────────────────

export interface CatalogUpsert {
  tmdbId: number;
  type: 'movie' | 'series';
  originalTitle: string;
  catalanTitle: string | null;
  year: number | null;
  synopsisCa: string | null;
  posterUrl: string | null;
  backdropUrl: string | null;
  genres: string[];
  originalLanguage: string | null;
  popularity: number;
  voteAverage: number;
  hasCa: number;
  isAnime: number;
  providerData: string | null;
  detailsSynced: number;
}

export function upsertCatalogTitle(db: Database.Database, t: CatalogUpsert): void {
  db.prepare(
    `INSERT INTO titles (id, tmdb_id, type, original_title, catalan_title, year, synopsis_ca, poster_url, backdrop_url,
                         genres, original_language, popularity, vote_average, is_anime, has_ca, is_free, file_path,
                         provider_data, details_synced, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       original_title = excluded.original_title,
       catalan_title = COALESCE(excluded.catalan_title, titles.catalan_title),
       year = COALESCE(excluded.year, titles.year),
       synopsis_ca = COALESCE(excluded.synopsis_ca, titles.synopsis_ca),
       poster_url = COALESCE(excluded.poster_url, titles.poster_url),
       backdrop_url = COALESCE(excluded.backdrop_url, titles.backdrop_url),
       genres = CASE WHEN excluded.genres != '[]' THEN excluded.genres ELSE titles.genres END,
       original_language = COALESCE(excluded.original_language, titles.original_language),
       popularity = excluded.popularity,
       vote_average = excluded.vote_average,
       is_anime = MAX(titles.is_anime, excluded.is_anime),
       has_ca = MAX(titles.has_ca, excluded.has_ca),
       provider_data = COALESCE(excluded.provider_data, titles.provider_data),
       details_synced = MAX(titles.details_synced, excluded.details_synced),
       updated_at = datetime('now')`
  ).run(
    tmdbRowId(t.type, t.tmdbId),
    t.tmdbId,
    t.type,
    t.originalTitle,
    t.catalanTitle,
    t.year,
    t.synopsisCa,
    t.posterUrl,
    t.backdropUrl,
    JSON.stringify(t.genres),
    t.originalLanguage,
    t.popularity,
    t.voteAverage,
    t.isAnime,
    t.hasCa,
    t.providerData,
    t.detailsSynced
  );
}

/** Proper lot de títols pendent d'enriquir amb detalls (Phase C). */
export function pendingDetails(db: Database.Database, limit: number): { id: string; tmdb_id: number; type: string }[] {
  return db
    .prepare(
      `SELECT id, tmdb_id, type FROM titles WHERE details_synced = 0
       ORDER BY popularity DESC LIMIT ?`
    )
    .all(limit) as { id: string; tmdb_id: number; type: string }[];
}

/** Compta títols pendents d'enriquir. */
export function countPendingDetails(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM titles WHERE details_synced = 0').get() as { c: number }).c;
}

// ── Consultes del catàleg (frontend) ────────────────────────────────────────

export interface TitleFilters {
  q?: string;
  type?: string;
  genre?: string;
  year?: number | null;
  anime?: boolean | null;
  free?: boolean | null;
  provider?: string;
  sort?: string;
  page: number;
  limit: number;
}

const SORTS: Record<string, string> = {
  popularity: 't.popularity DESC',
  new: 't.created_at DESC, t.popularity DESC',
  year: 't.year DESC, t.popularity DESC',
  rating: 't.vote_average DESC, t.popularity DESC',
  title: 'COALESCE(NULLIF(t.catalan_title, \'\'), t.original_title) COLLATE NOCASE ASC',
};

export function listTitles(db: Database.Database, f: TitleFilters): { data: Record<string, unknown>[]; total: number; page: number; totalPages: number } {
  const where: string[] = ['1=1'];
  const params: unknown[] = [];
  if (f.type === 'movie' || f.type === 'series') {
    where.push('t.type = ?');
    params.push(f.type);
  }
  if (f.genre) {
    where.push("EXISTS (SELECT 1 FROM json_each(t.genres) g WHERE g.value = ?)");
    params.push(f.genre);
  }
  if (f.year) {
    where.push('t.year = ?');
    params.push(f.year);
  }
  if (f.anime != null) {
    where.push('t.is_anime = ?');
    params.push(f.anime ? 1 : 0);
  }
  if (f.free != null) {
    where.push('t.is_free = ?');
    params.push(f.free ? 1 : 0);
  }
  if (f.provider) {
    where.push("t.provider_data LIKE ?");
    params.push(`%${f.provider}%`);
  }
  if (f.q) {
    where.push("(t.original_title LIKE ? ESCAPE '\\' OR t.catalan_title LIKE ? ESCAPE '\\')");
    params.push(`%${f.q}%`, `%${f.q}%`);
  }
  const whereSql = where.join(' AND ');
  const orderSql = SORTS[f.sort || 'popularity'] || SORTS.popularity;
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM titles t WHERE ${whereSql}`).get(...params) as { c: number }).c;
  const rows = db
    .prepare(`SELECT t.* FROM titles t WHERE ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`)
    .all(...params, f.limit, (f.page - 1) * f.limit) as Record<string, unknown>[];
  const out = rows.map(parseRow);
  const totalPages = Math.max(1, Math.ceil(total / f.limit));
  return { data: out, total, page: f.page, totalPages };
}

function parseRow(r: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = { ...r, genres: JSON.parse(String(r.genres || '[]')), episode_count: 0 };
  row.playable = !!row.is_free && !!row.file_path;
  return row;
}

export function getTitle(db: Database.Database, id: string): Record<string, unknown> | null {
  const t = db.prepare('SELECT * FROM titles WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!t) return null;
  const row = parseRow(t);
  const displayTitle = String(t.catalan_title || t.original_title || '');
  row.providers = getProvidersFor(db, id, String(t.provider_data || ''), displayTitle);
  row.search_links = getSearchLinksFor(db, id, displayTitle);
  return row;
}

export interface SourceUpsert {
  titleId: string;
  provider: string;
  kind: string;
  url: string;
}

export function upsertTitleSource(db: Database.Database, s: SourceUpsert): void {
  db.prepare(
    `INSERT INTO title_sources (title_id, provider, kind, url, created_at, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(title_id, provider) DO UPDATE SET kind = excluded.kind, url = excluded.url, updated_at = datetime('now')`
  ).run(s.titleId, s.provider, s.kind, s.url);
}

export function clearTitleSources(db: Database.Database, provider: string): void {
  db.prepare('DELETE FROM title_sources WHERE provider = ?').run(provider);
}

export function sourceStats(db: Database.Database): Record<string, number> {
  const rows = db.prepare('SELECT provider, COUNT(*) AS c FROM title_sources GROUP BY provider').all() as { provider: string; c: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.provider] = r.c;
  return out;
}

/** Noms de marca per als proveïdors de fonts pròpies. */
const SOURCE_NAMES: Record<string, string> = {
  '3cat': '3Cat',
  'filmincat': 'FilminCAT',
};

/** URL de cerca dins una plataforma per a un títol. */
export function providerSearchUrl(provider: string, title: string): string {
  const q = encodeURIComponent(title);
  const p = provider.toLowerCase();
  if (p.includes('3cat') || p.includes('3 cat') || p.includes('ccma')) {
    return `https://www.3cat.cat/cercador/?text=${q}`;
  }
  if (p.includes('filmin')) {
    return `https://www.filmin.cat/cerca?text=${q}`;
  }
  if (p.includes('prime') || p.includes('amazon')) {
    return `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${q}`;
  }
  if (p.includes('netflix')) {
    return `https://www.netflix.com/search?q=${q}`;
  }
  if (p.includes('apple')) {
    return `https://tv.apple.com/search?term=${q}`;
  }
  if (p.includes('disney')) {
    return `https://www.disneyplus.com/search?q=${q}`;
  }
  return '';
}

/** Proveïdors d'un títol: fonts pròpies (3Cat...) + watch/providers de TMDb. */
function getProvidersFor(db: Database.Database, titleId: string, providerData: string, displayTitle: string): ProviderEntry[] {
  const out: ProviderEntry[] = [];
  const rows = db.prepare('SELECT provider, kind, url FROM title_sources WHERE title_id = ?').all(titleId) as { provider: string; kind: string; url: string }[];
  for (const r of rows) {
    out.push({ name: SOURCE_NAMES[r.provider] || r.provider, kind: r.kind === 'free' ? 'free' : r.kind === 'link' ? 'flatrate' : (r.kind as ProviderEntry['kind']), url: r.url });
  }
  const tmdb = parseProviders(providerData);
  // evitem duplicats pel mateix nom
  const seen = new Set(out.map((p) => p.name.toLowerCase()));
  for (const p of tmdb) {
    if (seen.has(p.name.toLowerCase())) continue;
    // Els proveïdors coneguts reben un enllaç de cerca directe; la resta, la
    // pàgina watch de TMDb.
    const direct = providerSearchUrl(p.name, displayTitle);
    out.push({ ...p, url: direct || p.url });
  }
  return out;
}

/** Enllaços de cerca quan no sabem que hi és (3Cat cercador + FilminCAT). */
function getSearchLinksFor(db: Database.Database, titleId: string, title: string): { name: string; url: string }[] {
  const has3cat = !!db.prepare("SELECT 1 FROM title_sources WHERE title_id = ? AND provider = '3cat'").get(titleId);
  const links: { name: string; url: string }[] = [];
  const q = encodeURIComponent(title);
  if (!has3cat) links.push({ name: '3Cat', url: `https://www.3cat.cat/cercador/?text=${q}` });
  links.push({ name: 'FilminCAT', url: `https://www.filmin.cat/cerca?text=${q}` });
  return links;
}

export interface ProviderEntry {
  name: string;
  kind: 'flatrate' | 'rent' | 'buy' | 'free';
  url: string | null;
}

/** Converteix el JSON de watch/providers de TMDb en llista plana per a la UI. */
export function parseProviders(providerData: string): ProviderEntry[] {
  if (!providerData) return [];
  try {
    const d = JSON.parse(providerData) as {
      link?: string;
      flatrate?: { provider_name: string }[];
      rent?: { provider_name: string }[];
      buy?: { provider_name: string }[];
      free?: { provider_name: string }[];
    };
    const out: ProviderEntry[] = [];
    const push = (list: { provider_name: string }[] | undefined, kind: ProviderEntry['kind']) => {
      for (const p of list || []) out.push({ name: p.provider_name, kind, url: d.link || null });
    };
    push(d.flatrate, 'flatrate');
    push(d.free, 'free');
    push(d.rent, 'rent');
    push(d.buy, 'buy');
    return out;
  } catch {
    return [];
  }
}

// ── Progrés i "Continua veient" (a nivell de títol) ─────────────────────────

export function getProgress(db: Database.Database, userId: string, titleId: string): ProgressState | null {
  const r = db.prepare('SELECT position_seconds, completed FROM watch_progress WHERE user_id = ? AND title_id = ?').get(userId, titleId) as
    | { position_seconds: number; completed: number }
    | undefined;
  if (!r) return null;
  return { position_seconds: r.position_seconds, completed: !!r.completed };
}

export function upsertProgress(db: Database.Database, userId: string, titleId: string, positionSeconds: number, completed: boolean): void {
  db.prepare(
    `INSERT INTO watch_progress (user_id, title_id, position_seconds, completed, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, title_id) DO UPDATE SET
       position_seconds = excluded.position_seconds,
       completed = excluded.completed,
       updated_at = datetime('now')`
  ).run(userId, titleId, Math.max(0, Math.floor(positionSeconds || 0)), completed ? 1 : 0);
}

export function continueWatching(db: Database.Database, userId: string, limit = 20): Record<string, unknown>[] {
  return db
    .prepare(
      `SELECT wp.position_seconds AS position_seconds,
              wp.completed AS completed,
              wp.title_id AS title_id,
              wp.title_id AS episode_id,
              t.original_title,
              t.catalan_title,
              t.poster_url,
              t.type,
              t.year
       FROM watch_progress wp
       JOIN titles t ON t.id = wp.title_id
       WHERE wp.user_id = ? AND (wp.position_seconds > 0 OR wp.completed = 1)
       ORDER BY wp.updated_at DESC
       LIMIT ?`
    )
    .all(userId, limit) as Record<string, unknown>[];
}

export function getTitleContinue(db: Database.Database, userId: string, titleId: string): Record<string, unknown> | null {
  return (db
    .prepare(
      `SELECT wp.position_seconds AS position_seconds,
              wp.completed AS completed,
              wp.updated_at AS updated_at,
              wp.title_id AS title_id,
              wp.title_id AS episode_id
       FROM watch_progress wp
       WHERE wp.user_id = ? AND wp.title_id = ? AND wp.completed = 0
       LIMIT 1`
    )
    .get(userId, titleId) as Record<string, unknown> | undefined) || null;
}

// ── Watchlist ───────────────────────────────────────────────────────────────

export function getWatchlistIds(db: Database.Database, userId: string): string[] {
  const rows = db.prepare('SELECT title_id FROM watchlist WHERE user_id = ?').all(userId) as { title_id: string }[];
  return rows.map((r) => r.title_id);
}

export function getWatchlistTitles(db: Database.Database, userId: string): Record<string, unknown>[] {
  const rows = db
    .prepare(
      `SELECT t.* FROM watchlist w
       JOIN titles t ON t.id = w.title_id
       WHERE w.user_id = ?
       ORDER BY w.created_at DESC`
    )
    .all(userId) as Record<string, unknown>[];
  return rows.map(parseRow);
}

export function setWatchlist(db: Database.Database, userId: string, titleId: string, saved: boolean): { saved: boolean } {
  if (saved) {
    db.prepare('INSERT OR IGNORE INTO watchlist (user_id, title_id) VALUES (?, ?)').run(userId, titleId);
  } else {
    db.prepare('DELETE FROM watchlist WHERE user_id = ? AND title_id = ?').run(userId, titleId);
  }
  return { saved };
}

// ── Preferències ────────────────────────────────────────────────────────────

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

/** Gèneres disponibles amb recomptes, per a les fileres per categoria. */
export function listGenres(db: Database.Database, type: string | undefined, minCount = 3, limit = 14): { genre: string; count: number }[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (type === 'movie' || type === 'series') {
    where.push("t.type = ?");
    params.push(type);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT g.value AS genre, COUNT(*) AS count
       FROM titles t, json_each(t.genres) g
       ${whereSql}
       GROUP BY g.value
       HAVING COUNT(*) >= ?
       ORDER BY count DESC, genre ASC
       LIMIT ?`
    )
    .all(...params, minCount, limit) as { genre: string; count: number }[];
  return rows;
}

// ── Estadístiques ───────────────────────────────────────────────────────────

export function libraryStats(db: Database.Database): Record<string, number> {
  const one = (sql: string): number => (db.prepare(sql).get() as { c: number }).c;
  return {
    titles: one('SELECT COUNT(*) AS c FROM titles'),
    movies: one("SELECT COUNT(*) AS c FROM titles WHERE type='movie'"),
    series: one("SELECT COUNT(*) AS c FROM titles WHERE type='series'"),
    anime: one('SELECT COUNT(*) AS c FROM titles WHERE is_anime = 1'),
    originalsCa: one("SELECT COUNT(*) AS c FROM titles WHERE original_language = 'ca'"),
    free: one('SELECT COUNT(*) AS c FROM titles WHERE is_free = 1'),
    users: one('SELECT COUNT(*) AS c FROM users'),
  };
}

export function ensureDataDir(): string {
  const dir = path.resolve(env('DB_PATH', '/opt/hermes/data/hermes.db')).replace(/hermes\.db$/, '');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
