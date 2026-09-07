#!/usr/bin/env bash
# backup.sh — Copia de seguretat de la base de dades de Hermes.
#   - Fa un .backup consistent amb sqlite3 (segur mentre el servei escriu).
#   - Gzip i rotació: conserva les últimes 14 còpies.
# Ús recomanat (crontab):  0 3 * * * /opt/hermes/scripts/backup.sh
set -euo pipefail

DB="${DB_PATH:-/opt/hermes/data/hermes.db}"
BACKUP_DIR="${BACKUP_DIR:-/opt/hermes/data/.backup}"
KEEP="${KEEP:-14}"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "ERROR: sqlite3 no està instal·lat" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

# Evita execucions solapades (cron + manual)
LOCK="${BACKUP_DIR}/.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "Ja hi ha una còpia en marxa ($LOCK)" >&2
  exit 2
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

STAMP="$(date +%Y%m%d-%H%M%S)"
TMP="${BACKUP_DIR}/hermes.db.${STAMP}.backup"
FINAL="${TMP}.gz"

sqlite3 "$DB" ".backup '$TMP'"
gzip -f "$TMP"

# Rotació: conserva les KEEP còpies més recents
ls -1t "${BACKUP_DIR}"/hermes.db.*.backup.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

echo "OK: ${FINAL} ($(du -sh "$FINAL" | cut -f1))"
exit 0