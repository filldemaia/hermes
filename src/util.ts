import fs from 'node:fs';
import crypto from 'node:crypto';

export function uuid(): string {
  return crypto.randomUUID();
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
