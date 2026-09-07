import type Database from 'better-sqlite3';
import { env } from '../util';
import * as dbq from '../db';
import { sync3CatSources } from './sources';

const BASE = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';
const REQ_DELAY_MS = 120; // ~8 peticions/s: lluny del límit de TMDb

const JP = 'JP';

/**
 * Gèneres TMDb → català (mapa estàtic per id: els gèneres són una llista
 * fixa i TMDb no en té traducció al català; amb language=ca-ES tornen anglesos).
 */
const GENRE_BY_ID: Record<number, string> = {
  28: 'Acció',
  12: 'Aventura',
  16: 'Animació',
  35: 'Comèdia',
  80: 'Crim',
  99: 'Documental',
  18: 'Drama',
  10751: 'Familiar',
  14: 'Fantasia',
  36: 'Història',
  27: 'Terror',
  10402: 'Música',
  9648: 'Misteri',
  10749: 'Romàntic',
  878: 'Ciència-ficció',
  10770: 'Pel·lícula de televisió',
  53: 'Thriller',
  10752: 'Bèl·lica',
  37: 'Western',
  10759: 'Acció i aventura',
  10762: 'Infantil',
  10763: 'Notícies',
  10764: 'Realitat',
  10765: 'Ciència-ficció i fantasia',
  10766: 'Telenovel·la',
  10767: 'Tertúlia',
  10768: 'Guerra i política',
};

interface DiscoverResult {
  id: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  genre_ids?: number[];
  origin_country?: string[];
  popularity?: number;
  vote_average?: number;
}

interface DetailsResult extends DiscoverResult {
  genres?: { id: number; name: string }[];
  origin_country?: string[];
  original_language?: string;
  production_countries?: { iso_3166_1: string }[];
  translations?: { translations: { iso_639_1: string; data?: Record<string, string | undefined> }[] };
  'watch/providers'?: { results: Record<string, unknown> };
}

function key(): string {
  const k = env('TMDB_API_KEY');
  if (!k) throw new Error('TMDB_API_KEY no configurada');
  return k;
}

async function tmdbJson(path: string, params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams({ api_key: key(), language: 'ca-ES', ...params });
  const res = await fetch(`${BASE}${path}?${qs}`, { signal: AbortSignal.timeout(15000) });
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after') || '2');
    await sleep(Math.min(30, retry) * 1000 + 250);
    return tmdbJson(path, params);
  }
  if (!res.ok) throw new Error(`TMDb HTTP ${res.status} a ${path}`);
  return res.json();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function yearOf(d: DiscoverResult): number | null {
  return Number((d.release_date || d.first_air_date || '').slice(0, 4)) || null;
}

function titleOf(d: DiscoverResult): string {
  return String(d.title || d.name || d.original_title || d.original_name || '');
}

function imgUrl(p: string | null | undefined, size: string): string | null {
  return p ? `${IMG}/${size}${p}` : null;
}

/** Ingesta mínima d'un resultat de discover (fase de descobriment). */
function ingestDiscover(db: Database.Database, r: DiscoverResult, kind: 'movie' | 'series', opts: { hasCa: number; originalLanguage: string | null }): void {
  const genres = (r.genre_ids || []).map((g) => GENRE_BY_ID[g]).filter(Boolean);
  const isAnime = genres.includes('Animació') && (kind === 'series' ? (r.origin_country || []).includes(JP) : false);
  dbq.upsertCatalogTitle(db, {
    tmdbId: r.id,
    type: kind,
    originalTitle: String(r.original_title || r.original_name || titleOf(r)),
    catalanTitle: titleOf(r) || null,
    year: yearOf(r),
    synopsisCa: r.overview || null,
    posterUrl: imgUrl(r.poster_path, 'w500'),
    backdropUrl: imgUrl(r.backdrop_path, 'w1280'),
    genres,
    originalLanguage: opts.originalLanguage,
    popularity: Number(r.popularity || 0),
    voteAverage: Number(r.vote_average || 0),
    hasCa: opts.hasCa,
    isAnime: isAnime ? 1 : 0,
    providerData: null,
    detailsSynced: 0,
  });
}

/**
 * Phase A: tots els originals en català (pel·lícules + sèries).
 * Descobriment paginat; es reprèn per la pàgina guardada a sync_state.
 */
async function syncOriginals(db: Database.Database): Promise<void> {
  for (const kind of ['movie', 'series'] as const) {
    const path = kind === 'movie' ? '/discover/movie' : '/discover/tv';
    const stateKey = `originals_${kind}_page`;
    const saved = dbq.getSyncState(db, stateKey);
    if (saved === 'done') continue; // ja completat: no rescanejar a cada arrencada
    let page = Number(saved || '1') || 1;
    let totalPages = 1;
    do {
      const d = (await tmdbJson(path, {
        with_original_language: 'ca',
        sort_by: 'popularity.desc',
        page: String(page),
      })) as { results: DiscoverResult[]; total_pages: number };
      totalPages = Math.min(500, d.total_pages || 1);
      for (const r of d.results || []) {
        ingestDiscover(db, r, kind, { hasCa: 1, originalLanguage: 'ca' });
      }
      dbq.setSyncState(db, stateKey, String(page));
      await sleep(REQ_DELAY_MS);
    } while (page++ < totalPages);
    dbq.setSyncState(db, stateKey, 'done');
  }
}

/**
 * Enriquiment (1 petició/títol amb append_to_response).
 * Afegeix: backdrop complet, gèneres oficials, país d'origen (anime),
 * traducció catalana del títol/sinopsi i providers de la regió ES.
 * Els títols que fallen queden pendents per al proper cicle diari.
 */
async function syncDetails(db: Database.Database): Promise<void> {
  const BATCH = 500;
  const failed = new Set<string>();
  for (;;) {
    const pending = dbq.pendingDetails(db, BATCH).filter((r) => !failed.has(r.id));
    if (!pending.length) break;
    for (const row of pending) {
      const kind = row.type === 'series' ? 'tv' : 'movie';
      try {
        const d = (await tmdbJson(`/${kind}/${row.tmdb_id}`, {
          append_to_response: 'translations,watch/providers',
        })) as DetailsResult;
        const genreList = (d.genres || []).map((g) => GENRE_BY_ID[g.id] || g.name).filter(Boolean);
        const countries = [...(d.origin_country || []), ...(d.production_countries || []).map((c) => c.iso_3166_1)];
        const isAnime = genreList.includes('Animació') && countries.includes(JP) ? 1 : 0;
        const caTr = (d.translations?.translations || []).find((t) => t.iso_639_1 === 'ca');
        const caTitle = caTr?.data?.title || caTr?.data?.name || null;
        const caOverview = caTr?.data?.overview || null;
        const esProviders = (d['watch/providers']?.results || {}).ES;
        dbq.upsertCatalogTitle(db, {
          tmdbId: row.tmdb_id,
          type: kind === 'movie' ? 'movie' : 'series',
          originalTitle: String(d.original_title || d.original_name || titleOf(d)),
          catalanTitle: caTitle,
          year: yearOf(d),
          synopsisCa: caOverview,
          posterUrl: imgUrl(d.poster_path, 'w500'),
          backdropUrl: imgUrl(d.backdrop_path, 'w1280'),
          genres: genreList,
          originalLanguage: d.original_language || null,
          popularity: Number(d.popularity || 0),
          voteAverage: Number(d.vote_average || 0),
          hasCa: caTr ? 1 : 0,
          isAnime,
          providerData: esProviders ? JSON.stringify(esProviders) : null,
          detailsSynced: 1,
        });
      } catch {
        // xarxa/TMDb caigut: el marquem com a fallit en aquesta execució per no
        // reintentar-lo en bucle; el proper cicle diari ho tornarà a provar.
        failed.add(row.id);
      }
      await sleep(REQ_DELAY_MS);
    }
  }
}

let syncRunning = false;

/** Executa un cicle complet de sincronització (idempotent i reprenible). */
export async function runCatalogSync(db: Database.Database): Promise<void> {
  if (syncRunning) return;
  if (!env('TMDB_API_KEY')) return;
  syncRunning = true;
  dbq.setSyncState(db, 'sync_last_run', new Date().toISOString());
  try {
    await syncOriginals(db);
    await syncDetails(db);
    dbq.setSyncState(db, 'sync_last_ok', new Date().toISOString());
    // Fonts externes de "on veure-ho": un cop el catàleg TMDb és al dia.
    try {
      await sync3CatSources(db);
    } catch (e) {
      dbq.setSyncState(db, 'sources_3cat_last_error', String((e as Error).message || e));
    }
  } catch (e) {
    dbq.setSyncState(db, 'sync_last_error', String((e as Error).message || e));
  } finally {
    syncRunning = false;
  }
}

/** Arrenca el sincronitzador: primer cicle en segon pla + repetició diària. */
export function startCatalogSync(db: Database.Database): void {
  setTimeout(() => {
    void runCatalogSync(db);
  }, 1500).unref();
  setInterval(() => {
    void runCatalogSync(db);
  }, 24 * 60 * 60 * 1000).unref();
}

export function syncStatus(db: Database.Database): Record<string, unknown> {
  return {
    running: syncRunning,
    lastRun: dbq.getSyncState(db, 'sync_last_run'),
    lastOk: dbq.getSyncState(db, 'sync_last_ok'),
    lastError: dbq.getSyncState(db, 'sync_last_error'),
    pendingDetails: dbq.countPendingDetails(db),
    originalsMoviePage: dbq.getSyncState(db, 'originals_movie_page'),
    originalsSeriesPage: dbq.getSyncState(db, 'originals_series_page'),
  };
}
