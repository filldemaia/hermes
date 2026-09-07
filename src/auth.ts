import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { uuid } from './util';

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, salt, hash] = stored.split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const calc = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(calc, 'hex'));
  } catch {
    return false;
  }
}

export function getUserById(db: Database.Database, id: string): { id: string; display_name: string } | null {
  return (db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(id) as { id: string; display_name: string }) || null;
}

export function getUserByName(db: Database.Database, name: string): { id: string; display_name: string; password_hash: string | null } | null {
  return (db.prepare('SELECT id, display_name, password_hash FROM users WHERE display_name = ? COLLATE NOCASE').get(name) as {
    id: string;
    display_name: string;
    password_hash: string | null;
  }) || null;
}

export interface MeInfo {
  id: string;
  display_name: string;
  photo: string | null;
  has_password: boolean;
}

export function getMe(db: Database.Database, id: string): MeInfo | null {
  const r = db.prepare('SELECT id, display_name, photo, password_hash FROM users WHERE id = ?').get(id) as
    | { id: string; display_name: string; photo: string | null; password_hash: string | null }
    | undefined;
  if (!r) return null;
  return { id: r.id, display_name: r.display_name, photo: r.photo, has_password: !!r.password_hash };
}

/** Actualitza nom i/o contrasenya del compte actiu. */
export function updateMe(
  db: Database.Database,
  id: string,
  update: { displayName?: string; password?: string | null }
): { ok: boolean; error?: string } {
  const me = db.prepare('SELECT id, display_name, password_hash FROM users WHERE id = ?').get(id) as
    | { id: string; display_name: string; password_hash: string | null }
    | undefined;
  if (!me) return { ok: false, error: 'Perfil no trobat' };

  if (update.displayName != null) {
    const name = update.displayName.trim();
    if (name !== me.display_name) {
      const existing = getUserByName(db, name);
      if (existing && existing.id !== id) return { ok: false, error: 'Aquest nom ja existeix' };
      db.prepare("UPDATE users SET display_name = ?, updated_at = datetime('now') WHERE id = ?").run(name, id);
    }
  }
  if (update.password != null && update.password !== '') {
    db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hashPassword(update.password), id);
  }
  return { ok: true };
}

/** Desa o elimina la foto de perfil (data URL). */
export function setPhoto(db: Database.Database, id: string, photo: string | null): void {
  db.prepare("UPDATE users SET photo = ?, updated_at = datetime('now') WHERE id = ?").run(photo, id);
}

export function listProfiles(db: Database.Database, currentId: string | null): { id: string; display_name: string; photo: string | null; current: boolean }[] {
  const rows = db.prepare('SELECT id, display_name, photo FROM users ORDER BY created_at ASC').all() as { id: string; display_name: string; photo: string | null }[];
  return rows.map((r) => ({ id: r.id, display_name: r.display_name, photo: r.photo, current: currentId != null && r.id === currentId }));
}

export function createProfile(db: Database.Database, name: string, password: string | null): { id: string; display_name: string } {
  const id = uuid();
  const password_hash = password ? hashPassword(password) : null;
  db.prepare('INSERT INTO users (id, display_name, password_hash) VALUES (?, ?, ?)').run(id, name.trim(), password_hash);
  return { id, display_name: name.trim() };
}

export function deleteProfile(db: Database.Database, id: string): boolean {
  const r = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return r.changes > 0;
}

export function renameProfile(db: Database.Database, id: string, newName: string): { ok: boolean; error?: string } {
  const name = newName.trim();
  if (!name) return { ok: false, error: 'El nom és obligatori' };
  const exists = getUserById(db, id);
  if (!exists) return { ok: false, error: 'Perfil no trobat' };
  if (getUserByName(db, name) && getUserByName(db, name)?.id !== id) {
    return { ok: false, error: 'Aquest nom ja existeix' };
  }
  db.prepare("UPDATE users SET display_name = ?, updated_at = datetime('now') WHERE id = ?").run(name, id);
  return { ok: true };
}