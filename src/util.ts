import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function shortHash(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex').slice(0, 8);
}

/** Hash estable d'un fitxer a partir de path+mtime+size (NO del contingut). */
export function fileHash(filePath: string): string {
  const st = fs.statSync(filePath, { throwIfNoEntry: false });
  if (!st) return shortHash(filePath);
  return shortHash(`${filePath}|${Math.floor(st.mtimeMs / 1000)}|${st.size}`);
}

/** UUID estable derivat d'un valor (p. ex. una ruta), amb forma uuid v4. */
export function stableUuid(seed: string): string {
  const hex = crypto.createHash('md5').update(seed).digest('hex');
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return uuid.toLowerCase();
}

export function uuid(): string {
  return crypto.randomUUID();
}

export function nowSql(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export function escLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Carrega KEY=VALUE d'un fitxer .env sense sobreescriure variables ja presents. */
export function loadEnvFile(filePath: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v == null || v === '' ? fallback : v;
}

/** Normalitza text per a comparacions de títols (accent-insensible). */
export function normalizeName(s: string): string {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Similaritat per bigrames (coeficient de Dice): 0..1. */
export function diceSimilarity(a: string, b: string): number {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x && !y) return 1;
  if (!x || !y) return 0;
  const bigrams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const bx = bigrams(x);
  const by = bigrams(y);
  let common = 0;
  for (const g of bx) if (by.has(g)) common++;
  return common / Math.max(1, Math.min(bx.size + by.size, bx.size * 2) / 2);
}

/** Confiança (~0..1) entre el títol local i un canditat oficial. */
export function titleConfidence(local: string, official: string): number {
  const l = normalizeName(local);
  const o = normalizeName(official);
  if (!l || !o) return 0;
  if (l === o) return 1;
  if (l.startsWith(o) || l.endsWith(o) || o.startsWith(l) || o.endsWith(l)) {
    return Math.min(1, diceSimilarity(l, o) + 0.25);
  }
  return diceSimilarity(l, o);
}

export function isVideoFile(name: string): boolean {
  return /\.(mp4|mkv|avi|m4v|webm|ts|mov|mpg|mpeg|wmv|flv)$/i.test(name);
}

export function isSubtitleFile(name: string): boolean {
  return /\.(srt|ass|ssa|vtt)$/i.test(name);
}

export function hasSiblingSubtitle(videoPath: string): string | null {
  const base = videoPath.replace(/\.[^/.]+$/, '');
  for (const ext of ['.srt', '.ass', '.ssa', '.vtt']) {
    if (fs.existsSync(base + ext)) return base + ext;
  }
  return null;
}

/** Extreu "(AAAA)" del nom d'una carpeta/pel·lícula. */
export function extractYear(name: string): { base: string; year: number | null } {
  const m = name.match(/\((\d{4})\)/);
  if (m) {
    const base = name.slice(0, m.index).trim();
    return { base, year: Number(m[1]) };
  }
  return { base: name.trim(), year: null };
}

export function safeStat(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

export function ensureDir(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}