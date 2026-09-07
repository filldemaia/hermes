import { MetadataCandidate } from '../types';
import { env } from '../util';
import { mapGenres } from './meta';

const BASE = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';

export function tmdbEnabled(): boolean {
  return !!env('TMDB_API_KEY');
}

async function tmdbJson(path: string, params: Record<string, string>): Promise<unknown> {
  const key = env('TMDB_API_KEY');
  if (!key) throw new Error('TMDB_API_KEY no configurada');
  const qs = new URLSearchParams({ api_key: key, language: 'ca-ES', ...params });
  const res = await fetch(`${BASE}${path}?${qs}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
  return res.json();
}

function posterUrl(p: string | null | undefined): string | null {
  return p ? `${IMG}/w500${p}` : null;
}

function bannerUrl(p: string | null | undefined): string | null {
  return p ? `${IMG}/w1280${p}` : null;
}

interface TmdbSearchable {
  id: number;
  name?: string;
  title?: string;
  original_name?: string;
  original_title?: string;
  overview?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  genre_ids?: number[];
}

function toCandidate(r: TmdbSearchable, query: string, knownGenres: Record<number, string>): MetadataCandidate {
  const title = String(r.title || r.name || requestName(r));
  const year = Number((r.release_date || r.first_air_date || '').slice(0, 4)) || null;
  return {
    title,
    year,
    posterUrl: posterUrl(r.poster_path),
    bannerUrl: bannerUrl(r.backdrop_path),
    externalSource: 'tmdb',
    externalId: String(r.id),
    confidence: titleConfidenceSafe(query, title),
    ambiguous: false,
    genres: mapGenres((r.genre_ids || []).map((g) => knownGenres[g])),
    synopsis: r.overview || null,
  };
}

const requestName = (r: TmdbSearchable): string => String(r.original_title || r.original_name || '');

function titleConfidenceSafe(query: string, official: string): number {
  // evitem import circulars; càlcul local simplificat
  const q = String(query || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const o = String(official || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  if (!q || !o) return 0;
  if (q === o) return 1;
  const dice = (a: string, b: string) => {
    const s = new Set<string>();
    for (let i = 0; i < a.length - 1; i++) s.add(a.slice(i, i + 2));
    let c = 0;
    for (let i = 0; i < b.length - 1; i++) if (s.has(b.slice(i, i + 2))) c++;
    return c / Math.max(1, Math.min(b.length - 1, a.length - 1));
  };
  return Math.max(dice(q, o), 0);
}

let _genresCache: Record<number, string> | null = null;
async function genresMap(): Promise<Record<number, string>> {
  if (_genresCache) return _genresCache;
  try {
    const movie = (await tmdbJson('/genre/movie/list', {})) as { genres: { id: number; name: string }[] };
    const tv = (await tmdbJson('/genre/tv/list', {})) as { genres: { id: number; name: string }[] };
    const map: Record<number, string> = {};
    for (const g of [...movie.genres, ...tv.genres]) map[g.id] = g.name;
    _genresCache = map;
    return map;
  } catch {
    return {};
  }
}

export async function tmdbSearch(query: string, kind: 'movie' | 'tv'): Promise<MetadataCandidate[]> {
  const genres = await genresMap();
  const path = kind === 'movie' ? '/search/movie' : '/search/tv';
  const raw = (await tmdbJson(path, { query })) as { results: TmdbSearchable[] };
  const results = raw.results || [];
  const candidates = results.map((r) => toCandidate(r, query, genres));
  // Marcar ambigüitat quan els 2 millors són molt propers
  const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence);
  if (sorted.length >= 2 && sorted[0].confidence > 0 && sorted[1].confidence >= Math.max(0.55, sorted[0].confidence - 0.12)) {
    sorted[0].ambiguous = sorted[1].confidence > 0.45;
  }
  return candidates.slice(0, 8);
}

export async function tmdbDetails(id: string, kind: 'movie' | 'tv'): Promise<MetadataCandidate> {
  const genres = await genresMap();
  const r = (await tmdbJson(`/${kind === 'movie' ? 'movie' : 'tv'}/${id}`, {})) as TmdbSearchable & { genres?: { id: number; name: string }[] };
  const title = String(r.title || r.name || requestName(r));
  const genreNames = mapGenres((r.genres || []).map((g) => g.name));
  const year = Number((r.release_date || r.first_air_date || '').slice(0, 4)) || null;
  return {
    title,
    year,
    posterUrl: posterUrl(r.poster_path),
    bannerUrl: bannerUrl(r.backdrop_path),
    externalSource: 'tmdb',
    externalId: String(r.id),
    confidence: 1,
    ambiguous: false,
    genres: genreNames,
    synopsis: r.overview || null,
  };
}

/** Sinopsi en-US com a darrera xarxa (per a synopsis_fallback quan el català falta). */
export async function tmdbOverviewEn(id: string, kind: 'movie' | 'tv'): Promise<string | null> {
  const r = (await tmdbJson(`/${kind === 'movie' ? 'movie' : 'tv'}/${id}`, { language: 'en-US' })) as { overview?: string | null };
  return r.overview || null;
}