import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Proves d'integració del sistema v2 (catàleg TMDb):
 *  - es crea una BD temporal amb títols de prova (originals en català, doblats, anime);
 *  - s'arrenca el servidor (dist/index.js) sense TMDB_API_KEY (sincronitzador aturat);
 *  - es proven llistat/filtres/paginació, detall amb providers, watchlist,
 *    progrés, preferències, auth, stats i endpoints de sincronització.
 */

const Database = require('better-sqlite3') as typeof import('better-sqlite3');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-it-'));
const dbPath = path.join(tmp, 'test.db');
let server: {
  kill(signal?: NodeJS.Signals | number): void;
  stderr: NodeJS.ReadableStream | null;
} | null = null;
let port = 0;
let base = '';
let errLog = '';

function randomPort(): number {
  return 20000 + Math.floor(Math.random() * 30000);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (r: Response): Promise<any> => r.json();

async function waitReady(url: string, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* encara no */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`el servidor no ha respost en ${timeoutMs} ms\n${errLog}`);
}

function makeFixture(): void {
  const db = new Database(dbPath);
  const { initSchema, upsertCatalogTitle } = require('./db') as {
    initSchema: (db: unknown) => void;
    upsertCatalogTitle: (db: unknown, t: Record<string, unknown>) => void;
  };
  initSchema(db as never);

  const base = { detailsSynced: 1, providerData: null, synopsisCa: 'Sinopsi de prova', backdropUrl: null };
  // Original en català (pel·lícula)
  upsertCatalogTitle(db, {
    ...base,
    tmdbId: 1001,
    type: 'movie',
    originalTitle: 'Film català',
    catalanTitle: 'Film català',
    year: 2020,
    posterUrl: null,
    genres: ['Drama'],
    originalLanguage: 'ca',
    popularity: 10,
    voteAverage: 6.5,
    hasCa: 1,
    isAnime: 0,
  });
  // Doblada popular (pel·lícula, amb providers)
  upsertCatalogTitle(db, {
    ...base,
    tmdbId: 1002,
    type: 'movie',
    originalTitle: 'Inception de prova',
    catalanTitle: 'Origen de prova',
    year: 2010,
    posterUrl: null,
    genres: ['Acció', 'Ciència ficció'],
    originalLanguage: 'en',
    popularity: 90,
    voteAverage: 8.4,
    hasCa: 1,
    isAnime: 0,
    providerData: JSON.stringify({
      link: 'https://www.themoviedb.org/movie/27205/watch?locale=ES',
      flatrate: [{ provider_name: 'Amazon Prime Video' }],
      rent: [{ provider_name: 'Apple TV Store' }],
    }),
  });
  // Sèrie anime
  upsertCatalogTitle(db, {
    ...base,
    tmdbId: 2001,
    type: 'series',
    originalTitle: 'Anime de prova',
    catalanTitle: 'Anime doblat',
    year: 2015,
    posterUrl: null,
    genres: ['Animació'],
    originalLanguage: 'ja',
    popularity: 50,
    voteAverage: 7.9,
    hasCa: 1,
    isAnime: 1,
  });
  // Sèrie no anime sense traducció catalana
  upsertCatalogTitle(db, {
    ...base,
    tmdbId: 2002,
    type: 'series',
    originalTitle: 'Sèrie estrangera',
    catalanTitle: null,
    year: 2022,
    posterUrl: null,
    genres: ['Documental'],
    originalLanguage: 'de',
    popularity: 5,
    voteAverage: 5.0,
    hasCa: 0,
    isAnime: 0,
  });
  // Contingut lliure reproduïble
  upsertCatalogTitle(db, {
    ...base,
    tmdbId: 1003,
    type: 'movie',
    originalTitle: 'Clàssic de domini públic',
    catalanTitle: 'Clàssic lliure',
    year: 1925,
    posterUrl: null,
    genres: ['Comèdia'],
    originalLanguage: 'en',
    popularity: 3,
    voteAverage: 7.0,
    hasCa: 1,
    isAnime: 0,
  });
  db.prepare("UPDATE titles SET is_free = 1, file_path = '/tmp/opencode/inexistent.mp4' WHERE tmdb_id = 1003 AND type = 'movie'").run();

  db.prepare(
    "INSERT INTO users (id, display_name, password_hash, created_at, updated_at) VALUES ('00000000-0000-0000-0000-000000000001', 'Usuari principal', NULL, datetime('now'), datetime('now'))"
  ).run();

  // Font pròpia: 3Cat per a la pel·lícula original en català
  db.prepare(
    "INSERT INTO title_sources (title_id, provider, kind, url) VALUES ('tmdb-movie-1001', '3cat', 'free', 'https://www.3cat.cat/3cat/film-cata/')"
  ).run();
  db.close();
}

function startServer(): void {
  port = randomPort();
  const cwd = path.join(__dirname, '..');
  server = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      REMUX_DIR: path.join(tmp, 'remux'),
      TMDB_API_KEY: '',
      SYNC_POPULAR_PAGES: '0',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr!.on('data', (d: Buffer) => {
    errLog += String(d);
  });
  base = `http://127.0.0.1:${port}`;
}

before(async () => {
  makeFixture();
  startServer();
  await waitReady(base);
});

after(() => {
  server?.kill('SIGTERM');
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ── Catàleg ─────────────────────────────────────────────────────────────────

test('GET /api/titles: llista paginada ordenada per popularitat', async () => {
  const r = await fetch(`${base}/api/titles`);
  const d = await json(r);
  assert.equal(r.status, 200);
  assert.equal(d.total, 5);
  assert.equal(d.data.length, 5);
  assert.equal(d.data[0].original_title, 'Inception de prova'); // popularitat 90
  assert.ok(d.data[0].backdrop_url !== undefined);
});

test('GET /api/titles?type=movie&sort=title: filtre per tipus i ordre alfabètic', async () => {
  const r = await fetch(`${base}/api/titles?type=movie&sort=title`);
  const d = await json(r);
  assert.equal(d.total, 3);
  const titles = d.data.map((t: { catalan_title: string }) => t.catalan_title);
  assert.deepEqual(titles, ['Clàssic lliure', 'Film català', 'Origen de prova']);
});

test('GET /api/titles?anime=1: només anime', async () => {
  const r = await fetch(`${base}/api/titles?anime=1`);
  const d = await json(r);
  assert.equal(d.total, 1);
  assert.equal(d.data[0].tmdb_id, 2001);
  assert.equal(d.data[0].is_anime, 1);
});

test('GET /api/titles?anime=0: exclou anime (futur toggle)', async () => {
  const r = await fetch(`${base}/api/titles?anime=0`);
  const d = await json(r);
  assert.equal(d.total, 4);
  assert.ok(d.data.every((t: { is_anime: number }) => t.is_anime === 0));
});

test('GET /api/titles?q=: cerca per títol català i original', async () => {
  const r1 = await fetch(`${base}/api/titles?q=${encodeURIComponent('origen')}`);
  const d1 = await json(r1);
  assert.equal(d1.total, 1);
  assert.equal(d1.data[0].tmdb_id, 1002);

  const r2 = await fetch(`${base}/api/titles?q=${encodeURIComponent('estrangera')}`);
  const d2 = await json(r2);
  assert.equal(d2.total, 1);
  assert.equal(d2.data[0].tmdb_id, 2002);
});

test('GET /api/titles: paginació coherent', async () => {
  const r = await fetch(`${base}/api/titles?limit=2&page=2&sort=title`);
  const d = await json(r);
  assert.equal(d.total, 5);
  assert.equal(d.totalPages, 3);
  assert.equal(d.page, 2);
  assert.equal(d.data.length, 2);
});

test('GET /api/titles/:id: detall amb providers i playable', async () => {
  const r = await fetch(`${base}/api/titles/tmdb-movie-1002`);
  const d = await json(r);
  assert.equal(r.status, 200);
  assert.equal(d.providers.length, 2);
  assert.equal(d.providers[0].name, 'Amazon Prime Video');
  assert.equal(d.providers[0].kind, 'flatrate');
  assert.equal(d.playable, false);
  assert.equal(d.has_ca, 1);
});

test('GET /api/titles/:id: títol lliure marcat com a reproduïble', async () => {
  const r = await fetch(`${base}/api/titles/tmdb-movie-1003`);
  const d = await json(r);
  assert.equal(r.status, 200);
  assert.equal(d.is_free, 1);
  assert.equal(d.playable, true);
});

test('Fonts pròpies: 3Cat apareix com a proveïdor gratuït amb URL directa', async () => {
  const r = await fetch(`${base}/api/titles/tmdb-movie-1001`);
  const d = await json(r);
  assert.equal(r.status, 200);
  const three = d.providers.find((p: { name: string }) => p.name === '3Cat');
  assert.ok(three);
  assert.equal(three.kind, 'free');
  assert.equal(three.url, 'https://www.3cat.cat/3cat/film-cata/');
  // amb font 3Cat → només queda l'enllaç de cerca de FilminCAT
  assert.equal(d.search_links.length, 1);
  assert.equal(d.search_links[0].name, 'FilminCAT');
  const r2 = await fetch(`${base}/api/titles/tmdb-movie-1002`);
  const d2 = await json(r2);
  assert.equal(d2.search_links[0].name, '3Cat');
  assert.equal(d2.search_links[1].name, 'FilminCAT');
});

test('GET /api/titles/:id: 404 per a inexistents', async () => {
  const r = await fetch(`${base}/api/titles/tmdb-movie-999999`);
  assert.equal(r.status, 404);
});

// ── Reproductor: només contingut lliure ─────────────────────────────────────

test('GET /api/titles/:id/stream: 404 per a contingut no lliure', async () => {
  const r = await fetch(`${base}/api/titles/tmdb-movie-1002/stream`);
  assert.equal(r.status, 404);
});

test('GET /api/titles/:id/tracks: 404 quan el fitxer lliure no existeix', async () => {
  const r = await fetch(`${base}/api/titles/tmdb-movie-1003/tracks`);
  assert.equal(r.status, 404);
});

// ── Progrés ─────────────────────────────────────────────────────────────────

test('POST/GET /api/progress: desa i recupera el progrés per títol', async () => {
  const uid = '00000000-0000-0000-0000-000000000001';
  const post = await fetch(`${base}/api/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Id': uid },
    body: JSON.stringify({ titleId: 'tmdb-movie-1002', positionSeconds: 300, completed: false }),
  });
  assert.equal(post.status, 204);

  const get = await fetch(`${base}/api/progress/tmdb-movie-1002`, { headers: { 'X-User-Id': uid } });
  const d = await json(get);
  assert.equal(d.position_seconds, 300);
  assert.equal(d.completed, false);
});

test('POST /api/progress: 400 per títol inexistent', async () => {
  const uid = '00000000-0000-0000-0000-000000000001';
  const r = await fetch(`${base}/api/progress`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Id': uid },
    body: JSON.stringify({ titleId: 'no-existeix', positionSeconds: 1 }),
  });
  assert.equal(r.status, 400);
});

test('GET /api/continue-watching: llista títols amb progrés', async () => {
  const uid = '00000000-0000-0000-0000-000000000001';
  const r = await fetch(`${base}/api/continue-watching`, { headers: { 'X-User-Id': uid } });
  const d = await json(r);
  assert.equal(d.length, 1);
  assert.equal(d[0].title_id, 'tmdb-movie-1002');
  assert.equal(d[0].episode_id, 'tmdb-movie-1002'); // compatibilitat client
});

// ── Watchlist ───────────────────────────────────────────────────────────────

test('Watchlist: afegir, llistar i treure', async () => {
  const uid = '00000000-0000-0000-0000-000000000001';
  const add = await fetch(`${base}/api/me/watchlist/tmdb-series-2001`, {
    method: 'POST',
    headers: { 'X-User-Id': uid },
  });
  assert.equal(add.status, 200);

  const list = await fetch(`${base}/api/me/watchlist`, { headers: { 'X-User-Id': uid } });
  const listData = await json(list);
  assert.equal(listData.length, 1);
  assert.equal(listData[0].tmdb_id, 2001);
  assert.equal(listData[0].type, 'series');

  const ids = await fetch(`${base}/api/me/watchlist/ids`, { headers: { 'X-User-Id': uid } });
  assert.deepEqual(await json(ids), ['tmdb-series-2001']);

  const del = await fetch(`${base}/api/me/watchlist/tmdb-series-2001`, {
    method: 'DELETE',
    headers: { 'X-User-Id': uid },
  });
  assert.equal(del.status, 200);
  const ids2 = await fetch(`${base}/api/me/watchlist/ids`, { headers: { 'X-User-Id': uid } });
  assert.deepEqual(await json(ids2), []);
});

// ── Auth i preferències ─────────────────────────────────────────────────────

test('POST /api/profiles + /api/login', async () => {
  const create = await fetch(`${base}/api/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Prova', password: 'secret123' }),
  });
  assert.equal(create.status, 201);
  const profile = await json(create);

  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Prova', password: 'secret123' }),
  });
  assert.equal(login.status, 200);
  const session = await json(login);
  assert.equal(session.id, profile.id);

  const bad = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Prova', password: 'equivocat' }),
  });
  assert.equal(bad.status, 401);
});

test('Validació de registre: nom curt, contrasenya curta i noms duplicats', async () => {
  const shortName = await fetch(`${base}/api/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'ab', password: 'secret123' }),
  });
  assert.equal(shortName.status, 400);

  const shortPass = await fetch(`${base}/api/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'usuari_valit', password: '123' }),
  });
  assert.equal(shortPass.status, 400);

  const invalidChars = await fetch(`${base}/api/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'nom amb espais!', password: 'secret123' }),
  });
  assert.equal(invalidChars.status, 400);

  const dup = await fetch(`${base}/api/profiles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'Prova', password: 'secret123' }),
  });
  assert.equal(dup.status, 409);
});

test('Renom del perfil: nom invàlid rebutjat', async () => {
  const uid = '00000000-0000-0000-0000-000000000001';
  const r = await fetch(`${base}/api/profiles/${uid}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'x' }),
  });
  assert.equal(r.status, 400);
});

test('Preferències: PUT + GET', async () => {
  const uid = '00000000-0000-0000-0000-000000000001';
  await fetch(`${base}/api/me/preferences`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-User-Id': uid },
    body: JSON.stringify({ show_anime: true }),
  });
  const r = await fetch(`${base}/api/me/preferences`, { headers: { 'X-User-Id': uid } });
  const d = await json(r);
  assert.equal(d.show_anime, true);
});

// ── Sincronització i stats ──────────────────────────────────────────────────

test('GET /api/sync/status + POST /api/sync sense clau no fallen', async () => {
  const st = await fetch(`${base}/api/sync/status`);
  const stData = await json(st);
  assert.equal(st.status, 200);
  assert.equal(stData.running, false);

  const trig = await fetch(`${base}/api/sync`, { method: 'POST' });
  assert.equal(trig.status, 200);
});

test('GET /api/stats: comptes del catàleg', async () => {
  const r = await fetch(`${base}/api/stats`);
  const d = await json(r);
  assert.equal(r.status, 200);
  assert.equal(d.titles, 5);
  assert.equal(d.movies, 3);
  assert.equal(d.series, 2);
  assert.equal(d.anime, 1);
  assert.equal(d.originalsCa, 1);
  assert.equal(d.free, 1);
});

test('Fallback API: 404 JSON', async () => {
  const r = await fetch(`${base}/api/inexistent`);
  assert.equal(r.status, 404);
  const d = await json(r);
  assert.ok(d.error);
});
