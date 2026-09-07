import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { env, normalizeName, isVideoFile, isSubtitleFile, hasSiblingSubtitle, extractYear, fileHash, stableUuid, safeStat } from '../util';
import { TitleType, ScanCounters } from '../types';
import * as db from '../db';
import * as ff from '../lib/ffmpeg';
import { anilistCandidates } from '../lib/anilist';
import { tmdbEnabled, tmdbSearch, tmdbOverviewEn } from '../lib/tmdb';

const VIDEO_EXT = /\.(mp4|mkv|avi|m4v|webm|ts|mov|mpg|mpeg|wmv|flv)$/i;
const SKIP_DIRS = new Set(['subtitles', 'captions', 'covers', '@eadir', '.thumbnails', 'thumbnails']);

export interface ParsedEpisode {
  season: number | null;
  ep: number | null;
  title: string | null;
  file: string;
  isVersion: boolean;
}

// ── Parsers ──────────────────────────────────────────────────────────────────

export function parseEpisode(base: string, titleName: string): ParsedEpisode | null {
  const m1 = base.match(/[Tt](\d{1,3})[xX](\d{1,3})(?!\d)/);
  if (m1) return { season: +m1[1], ep: +m1[2], title: null, file: base, isVersion: false };

  const m2 = base.match(/[Ss](\d{1,3})[Ee](\d{1,3})(?!\d)/);
  if (m2) return { season: +m2[1], ep: +m2[2], title: null, file: base, isVersion: false };

  if (/^\s*OVA\b/i.test(base) || base.includes('(OVA)')) {
    const rest = base.replace(/^\s*OVA\s*[-–—]\s*/i, '').replace(/\s*\(OVA\)\s*/i, '').trim();
    return { season: 0, ep: null, title: rest || 'OVA', file: base, isVersion: false };
  }

  if (/^\s*Episodi\b/i.test(base)) {
    const nm = base.match(/^\s*Episodi\s+(\d{1,3})\b/i);
    const rest = base
      .replace(/^\s*Episodi\s+(?:\d{1,3}\b)\s*\([^)]*\)\s*/i, '')
      .replace(/^\s*Episodi\s+(?:\d{1,3}\b)?\s*/i, '')
      .trim();
    return { season: 1, ep: nm ? +nm[1] : null, title: rest || base, file: base, isVersion: false };
  }

  const m3 = base.match(/-\s*(\d{1,3})\s*-\s*(.+)$/);
  if (m3) {
    return { season: null, ep: +m3[1], title: m3[2].trim() || null, file: base, isVersion: false };
  }

  const m4 = base.match(/-\s*(\d{1,3})\s*$/);
  if (m4) {
    const prefix = base.slice(0, m4.index).trim();
    const title = prefix && normalizeName(prefix) !== normalizeName(titleName) ? prefix : null;
    return { season: null, ep: +m4[1], title, file: base, isVersion: false };
  }

  return null;
}

export function looksLikeEpisode(base: string): boolean {
  return parseEpisode(base, '') !== null;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseMovieVersion(fileBase: string, titleBase: string): string {
  const stripped = fileBase.replace(/\s*\(\d{4}\)/, '');
  if (stripped === titleBase) return 'Pel·lícula';
  const m = stripped.match(new RegExp(`^${escapeRegExp(titleBase)}\\s*[-–—]\\s*(.+)$`));
  if (m && m[1].trim()) return m[1].trim();
  return fileBase;
}

async function probeDuration(filePath: string): Promise<number | null> {
  try {
    const { format } = await ff.probeFile(filePath);
    const d = Number(format.duration);
    return Number.isFinite(d) && d > 0 ? Math.round(d) : null;
  } catch {
    return null;
  }
}

export function ensureUniqueEpisodes(parsed: ParsedEpisode[]): void {
  const used = new Set<string>();
  for (const it of parsed) {
    if (it.season === null) continue; // versions/pel·lícula: sense numeració
    const key = `${it.season}:${it.ep ?? 0}`;
    if (used.has(key)) {
      let n = (it.ep ?? 1);
      while (used.has(`${it.season}:${n}`)) n++;
      it.ep = n;
    }
    used.add(key);
  }
}

export interface ScanOptions {
  jobId?: string;
  link?: boolean;
  mediaRoot?: string;
}

// ── Escaneig principal ───────────────────────────────────────────────────────

export async function runScan(dbConn: Database.Database, opts: ScanOptions = {}): Promise<ScanCounters> {
  const counters: ScanCounters = { newTitles: 0, updatedTitles: 0, missingEpisodes: 0, quarantined: 0, errors: [] };
  const mediaRoot = opts.mediaRoot || env('MEDIA_ROOT', '/srv/media');
  const roots: string[] = [];
  for (const cat of ['movies', 'anime', 'series', 'tv'] as const) {
    const p = path.join(mediaRoot, cat);
    if (safeStat(p)?.isDirectory()) roots.push(p);
  }
  if (!roots.length) {
    throw new Error(`Cap directori de media vàlid sota ${mediaRoot}`);
  }

  const livePaths = new Set<string>();

  const updateLive = (p: string) => livePaths.add(p);

  const handleVideo = async (
    titleId: string,
    videoPath: string,
    season: number | null,
    ep: number | null,
    epTitle: string | null
  ): Promise<void> => {
    const hash = fileHash(videoPath);
    let duration: number | null = null;
    try {
      duration = await probeDuration(videoPath);
    } catch (e) {
      counters.errors.push(`${videoPath}: ${(e as Error).message.slice(0, 120)}`);
    }
    const subtitle = hasSiblingSubtitle(videoPath);
    const prev = dbConn.prepare('SELECT id, status, duration_seconds, subtitle_path, episode_title FROM episodes WHERE file_hash = ?').get(hash) as
      | { id: string; status: string; duration_seconds: number | null; subtitle_path: string | null; episode_title: string | null }
      | undefined;
    const id = prev?.id || stableUuid(`ep:${videoPath}`);
    db.insertEpisode(dbConn, {
      id,
      title_id: titleId,
      season_number: season,
      episode_number: ep,
      episode_title: epTitle,
      file_path: videoPath,
      subtitle_path: subtitle,
      duration_seconds: duration,
      file_hash: hash,
    });
    const changed =
      !prev ||
      prev.status !== 'active' ||
      prev.duration_seconds !== duration ||
      prev.subtitle_path !== subtitle ||
      prev.episode_title !== epTitle;
    if (changed) {
      dbConn
        .prepare(
          "UPDATE episodes SET status='active', duration_seconds=?, subtitle_path=?, episode_title=?, file_path=?, file_hash=?, updated_at=datetime('now') WHERE id=?"
        )
        .run(duration, subtitle, epTitle, videoPath, hash, id);
    }
  };

  const processTitleDir = async (t: { titleId: string; name: string; dir: string }) => {
    const { base, year } = extractYear(t.name);
    const nameBase = base || t.name;
    updateLive(t.dir);

    const all = fs.readdirSync(t.dir, { withFileTypes: true });
    const videos = all
      .filter((e) => e.isFile() && isVideoFile(e.name))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, 'ca', { numeric: true }));

    // Tipus: el root decideix movie/anime_*; si el directori té 2+ fitxers amb
    // patró d'episodi, és una sèrie encara que sigui dins de movies/.
    const root = path.dirname(t.dir);
    const rootCat = path.basename(root);
    let type: TitleType;
    if (rootCat === 'anime') {
      type = videos.length > 1 ? 'anime_series' : 'anime_movie';
    } else {
      const manyEps = videos.length > 1 && videos.some((v) => looksLikeEpisode(v.replace(/\.[^/.]+$/, '')));
      type = manyEps ? 'series' : 'movie';
    }

    if (!videos.length) {
      const nonMedia = all.filter((e) => e.isFile() && !VIDEO_EXT.test(e.name) && !isSubtitleFile(e.name));
      for (const f of nonMedia) {
        const full = path.join(t.dir, f.name);
        const st = safeStat(full);
        if (st && st.size > 1_000_000) {
          db.quarantinePath(dbConn, full, 'Fitxer no multimèdia en directori de títol');
          counters.quarantined++;
        }
      }
      const prev = dbConn.prepare('SELECT id, status FROM titles WHERE id = ?').get(t.titleId) as { id: string; status: string } | undefined;
      db.insertTitle(dbConn, {
        id: t.titleId,
        type,
        original_title: nameBase,
        catalan_title: nameBase,
        year,
        root_path: t.dir,
        status: 'indexed',
        genres: [],
      });
      if (!prev) counters.newTitles++;
      else if (prev.status !== 'indexed') counters.updatedTitles++;
      counters.missingEpisodes += db.markMissingEpisodesFor(dbConn, t.titleId, new Set<string>());
      return;
    }

    // Parseem cada vídeo
    const parsed: ParsedEpisode[] = [];
    for (const v of videos) {
      const fbase = v.replace(/\.[^/.]+$/, '');
      const p = parseEpisode(fbase, nameBase);
      if (type === 'series' || type === 'anime_series') {
        if (p) parsed.push({ ...p, file: v });
        else parsed.push({ season: null, ep: null, title: fbase, file: v, isVersion: true });
      } else {
        // Pel·lícula: cada fitxer = versió
        parsed.push({ season: null, ep: null, title: parseMovieVersion(fbase, nameBase), file: v, isVersion: false });
      }
    }

    const prevTitle = dbConn.prepare('SELECT id, status, poster_url, genres, original_title FROM titles WHERE id = ?').get(t.titleId) as
      | { id: string; status: string; poster_url: string | null; genres: string; original_title: string }
      | undefined;
    const keepOriginal = prevTitle ? prevTitle.original_title : nameBase;
    const keepGenres = prevTitle
      ? (() => {
          try {
            return JSON.parse(prevTitle.genres);
          } catch {
            return [];
          }
        })()
      : [];
    db.insertTitle(dbConn, {
      id: t.titleId,
      type,
      original_title: keepOriginal,
      catalan_title: nameBase,
      year,
      root_path: t.dir,
      status: 'indexed',
      genres: keepGenres,
    });
    if (!prevTitle) counters.newTitles++;
    else if (prevTitle.status !== 'indexed') counters.updatedTitles++;

    ensureUniqueEpisodes(parsed);
    parsed.sort((a, b) => {
      const sa = a.season ?? 0;
      const sb = b.season ?? 0;
      if (sa !== sb) return sa - sb;
      const ea = a.ep ?? 9999;
      const eb = b.ep ?? 9999;
      if (ea !== eb) return ea - eb;
      return a.file.localeCompare(b.file, 'ca', { numeric: true });
    });
    const liveHashes = new Set<string>();
    for (const p of parsed) {
      const full = path.join(t.dir, p.file);
      liveHashes.add(fileHash(full));
      await handleVideo(t.titleId, full, p.season, p.ep, p.title);
    }
    counters.missingEpisodes += db.markMissingEpisodesFor(dbConn, t.titleId, liveHashes);
  };

  for (const root of roots) {
    const entries = fs.readdirSync(root);
    const files = entries.filter((e) => {
      const st = safeStat(path.join(root, e));
      return !!st?.isFile() && isVideoFile(e);
    });
    for (const f of files) {
      await processTitleDir({
        titleId: stableUuid(`title:${path.join(root, f)}`),
        name: f.replace(/\.[^/.]+$/, ''),
        dir: path.join(root, f),
      });
    }
    for (const d of entries) {
      if (SKIP_DIRS.has(normalizeName(d))) continue;
      const st = safeStat(path.join(root, d));
      if (!st?.isDirectory()) continue;
      await processTitleDir({
        titleId: stableUuid(`title:${path.join(root, d)}`),
        name: d,
        dir: path.join(root, d),
      });
    }
  }

  counters.missingEpisodes += db.markStaleTitles(dbConn, livePaths);
  return counters;
}

// ── Auto-enllaç de metadades (best-effort) ──────────────────────────────────

import { yearSimilarity, matchConfidence, isAmbiguous, MATCH_THRESHOLD } from '../lib/matcher';

async function synopsisFallbackIfEmpty(candidate: { synopsis: string | null; externalSource: string; externalId: string }, type: string): Promise<string | null | undefined> {
  if (candidate.synopsis || candidate.externalSource !== 'tmdb' || !tmdbEnabled()) return undefined;
  try {
    return await tmdbOverviewEn(candidate.externalId, type === 'series' ? 'tv' : 'movie');
  } catch {
    return undefined;
  }
}

export async function runMetaLink(dbConn: Database.Database): Promise<ScanCounters> {
  const counters: ScanCounters = { newTitles: 0, updatedTitles: 0, missingEpisodes: 0, quarantined: 0, errors: [] };
  const rows = dbConn
    .prepare(
      "SELECT id, type, original_title, catalan_title, year FROM titles WHERE status = 'indexed' AND (external_id IS NULL OR external_source IS NULL)"
    )
    .all() as { id: string; type: string; original_title: string; catalan_title: string | null; year: number | null }[];

  for (const t of rows) {
    const queryName = (t.catalan_title && t.catalan_title.trim()) || t.original_title.trim();
    if (!queryName) continue;
    try {
      const isAnime = t.type === 'anime_series' || t.type === 'anime_movie';
      let cands: Awaited<ReturnType<typeof anilistCandidates>> = [];
      if (isAnime) {
        cands = await anilistCandidates(queryName);
      } else if (tmdbEnabled()) {
        cands = await tmdbSearch(queryName, t.type === 'series' ? 'tv' : 'movie');
      } else {
        continue;
      }
      const best = cands[0];
      if (!best) continue;
      if (isAmbiguous(best, cands[1])) {
        // Ambiguïtat: ho deixem per a confirmació manual
        continue;
      }
      const conf = matchConfidence(queryName, t.year, best);
      if (conf < MATCH_THRESHOLD) continue;
      const synopsisFallback = await synopsisFallbackIfEmpty(best, t.type);
      db.confirmTitleMetadata(dbConn, t.id, {
        externalId: best.externalId,
        externalSource: best.externalSource,
        title: best.title,
        year: best.year,
        synopsis: best.synopsis,
        synopsisFallback: synopsisFallback ?? null,
        posterUrl: best.posterUrl,
        genres: best.genres,
        bannerUrl: best.bannerUrl,
      });
      dbConn.prepare('UPDATE titles SET original_title = ? WHERE id = ?').run(best.title, t.id);
      counters.updatedTitles++;
    } catch (e) {
      const msg = (e as Error).message;
      // Si la font de metadades està fora de servei (p. ex. AniList desactivat),
      // abandonem silenciosament l'enllaç automàtic — el títol queda "per confirmar".
      if (/temporarily disabled|maintenance/i.test(msg)) break;
      counters.errors.push(`${t.original_title}: ${msg.slice(0, 120)}`);
    }
  }
  return counters;
}

/**
 * Auto-enllaç de metadades (best-effort).
 * Intenta enllaçar títols sense metadades amb AniList/TMDb (només alta confiança).
 */