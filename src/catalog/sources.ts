import type Database from 'better-sqlite3';
import * as dbq from '../db';

/**
 * Fonts externes de "on veure-ho en català".
 * Dissenyat per a diversos proveïdors: cada adaptador extreu el seu catàleg
 * i fa matching contra el catàleg TMDb local.
 *
 * - 3Cat: catàleg complet (pel·lícules + sèries) incrustat al __NEXT_DATA__
 *   de les pàgines tot-cataleg. Tot el contingut és gratuït i en català.
 * - FilminCAT: bloqueja peticions automatitzades (403) → de moment només
 *   enllaç de cerca per títol (el genera getTitle via search_links).
 */

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const PROVIDER = '3cat';
const KIND = 'free'; // tot el catàleg de 3Cat és gratuït

interface T3CatItem {
  titol?: string;
  nom_friendly?: string;
  entradeta?: string;
  tipologia?: string;
  imatges?: { text?: string; rel_name?: string }[];
}

interface ScrapeResult {
  movies: T3CatItem[];
  series: T3CatItem[];
}

async function fetchPage(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`3Cat HTTP ${res.status}`);
  return res.text();
}

function extractItems(html: string): T3CatItem[] {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
  if (!m) return [];
  let data: unknown;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return [];
  }
  const items: T3CatItem[] = [];
  // Els ítems viuen en mòduls amb propietat `items` (pel·lícules: llista plana
  // amb tipologia/titol; sèries: grups {valor, item: [...]}).
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) {
      for (const v of o) walk(v);
      return;
    }
    if (o && typeof o === 'object') {
      const rec = o as Record<string, unknown>;
      if (Array.isArray(rec.items)) {
        for (const it of rec.items) {
          if (it && typeof it === 'object') {
            const r = it as Record<string, unknown>;
            if (Array.isArray(r.item)) {
              // wrapper de grups per lletra (sèries)
              for (const sub of r.item) collect(sub);
            } else {
              collect(r);
            }
          }
        }
      }
      for (const v of Object.values(rec)) walk(v);
    }
  };
  const collect = (r: Record<string, unknown>): void => {
    if (typeof r.titol === 'string' && r.titol && (r.tipologia || r.nom_friendly || r.entradeta)) {
      items.push(r as T3CatItem);
    }
  };
  walk(data);
  return items;
}

function posterOf(it: T3CatItem): string | null {
  for (const img of it.imatges || []) {
    if (img.rel_name === 'IMG_POSTER' && img.text) return img.text;
  }
  return null;
}

function urlOf(it: T3CatItem): string {
  const q = encodeURIComponent(String(it.titol || ''));
  return it.nom_friendly
    ? `https://www.3cat.cat/3cat/${it.nom_friendly}/`
    : `https://www.3cat.cat/cercador/?text=${q}`;
}

function norm(s: string): string {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function dice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const bigrams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const bx = bigrams(a);
  const by = bigrams(b);
  let common = 0;
  for (const g of bx) if (by.has(g)) common++;
  return common / Math.max(bx.size, by.size);
}

async function scrape3Cat(): Promise<ScrapeResult> {
  const [moviesHtml, seriesHtml] = await Promise.all([
    fetchPage('https://www.3cat.cat/3cat/tot-cataleg/pellicules/'),
    fetchPage('https://www.3cat.cat/3cat/tot-cataleg/series/'),
  ]);
  return { movies: extractItems(moviesHtml), series: extractItems(seriesHtml) };
}

/** Índex de matching: títol normalitzat → llista de títols del catàleg local. */
interface CatalogIndexEntry {
  id: string;
  type: 'movie' | 'series';
  caNorm: string;
  origNorm: string;
}

function buildCatalogIndex(db: Database.Database): CatalogIndexEntry[] {
  const rows = db
    .prepare("SELECT id, type, catalan_title, original_title FROM titles WHERE type IN ('movie','series')")
    .all() as { id: string; type: string; catalan_title: string | null; original_title: string }[];
  return rows.map((r) => ({
    id: r.id,
    type: r.type === 'series' ? 'series' : 'movie',
    caNorm: norm(r.catalan_title || ''),
    origNorm: norm(r.original_title || ''),
  }));
}

function matchItem(it: T3CatItem, type: 'movie' | 'series', index: CatalogIndexEntry[]): string | null {
  const t = norm(String(it.titol || ''));
  if (!t) return null;
  // 1) coincidència exacta (ca o original)
  const exact = index.find((e) => e.type === type && (e.caNorm === t || e.origNorm === t));
  if (exact) return exact.id;
  // 2) aproximada: mateix tipus i Dice molt alt (evitem falsos positius)
  let best: { id: string; score: number } | null = null;
  for (const e of index) {
    if (e.type !== type) continue;
    const score = Math.max(dice(t, e.caNorm), dice(t, e.origNorm));
    if (!best || score > best.score) best = { id: e.id, score };
  }
  return best && best.score >= 0.88 ? best.id : null;
}

export async function sync3CatSources(db: Database.Database): Promise<{ movies: number; series: number; matched: number }> {
  const { movies, series } = await scrape3Cat();
  const index = buildCatalogIndex(db);
  let matched = 0;
  // Resetejar les fonts 3Cat antigues i tornar-les a crear (les URLs poden canviar)
  dbq.clearTitleSources(db, PROVIDER);
  for (const it of movies) {
    const titleId = matchItem(it, 'movie', index);
    if (titleId) {
      dbq.upsertTitleSource(db, { titleId, provider: PROVIDER, kind: KIND, url: urlOf(it) });
      matched++;
    }
  }
  for (const it of series) {
    const titleId = matchItem(it, 'series', index);
    if (titleId) {
      dbq.upsertTitleSource(db, { titleId, provider: PROVIDER, kind: KIND, url: urlOf(it) });
      matched++;
    }
  }
  dbq.setSyncState(db, 'sources_3cat_last_ok', new Date().toISOString());
  dbq.setSyncState(db, 'sources_3cat_stats', JSON.stringify({ movies: movies.length, series: series.length, matched }));
  return { movies: movies.length, series: series.length, matched };
}

export function sourceSyncStatus(db: Database.Database): Record<string, unknown> {
  return {
    last3CatOk: dbq.getSyncState(db, 'sources_3cat_last_ok'),
    stats3Cat: JSON.parse(dbq.getSyncState(db, 'sources_3cat_stats') || '{}'),
    counts: dbq.sourceStats(db),
  };
}
