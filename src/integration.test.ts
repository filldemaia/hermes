import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Proves d'integració extrem a extrem:
 *  - es genera un mp4 de prova (2 pistes d'àudio: aac + ac3, i 1 subtítol incrustat);
 *  - s'arrenca el servidor (dist/index.js) amb una BD temporal i un REMUX_DIR temporal;
 *  - es proven els fluxos de streaming (accel, remux amb Range, 404), pistes,
 *    subtítols incrustats i progress/watchlist.
 */

const FFMPEG = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const SKIP = FFMPEG ? false : 'cal ffmpeg per generar els fixtures';

const Database = require('better-sqlite3') as typeof import('better-sqlite3');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-it-'));
const mediaDir = path.join(tmp, 'media');
const remuxDir = path.join(tmp, 'remux');
const dbPath = path.join(tmp, 'test.db');
let server: {
  kill(signal?: NodeJS.Signals | number): void;
  stderr: NodeJS.ReadableStream | null;
} | null = null;
let port = 0;
let base = '';
let errLog = '';
let remuxBuilt = '';

function randomPort(): number {
  return 20000 + Math.floor(Math.random() * 30000);
}

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
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.mkdirSync(remuxDir, { recursive: true });

  const raw = path.join(tmp, 'raw.mp4');
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=64x64:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=800:duration=2',
    '-map', '0:v', '-map', '1:a', '-map', '2:a',
    '-c:v', 'libx264', '-preset', 'veryfast',
    '-c:a:0', 'aac', '-c:a:1', 'ac3',
    '-shortest', raw,
  ]);

  const srt = path.join(tmp, 'sub.srt');
  fs.writeFileSync(
    srt,
    '1\n00:00:00,000 --> 00:00:02,000\nHola, món!\n\n2\n00:00:00,300 --> 00:00:01,500\nSegona línia\n'
  );
  const mediaFile = path.join(mediaDir, 'film.mp4');
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-i', raw, '-i', srt,
    '-map', '0', '-map', '1',
    '-c', 'copy', '-c:s', 'mov_text',
    mediaFile,
  ]);

  const db = new Database(dbPath);
  const { initSchema } = require('./db') as { initSchema: (db: unknown) => void };
  initSchema(db as never);
  const insertTitle = db.prepare(
    "INSERT INTO titles (id, type, original_title, catalan_title, root_path, status, created_at, updated_at) VALUES (?, 'movie', ?, ?, ?, 'indexed', datetime('now'), datetime('now'))"
  );
  insertTitle.run('t1', 'Pel·lícula de prova', 'Pel·lícula de prova', mediaDir);
  db.prepare(
    "INSERT INTO episodes (id, title_id, season_number, episode_number, episode_title, file_path, subtitle_path, duration_seconds, file_hash, status, created_at, updated_at) VALUES (?, 't1', NULL, NULL, 'Film', ?, NULL, 2, 'abc12345', 'active', datetime('now'), datetime('now'))"
  ).run('e1', mediaFile);
  db.prepare(
    "INSERT INTO users (id, display_name, password_hash, created_at, updated_at) VALUES ('00000000-0000-0000-0000-000000000001', 'Usuari principal', NULL, datetime('now'), datetime('now'))"
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
      MEDIA_ROOT: mediaDir,
      REMUX_DIR: remuxDir,
      REQUIRE_MEDIA_ACCESS: '0',
      TMDB_API_KEY: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (server.stderr) server.stderr.on('data', (d) => { errLog += String(d); });
  base = `http://127.0.0.1:${port}`;
}

before(async () => {
  if (!FFMPEG) return;
  makeFixture();
  startServer();
  await waitReady(base + '/api/stats');
});

after(() => {
  if (server) server.kill('SIGKILL');
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('estadístiques: la BD de prova té el catàleg', { skip: SKIP }, async () => {
  const r = await fetch(base + '/api/stats');
  assert.equal(r.status, 200);
  const data = (await r.json()) as { titles?: number };
  assert.equal(data.titles, 1);
});

test('detall del títol: un episodi actiu sense progrés', { skip: SKIP }, async () => {
  const r = await fetch(base + '/api/titles/t1');
  assert.equal(r.status, 200);
  const data = (await r.json()) as { episodes: { id: string; status: string; progress: unknown }[] };
  assert.equal(data.episodes.length, 1);
  assert.equal(data.episodes[0].id, 'e1');
  assert.equal(data.episodes[0].progress, null);
});

test('pistes de l\u2019episodi: 2 àudios (aac + ac3) i 1 subtítol incrustat', { skip: SKIP }, async () => {
  const r = await fetch(base + '/api/episodes/e1/tracks');
  assert.equal(r.status, 200);
  const t = (await r.json()) as { audios: { index: number; codec: string }[]; subtitles: { index: number }[]; defaultAudioIndex: number | null };
  assert.equal(t.audios.length, 2);
  assert.equal(t.audios[0].codec, 'aac');
  assert.equal(t.audios[1].codec, 'ac3');
  assert.equal(t.subtitles.length, 1);
  assert.equal(t.defaultAudioIndex, t.audios[0].index);
});

test('stream per defecte: serialitza via X-Accel-Redirect', { skip: SKIP }, async () => {
  const r = await fetch(base + '/api/stream/e1');
  assert.equal(r.status, 200);
  assert.match(String(r.headers.get('x-accel-redirect') || ''), /internal-media\/film\.mp4/);
  assert.match(String(r.headers.get('content-type') || ''), /video\/mp4/);
});

test('stream amb àudio alternatiu (ac3): construeix el remux i el serveix (200)', { skip: SKIP }, async () => {
  const t = (await (await fetch(base + '/api/episodes/e1/tracks')).json()) as { audios: { index: number }[] };
  const ac3 = t.audios.find((a) => a.index !== t.audios[0].index)!;
  const r = await fetch(base + `/api/stream/e1?audio=${ac3.index}`);
  assert.equal(r.status, 200);
  assert.match(String(r.headers.get('content-type') || ''), /video\/mp4/);
  const out = path.join(remuxDir, 'abc12345_a' + ac3.index + '.mp4');
  assert.equal(fs.existsSync(out), true);
  assert.ok(fs.statSync(out).size > 1024, 'el remux en cache ha de ser vàlid (>1 KB)');
  remuxBuilt = out;
});

test('stream amb Range: 206 + Content-Range sobre el remux en cache', { skip: SKIP }, async () => {
  assert.ok(remuxBuilt, 'cal executar la prova de construcció abans');
  const r = await fetch(base + `/api/stream/e1?audio=2`, { headers: { Range: 'bytes=0-1023' } });
  assert.equal(r.status, 206);
  assert.match(String(r.headers.get('content-range') || ''), /^bytes 0-1023\//);
});

test('pista d\u2019àudio inexistent → 404', { skip: SKIP }, async () => {
  const r = await fetch(base + '/api/stream/e1?audio=99');
  assert.equal(r.status, 404);
});

test('subtítol incrustat → WebVTT extret', { skip: SKIP }, async () => {
  const t = (await (await fetch(base + '/api/episodes/e1/tracks')).json()) as { subtitles: { index: number }[] };
  const sub = t.subtitles[0];
  const r = await fetch(base + `/api/episodes/e1/subtitles/embedded/${sub.index}`);
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.match(text, /WEBVTT/);
});

test('subtítol incrustat inexistent → 404', { skip: SKIP }, async () => {
  const r = await fetch(base + '/api/episodes/e1/subtitles/embedded/42');
  assert.equal(r.status, 404);
});

test('progress: desar i recuperar posició del mateix usuari', { skip: SKIP }, async () => {
  const headers = { 'Content-Type': 'application/json', 'X-User-Id': '00000000-0000-0000-0000-000000000001' };
  const post = await fetch(base + '/api/progress', {
    method: 'POST',
    headers,
    body: JSON.stringify({ episodeId: 'e1', positionSeconds: 12, completed: false }),
  });
  assert.equal(post.status, 204);
  const get = await fetch(base + '/api/progress/e1', { headers });
  assert.equal(get.status, 200);
  const p = (await get.json()) as { position_seconds: number };
  assert.equal(p.position_seconds, 12);
});

test('watchlist: afegir, llistar i treure', { skip: SKIP }, async () => {
  const headers = { 'X-User-Id': '00000000-0000-0000-0000-000000000001' };
  const add = await fetch(base + '/api/me/watchlist/t1', { method: 'POST', headers });
  assert.equal((await add.json() as { saved: boolean }).saved, true);
  const ids = (await (await fetch(base + '/api/me/watchlist/ids', { headers })).json()) as string[];
  assert.deepEqual(ids, ['t1']);
  const del = await fetch(base + '/api/me/watchlist/t1', { method: 'DELETE', headers });
  const body = (await del.json()) as { saved?: boolean };
  assert.equal(body.saved, false);
});

test('stream amb pista aac (còdec copiat): el remux es genera a la cache', { skip: SKIP }, async () => {
  const t = (await (await fetch(base + '/api/episodes/e1/tracks')).json()) as { audios: { index: number; codec: string }[] };
  const aac = t.audios.find((a) => a.codec === 'aac')!;
  const r = await fetch(base + `/api/stream/e1?audio=${aac.index}`);
  assert.equal(r.status, 200);
  const out = path.join(remuxDir, 'abc12345_a' + aac.index + '.mp4');
  assert.equal(fs.existsSync(out), true);
  assert.ok(fs.statSync(out).size > 1024);
});