# Hermes

**Plataforma de streaming en català.** Un catàleg de pel·lícules i sèries
**originals en català**, pensat per dir-te **on pots veure cada contingut
legalment** — 3Cat, FilminCAT, plataformes de subscripció, lloguer o compra —
amb la possibilitat de reproduir directament el contingut de **drets lliures**
que tinguis al disc.

## Què fa

- **Catàleg TMDb sincronitzat**: baixa automàticament totes les pel·lícules i
  sèries amb idioma original català, amb títols, sinopsi, pòsters i fons en català.
- **On veure-ho**: cada fitxa mostra on és disponible (proveïdors de TMDb per a
  la regió ES) i, mitjançant fonts pròpies, enllaços directes a 3Cat quan el
  contingut hi és gratuït.
- **Reproducció de contingut lliure**: els títols marcats com a `is_free` amb un
  fitxer local es reprodueixen al reproductor integrat (àudio alternatiu via
  remux ffmpeg, subtítols incrustats, velocitats, dreceres de teclat...).
- **Etiqueta d'anime**: detecció automàtica (gènere *Animació* + origen Japó),
  sense secció pròpia; es pot desactivar des del compte (toggle "Animes").
- **Comptes locals**: perfils amb contrasenya (scrypt), llista personal,
  continuació de reproducció i preferències.
- **PWA**: instal·lable al mòbil amb icona pròpia i càrrega offline bàsica.

## Stack

| Capa | Tecnologia |
|------|------------|
| Backend | Node.js + TypeScript + Express |
| Base de dades | SQLite (better-sqlite3, WAL) |
| Metadades | [The Movie Database (TMDb)](https://www.themoviedb.org/) API v3 |
| Transcodificació | ffmpeg/ffprobe (remux per a àudio alternatiu) |
| Frontend | SPA vanilla JS (sense frameworks) + Service Worker |
| Proxy | Nginx (vegeu `deploy/hermes.conf`) |
| Servei | systemd (vegeu `deploy/hermes.service`) |

## Posada en marxa

```bash
# 1. Dependències
npm install
apt install ffmpeg sqlite3

# 2. Variables d'entorn (cp .env.example .env si n'hi ha)
cat > .env <<'EOF'
PORT=3000
DB_PATH=/opt/hermes/data/hermes.db
REMUX_DIR=/opt/hermes/data/remux
TMDB_API_KEY=LA_TEVA_CLAU
EOF

# 3. Base de dades + catàleg
npm run db:init
npm run build && npm start
# El sincronitzador TMDb corre en segon pla: originals en català primer,
# després enriquiment (providers, detalls) i fonts externes (3Cat).

# 4. Proves
npm test
```

### Desplegament en producció

```bash
cp deploy/hermes.service /etc/systemd/system/
cp deploy/hermes-backup.service deploy/hermes-backup.timer /etc/systemd/system/
cp deploy/hermes.conf /etc/nginx/sites-available/hermes
ln -sf /etc/nginx/sites-available/hermes /etc/nginx/sites-enabled/hermes
systemctl daemon-reload
systemctl enable --now hermes hermes-backup.timer
nginx -t && systemctl reload nginx
```

El backup diari (03:30) fa un snapshot consistent de la BD a
`/opt/hermes/data/backups/` i en conserva 14 dies.

## Estructura

```
src/
  index.ts           # API REST + estàtics + streaming
  db.ts              # Esquema + consultes (catàleg, progrés, llista, preferències)
  auth.ts            # Perfils i contrasenyes (scrypt)
  catalog/
    sync.ts          # Sincronitzador TMDb (descobriment + enriquiment)
    sources.ts       # Fonts de "on veure-ho" (adaptador 3Cat)
  lib/
    ffmpeg.ts        # Pistes, subtítols i remux d'àudio alternatiu
    srt.ts           # Conversió SRT → WebVTT
public/
  index.html, app.js, style.css, sw.js, manifest.webmanifest, icones
deploy/
  hermes.service, hermes.conf, backup-db.sh, hermes-backup.{service,timer}
```

## Notes legals

- Hermes **no distribueix ni allotja** cap obra protegida per drets d'autor.
  És un catàleg que **enllaça** on veure cada contingut legalment.
- La reproducció integrada queda reservada a contingut de **drets lliures**
  (domini públic o llicències lliures) que l'explotador del servei allotgi.
- Les marques i catàlegs citats (3Cat, FilminCAT, Prime Video, Netflix...)
  pertanyen als seus titulars; els enllaços redirigeixen a les seves plataformes.

## Atribució

Aquest producte fa servir l'API de TMDb però no està avalat ni certificat per TMDb.

<a href="https://www.themoviedb.org/">
  <img src="https://www.themoviedb.org/assets/2/v4/logos/v2/blue_short_8x1.svg" alt="TMDb" height="20">
</a>
