#!/bin/bash
# Backup diari de la base de dades de Hermes.
# Fa un snapshot consistent amb sqlite3 .backup (segur amb el servei en marxa)
# i conserva els últims 14 dies.
set -euo pipefail

DB_PATH="${DB_PATH:-/opt/hermes/data/hermes.db}"
BACKUP_DIR="${BACKUP_DIR:-/opt/hermes/data/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/hermes-$STAMP.db"

sqlite3 "$DB_PATH" ".backup '$OUT'"

# Verifica la còpia abans de tenir-la per bona
if ! sqlite3 "$OUT" "PRAGMA quick_check;" | grep -q '^ok$'; then
  echo "Backup invàlid: $OUT" >&2
  rm -f "$OUT"
  exit 1
fi

# Pruning: fora els backups de més de KEEP_DAYS dies
find "$BACKUP_DIR" -name 'hermes-*.db' -type f -mtime +"$KEEP_DAYS" -delete

echo "Backup fet: $OUT"
