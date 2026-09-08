// Hermes — Frontend SPA (vanilla)
// Consumeix exclusivament l'API REST. Tota la UI en català.

const state = {
  section: 'inici',
  search: '',
  type: '',
  genre: '',
  year: '',
  page: 1,
  limit: 24,
  // Ids dels títols a la llista del compte (watchlist)
  watch: new Set()
};

const $ = (sel) => document.querySelector(sel);

/** Vista mòbil (barra inferior, sense topbar): mateix tall que el CSS. */
function isMobile() {
  return window.matchMedia('(max-width: 720px)').matches;
}

const GENRE_LABELS = {
  'Acció': 'Acció', 'Aventura': 'Aventura', 'Animació': 'Animació', 'Comèdia': 'Comèdia',
  'Crim': 'Crim', 'Documental': 'Documental', 'Drama': 'Drama', 'Familiar': 'Familiar',
  'Fantasia': 'Fantasia', 'Història': 'Història', 'Terror': 'Terror', 'Música': 'Música',
  'Misteri': 'Misteri', 'Romàntic': 'Romàntic', 'Ciència-ficció': 'Ciència-ficció',
  'Ciència-ficció i Fantasia': 'Ciència-ficció i fantasia', 'Ciència-ficció i fantasia': 'Ciència-ficció i fantasia', 'Pel·lícula de televisió': 'Pel·lícula de televisió',
  'Thriller': 'Thriller', 'Bélic': 'Bélic', 'Western': 'Western',
  'Acció i Aventura': 'Acció i Aventura', 'Infantil': 'Infantil', 'Notícies': 'Notícies',
  'Reality': 'Reality', 'Telenovel·la': 'Telenovel·la', 'Tertúlia': 'Tertúlia', 'Guerra i política': 'Guerra i política'
};

const TYPE_LABELS = {
  'movie': 'Pel·lícula',
  'series': 'Sèrie'
};

/** Missatge per als títols que encara no podem reproduir (drets no inclosos). */
const PLAY_UNAVAILABLE_TIP = 'No podem reproduir aquest contingut: no en tenim els drets. A «On veure-ho» trobaràs les plataformes on veure\'l legalment.';

/** Injecta un "episodi" sintètic quan el títol és reproduïble (contingut lliure amb fitxer). */
function withPlayableEpisode(title) {
  if (title.playable && (!title.episodes || !title.episodes.length)) {
    title.episodes = [{
      id: title.id,
      title_id: title.id,
      season_number: 0,
      episode_number: 0,
      episode_title: 'Vídeo',
      file_path: title.file_path,
      subtitle_path: null,
      progress: title.progress || null
    }];
  }
  return title;
}

/** Noms amigables dels proveïdors de streaming. */
const PROVIDER_LABELS = {
  'Amazon Prime Video': 'Prime Video',
  'Amazon Video': 'Prime Video',
  'Apple TV Store': 'Apple TV',
  'Apple TV+': 'Apple TV+',
  'Google Play Movies': 'Google Play',
  'YouTube Movies': 'YouTube',
  'Movistar Plus': 'Movistar+',
  'HBO Max': 'Max',
  'Netflix': 'Netflix',
  'Disney Plus': 'Disney+',
  'Filmin': 'FilminCAT',
  '3Cat': '3Cat'
};

const PROVIDER_KIND_LABELS = {
  'flatrate': 'Subscripció',
  'free': 'Gratuït',
  'rent': 'Lloguer',
  'buy': 'Compra'
};

function api(path) {
  return fetch(path, { headers: requestHeaders() }).then(r => {
    if (!r.ok) throw new Error(`Error HTTP ${r.status}`);
    return r.json();
  });
}

const PROFILE_KEY = 'hermes.activeProfile';
function requestHeaders(extra = {}) {
  const active = localStorage.getItem(PROFILE_KEY);
  return { 'X-User-Id': active || '', ...extra };
}

function toast(msg, type) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden', 'toast-success', 'toast-error');
  if (type === 'success') el.classList.add('toast-success');
  else if (type === 'error') el.classList.add('toast-error');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 2500);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

/* ── Icones SVG compartides (en lloc d'emojis) ── */
const ICON_HEART_FILL = '<svg class="heart" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
const ICON_HEART_EMPTY = '<svg class="heart" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
const ICON_PLAY_SMALL = '<span class="play-tri-ic"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="7,4 20,12 7,20"/></svg></span>';
const ICON_POSTER_PLACEHOLDER = '<svg class="poster-ph" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L7 20"/></svg>';
const ICON_CHEV_L = '<svg class="chev" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15,18 9,12 15,6"/></svg>';
const ICON_CHEV_R = '<svg class="chev" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9,18 15,12 9,6"/></svg>';
const ICON_STAR = '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/></svg>';

/* Esquelets de càrrega (shimmer) */
function skeletonGrid(n) {
  return caduceusLoader(n);
}

function skeletonDetail() {
  return caduceusLoader();
}

/** Indicador de càrrega: un caduceu gran al mig que passa de negre a platejat (<1 s per sentit). */
function caduceusLoader() {
  return `<div class="loader-wrap"><img class="caduceus-loader" src="/assets/caduceus.svg?v=30" alt="" aria-hidden="true"></div>`;
}

/** Targeta de "Continuar veient": porta als episodis en progrés. */
function continueCard(item) {
  const pct = item.duration_seconds && item.duration_seconds > 0
    ? Math.min(100, Math.round((item.position_seconds / item.duration_seconds) * 100))
    : 0;
  const poster = item.poster_url
    ? `<img class="card-poster" src="${escapeHtml(item.poster_url)}" alt="" loading="lazy">`
    : `<div class="card-poster placeholder">${ICON_POSTER_PLACEHOLDER}</div>`;
  return `
    <div class="card continue-card" data-episode="${item.episode_id}" role="button">
      <div class="card-poster-wrap">
        ${poster}
        <span class="continue-progress">${pct}%</span>
      </div>
      <div class="card-body">
        <div class="card-title">${escapeHtml(item.original_title)}</div>
        <div class="card-meta">${item.type === 'movie' ? 'Pel·lícula' : 'Sèrie'}</div>
      </div>
    </div>
  `;
}

function posterCard(t) {
  const poster = t.poster_url
    ? `<img class="card-poster" src="${escapeHtml(t.poster_url)}" alt="${escapeHtml(t.original_title)}" loading="lazy">`
    : `<div class="card-poster placeholder">${ICON_POSTER_PLACEHOLDER}</div>`;
  const saved = state.watch.has(t.id);
  const badges = [];
  if (t.is_anime) badges.push('<span class="card-badge badge-anime">Anime</span>');
  if (t.playable) badges.push('<span class="card-badge badge-free">Lliure</span>');
  return `
    <div class="card" data-id="${t.id}">
      <button class="watch-btn ${saved ? 'saved' : ''}" data-watch="${t.id}" title="${saved ? 'Treure de la meva llista' : 'Desa a la meva llista'}">
        <span class="watch-ico">${saved ? ICON_HEART_FILL : ICON_HEART_EMPTY}</span>
      </button>
      ${poster}
      ${badges.length ? `<div class="card-badges">${badges.join('')}</div>` : ''}
      <div class="card-body">
        <div class="card-title">${escapeHtml(t.catalan_title || t.original_title)}</div>
        <div class="card-meta">${escapeHtml(t.year || '')}</div>
      </div>
    </div>
  `;
}

/** Carrega els ids de la llista del compte actual. */
function loadWatchlist() {
  api('/api/me/watchlist/ids')
    .then(ids => { state.watch = new Set(ids); })
    .catch(() => {});
}

/** Alterna un títol a la llista del compte. */
async function toggleWatch(titleId, btn) {
  const isSaved = state.watch.has(titleId);
  const method = isSaved ? 'DELETE' : 'POST';
  try {
    const r = await fetch(`/api/me/watchlist/${titleId}`, { method, headers: { ...requestHeaders() } });
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    if (data.saved) state.watch.add(titleId); else state.watch.delete(titleId);
    if (btn) {
      btn.classList.toggle('saved', data.saved);
      btn.title = data.saved ? 'Treure de la meva llista' : 'Desa a la meva llista';
      btn.querySelector('.watch-ico').innerHTML = data.saved ? ICON_HEART_FILL : ICON_HEART_EMPTY;
    }
    toast(data.saved ? 'Afegit a la meva llista' : 'Tret de la meva llista', 'success');
  } catch (e) {
    console.error('Error watchlist:', e);
    toast('Error actualitzant la llista', 'error');
  }
}

function buildQuery(extra = {}) {
  const params = new URLSearchParams();
  if (state.search) params.set('q', state.search);
  if (state.type) params.set('type', state.type);
  if (state.genre) params.set('genre', state.genre);
  if (state.year) params.set('year', state.year);
  if (!showAnimeEnabled()) params.set('anime', '0');
  params.set('page', state.page);
  params.set('limit', state.limit);
  Object.entries(extra).forEach(([k, v]) => { if (v) params.set(k, v); });
  return params.toString();
}

/* ── Preferència: mostrar animes (toggle del compte) ── */
const ANIME_PREF_KEY = 'hermes.showAnime';
function showAnimeEnabled() {
  return localStorage.getItem(ANIME_PREF_KEY) !== '0';
}
function setShowAnime(on) {
  localStorage.setItem(ANIME_PREF_KEY, on ? '1' : '0');
  updateAnimeToggleUI();
  // Si hi ha sessió, persistim també al compte
  if (activeProfileId()) {
    fetch('/api/me/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...requestHeaders() },
      body: JSON.stringify({ show_anime: on })
    }).catch(() => {});
  }
  state.page = 1;
  renderLibrary();
}
function updateAnimeToggleUI() {
  const el = $('#settingsAnimeState');
  if (el) el.textContent = showAnimeEnabled() ? 'Activat' : 'Desactivat';
}

/** Sincronitza la preferència local amb la del compte en iniciar sessió. */
async function loadAnimePrefFromServer() {
  if (!activeProfileId()) return;
  try {
    const prefs = await api('/api/me/preferences');
    if (prefs && typeof prefs.show_anime === 'boolean') {
      localStorage.setItem(ANIME_PREF_KEY, prefs.show_anime ? '1' : '0');
      updateAnimeToggleUI();
    }
  } catch { /* sense sessió vàlida */ }
}

async function renderLibrary() {
  const content = $('#content');
  const sectionTitle = {
    'inici': 'Inici',
    'cataleg': 'Catàleg',
    'pel·lícules': 'Pel·lícules',
    'sèries': 'Sèries',
    'continuar': 'Continuar veient'
  }[state.section];

  if (state.section === 'inici') { renderWelcome(); return; }

  content.innerHTML = skeletonGrid(12);

  try {
    if (state.section === 'meva-llista') {
      await renderMyList();
      return;
    }
    if (state.section === 'usuari') {
      await renderUserPage();
      return;
    }
    if (state.section === 'continuar') {
      await renderContinueWatching();
      return;
    }

    // Pel·lícules / sèries sense cerca: fileres agrupades per categoria
    if ((state.section === 'pel·lícules' || state.section === 'sèries') && !state.search) {
      await renderCategoryPage(state.section === 'pel·lícules' ? 'movie' : 'series', sectionTitle);
      return;
    }

    let data;
    if (state.section === 'cataleg' && !state.search) {
      // Inici: carreguem més títols per omplir fileres i hero
      data = await api(`/api/titles?${buildQuery({ limit: 120, sort: 'popularity' })}`);
    } else {
      data = await api(`/api/titles?${buildQuery()}`);
    }

    if (state.section === 'cataleg' && !state.search) {
      await renderHome(data.data);
    } else {
      // Cerca: graella amb scroll infinit (les pòsters carreguen en entrar a la vista)
      const searchBar = isMobile() ? `
        <div class="search-inline">
          <input type="search" id="inlineSearch" value="${escapeHtml(state.search)}" placeholder="Cerca una pel·lícula, sèrie o programa emès en català..." enterkeyhint="search" autocomplete="off">
        </div>` : '';
      content.innerHTML = `${searchBar}<h1 class="page-title">${state.search ? 'Resultats de la cerca' : sectionTitle}</h1>`;
      setupInfiniteGrid(content, data);
      const inline = $('#inlineSearch');
      if (inline) {
        inline.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const q = inline.value.trim();
          if (q) { state.search = q; renderLibrary(); }
          else { state.search = ''; setSection('cataleg'); return; }
        });
      }
    }
  } catch (e) {
    console.error(e);
    content.innerHTML = `<div class="empty">No s'ha pogut carregar el catàleg: ${escapeHtml(e.message)}</div>`;
  }
}

/** Pàgina de secció (Pel·lícules / Sèries) amb fileres per categoria. */
async function renderCategoryPage(type, title) {
  const content = $('#content');
  content.innerHTML = `<h1 class="page-title">${title}</h1><div id="catRows">${caduceusLoader()}</div>`;
  const container = $('#catRows');
  const tType = type === 'movie' ? 'movie' : 'series';
  const animeQ = showAnimeEnabled() ? '' : '&anime=0';

  let genres = [];
  try {
    genres = await api(`/api/genres?type=${tType}`);
  } catch { /* sense gèneres: només la filera de populars */ }

  const rowsSpec = [
    { label: 'Més populars', query: `type=${tType}&sort=popularity&limit=40${animeQ}` },
    ...genres.map(g => ({
      label: `${g.genre}`,
      query: `type=${tType}&genre=${encodeURIComponent(g.genre)}&sort=popularity&limit=36${animeQ}`
    }))
  ];

  // Carreguem cada filera i l'anem afegint a mesura que arriba
  let added = 0;
  for (const spec of rowsSpec) {
    try {
      const d = await api(`/api/titles?${spec.query}`);
      if (d.data && d.data.length) {
        if (!added) container.innerHTML = ''; // fora el "Carregant..."
        container.insertAdjacentHTML('beforeend', rowSection(spec.label, d.data));
        added++;
      }
    } catch { /* fila opcional: la saltem */ }
  }
  if (!added) {
    container.innerHTML = '<div class="empty">No hi ha títols encara.</div>';
    return;
  }
  wireRowArrows(content);
}

/** Bloc de filera horitzontal de pòsters (amb fletxes de desplaçament). */
function rowSection(label, items) {
  return `
    <section class="row">
      <div class="row-head">
        <h2 class="row-title">${escapeHtml(label)}</h2>
        <div class="row-side">
          <span class="row-arrows">
            <button class="row-arrow" data-dir="-1" aria-label="Enrere">${ICON_CHEV_L}</button>
            <button class="row-arrow" data-dir="1" aria-label="Endavant">${ICON_CHEV_R}</button>
          </span>
        </div>
      </div>
      <div class="hscroll">${items.map(posterCard).join('')}</div>
    </section>
  `;
}

/** Activa les fletxes de totes les fileres del contenidor. */
function wireRowArrows(root) {
  root.querySelectorAll('.row-arrow').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const scroller = btn.closest('.row').querySelector('.hscroll');
      if (!scroller) return;
      const dir = Number(btn.dataset.dir);
      const step = Math.max(220, scroller.clientWidth * 0.8);
      scroller.scrollBy({ left: dir * step, behavior: 'smooth' });
    });
  });
}

/** Graella amb scroll infinit: afegeix pàgines quan l'usuari s'apropa al final. */
function setupInfiniteGrid(content, firstPage) {
  if (!firstPage.data.length) {
    content.insertAdjacentHTML('beforeend', '<div class="empty">No hi ha títols amb aquests filtres.</div>');
    return;
  }
  state.page = firstPage.page;
  content.insertAdjacentHTML('beforeend', `<div class="grid">${firstPage.data.map(posterCard).join('')}</div>`);
  if (firstPage.totalPages <= 1) return;

  const sentinel = document.createElement('div');
  sentinel.className = 'grid-sentinel';
  sentinel.innerHTML = '<div class="loading">Carregant més títols…</div>';
  content.appendChild(sentinel);

  const observer = new IntersectionObserver(async (entries) => {
    if (!entries[0].isIntersecting) return;
    if (sentinel.dataset.busy || sentinel.dataset.done) return;
    sentinel.dataset.busy = '1';
    try {
      const next = Number(state.page) + 1;
      const d = await api(`/api/titles?${buildQuery({ page: next })}`);
      state.page = next;
      sentinel.insertAdjacentHTML('beforebegin', `<div class="grid">${d.data.map(posterCard).join('')}</div>`);
      if (next >= d.totalPages || !d.data.length) {
        sentinel.dataset.done = '1';
        observer.disconnect();
        sentinel.remove();
      }
    } catch {
      sentinel.dataset.done = '1';
    } finally {
      delete sentinel.dataset.busy;
    }
  }, { rootMargin: '900px 0px' });
  observer.observe(sentinel);
}

/** Agrupa els títols en fileres (per tipus) per a la vista Inici. */
function groupRows(titles) {
  return [
    { key: 'pel·lícules', label: 'Pel·lícules', list: titles.filter(t => t.type === 'movie') },
    { key: 'sèries', label: 'Sèries', list: titles.filter(t => t.type === 'series') }
  ].filter(r => r.list.length);
}

/** Pàgina inicial (/): només benvinguda amb cerca gran i botó cap al catàleg. */
function renderWelcome() {
  const content = $('#content');
  content.innerHTML = `
    <section class="welcome welcome-revealed welcome-screen">
      <div class="welcome-inner">
        <span class="welcome-logo"><img class="caduceus-lg" src="/assets/caduceus.svg?v=30" alt="" aria-hidden="true">HERMES<img class="caduceus-lg caduceus-lg-trailing" src="/assets/caduceus.svg?v=30" alt="" aria-hidden="true"></span>
        <div class="search">
          <input type="search" id="searchInput" placeholder="Cerca una pel·lícula, sèrie o programa emès en català..." autocomplete="off" enterkeyhint="search">
        </div>
        <button class="btn-reveal" id="revealBtn">Veure més contingut</button>
      </div>
      <footer class="legal-footer">
        <p class="legal-note">
          Hermes no allotja ni distribueix contingut protegit: és un catàleg que enllaça
          la distribució legal de cada títol. Metadades i imatges per cortesia de
          <a href="https://www.themoviedb.org/" target="_blank" rel="noopener noreferrer">TMDb</a>.
          <a href="https://github.com/filldemaia/hermes" target="_blank" rel="noopener noreferrer">Codi font</a> · Llicència MIT.
        </p>
      </footer>
    </section>
  `;

  // ── Cerca de la benvinguda ──
  // Mòbil: vista a pantalla completa amb la barra a dalt de tot.
  // PC: els resultats surten en un desplegable sota la barra (el logo queda al seu lloc).
  {
    const searchItemHtml = (t) => `
      <button class="search-live-item" data-id="${t.id}">
        ${t.poster_url
          ? `<img src="${escapeHtml(t.poster_url)}" alt="" loading="lazy">`
          : '<span class="sl-ph"></span>'}
        <span class="sl-info">
          <span class="sl-title">${escapeHtml(t.catalan_title || t.original_title)}</span>
          <span class="sl-meta">${t.year ? escapeHtml(t.year) + ' · ' : ''}${t.type === 'movie' ? 'Pel·lícula' : 'Sèrie'}</span>
        </span>
      </button>`;

    const bindSearchItems = (container, onClose) => {
      container.querySelectorAll('.search-live-item').forEach(el => {
        el.onclick = () => { onClose(); renderDetail(el.dataset.id); };
      });
    };

    const searchQueryUrl = (q) =>
      `/api/titles?q=${encodeURIComponent(q)}&sort=popularity${showAnimeEnabled() ? '' : '&anime=0'}`;

    if (isMobile()) {
      content.insertAdjacentHTML('beforeend', `
        <div class="search-live hidden" id="searchLive">
          <div class="search-live-bar">
            <input type="search" id="searchLiveInput" placeholder="Cerca una pel·lícula, sèrie o programa emès en català..." autocomplete="off" enterkeyhint="search">
            <button class="search-live-close" id="searchLiveClose" aria-label="Tanca la cerca">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
          <div class="search-live-results" id="searchLiveResults"></div>
        </div>
      `);

      const liveWrap = $('#searchLive');
      const liveInput = $('#searchLiveInput');
      const resultsEl = $('#searchLiveResults');
      let liveTimer, liveSeq = 0;

      const closeSearchLive = () => {
        liveWrap.classList.add('hidden');
        resultsEl.innerHTML = '';
      };

      const runLiveSearch = async () => {
        const q = liveInput.value.trim();
        const seq = ++liveSeq;
        if (!q) { resultsEl.innerHTML = ''; return; }
        try {
          const d = await api(`${searchQueryUrl(q)}&limit=14`);
          if (seq !== liveSeq) return;
          resultsEl.innerHTML = d.data.length
            ? d.data.map(searchItemHtml).join('')
            : `<div class="search-live-empty">Cap resultat per «${escapeHtml(q)}»</div>`;
          bindSearchItems(resultsEl, closeSearchLive);
        } catch { /* xarxa: l'usuari seguirà escrivint */ }
      };

      // Tocar la barra de la benvinguda → cerca a pantalla completa
      $('#searchInput').addEventListener('focus', () => {
        $('#searchInput').blur(); // aquest input és només el gallet
        liveWrap.classList.remove('hidden');
        liveInput.value = $('#searchInput').value;
        liveInput.focus();
      });
      liveInput.addEventListener('input', () => {
        clearTimeout(liveTimer);
        liveTimer = setTimeout(runLiveSearch, 220);
      });
      liveInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { closeSearchLive(); return; }
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const q = liveInput.value.trim();
        if (q) { closeSearchLive(); state.search = q; setSection('cataleg', { keepSearch: true }); }
      });
      $('#searchLiveClose').addEventListener('click', closeSearchLive);
    } else {
      // PC: desplegable de resultats sota la barra de cerca
      const input = $('#searchInput');
      const wrap = input.closest('.search');
      const drop = document.createElement('div');
      drop.className = 'search-dropdown hidden';
      wrap.appendChild(drop);

      let pcTimer, pcSeq = 0;
      const runPcSearch = async () => {
        const q = input.value.trim();
        const seq = ++pcSeq;
        if (!q) { drop.classList.add('hidden'); drop.innerHTML = ''; return; }
        try {
          const d = await api(`${searchQueryUrl(q)}&limit=8`);
          if (seq !== pcSeq) return;
          drop.innerHTML = d.data.length
            ? d.data.map(searchItemHtml).join('')
            : `<div class="search-live-empty">Cap resultat per «${escapeHtml(q)}»</div>`;
          drop.classList.remove('hidden');
          bindSearchItems(drop, () => drop.classList.add('hidden'));
        } catch { /* xarxa: res */ }
      };

      input.addEventListener('input', () => {
        clearTimeout(pcTimer);
        pcTimer = setTimeout(runPcSearch, 220);
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { drop.classList.add('hidden'); return; }
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const q = input.value.trim();
        if (q) { drop.classList.add('hidden'); state.search = q; setSection('cataleg', { keepSearch: true }); }
      });
      document.addEventListener('click', (e) => {
        if (!wrap.contains(e.target)) drop.classList.add('hidden');
      });
    }
  }

  $('#revealBtn')?.addEventListener('click', (e) => {
    e.preventDefault();
    state.search = '';
    setSection('cataleg');
  });

}

/** Render de la pàgina d'Inici: continuar veient + hero destacat + fileres de contingut. */
async function renderHome(titles) {
  const content = $('#content');

  // La meva llista: títols desats del compte
  let watchRow = '';
  try {
    const saved = await api('/api/me/watchlist');
    if (saved.length) {
      watchRow = `
        <section class="row">
          <div class="row-head">
            <h2 class="row-title">La meva llista</h2>
            <div class="row-side">
              <span class="row-arrows">
                <button class="row-arrow" data-dir="-1" aria-label="Enrere">${ICON_CHEV_L}</button>
                <button class="row-arrow" data-dir="1" aria-label="Endavant">${ICON_CHEV_R}</button>
              </span>
            </div>
          </div>
          <div class="hscroll">${saved.map(posterCard).join('')}</div>
        </section>
      `;
    }
  } catch (e) { /* sense llista */ }

  // Últimes incorporacions al catàleg
  let newRows = '';
  try {
    const news = await api(`/api/titles?sort=new&limit=24${showAnimeEnabled() ? '' : '&anime=0'}`);
    if (news.data && news.data.length) {
      newRows = `
        <section class="row" data-group="nou">
          <div class="row-head">
            <h2 class="row-title">Nou al catàleg</h2>
            <div class="row-side">
              <span class="row-arrows">
                <button class="row-arrow" data-dir="-1" aria-label="Enrere">${ICON_CHEV_L}</button>
                <button class="row-arrow" data-dir="1" aria-label="Endavant">${ICON_CHEV_R}</button>
              </span>
            </div>
          </div>
          <div class="hscroll">${news.data.map(posterCard).join('')}</div>
        </section>
      `;
    }
  } catch (e) { /* sense novetats */ }

  // Continuar veient: episodis en progrés a l'Inici
  let contRow = '';
  try {
    const items = await api('/api/continue-watching');
    if (items.length) {
      contRow = `
        <section class="row">
          <div class="row-head">
            <h2 class="row-title">Continuar veient</h2>
            <span class="row-arrows">
              <button class="row-arrow" data-dir="-1" aria-label="Enrere">${ICON_CHEV_L}</button>
              <button class="row-arrow" data-dir="1" aria-label="Endavant">${ICON_CHEV_R}</button>
            </span>
          </div>
          <div class="hscroll">
            ${items.map(item => continueCard(item)).join('')}
          </div>
        </section>
      `;
    }
  } catch (e) { /* sense dades de progrés */ }

  const featured = titles.find(t => t.backdrop_url && (t.synopsis_ca || t.synopsis_fallback))
    || titles.find(t => t.backdrop_url)
    || titles.find(t => t.poster_url && (t.synopsis_ca || t.synopsis_fallback))
    || titles.find(t => t.poster_url)
    || titles[0];

  const heroBg = featured && (featured.backdrop_url || featured.poster_url)
    ? `background-image:url('${escapeHtml(featured.backdrop_url || featured.poster_url)}')`
    : '';

  const hero = featured ? `
    <section class="hero">
      <div class="hero-bg" style="${heroBg}"></div>
      <div class="hero-content">
        <span class="hero-badge">${featured.type && TYPE_LABELS[featured.type] ? escapeHtml(TYPE_LABELS[featured.type]) : 'Destacat'}</span>
        <h1 class="hero-title">${escapeHtml(featured.catalan_title || featured.original_title)}</h1>
        <div class="hero-meta">
          ${featured.year ? `<span>${escapeHtml(featured.year)}</span><span class="dot"></span>` : ''}
          ${featured.genres && featured.genres.length ? `<span>${escapeHtml((featured.genres.slice(0, 3).map(g => GENRE_LABELS[g] || g)).join(' · '))}</span>` : ''}
        </div>
        <p class="hero-synopsis">${escapeHtml((featured.synopsis_ca || featured.synopsis_fallback || '').slice(0, 220))}${(featured.synopsis_ca || featured.synopsis_fallback || '').length > 220 ? '…' : ''}</p>
        <div class="hero-actions">
          <button class="btn-play ${featured.playable ? '' : 'btn-unavailable'}" id="${featured.playable ? 'heroPlay' : 'heroPlayOff'}" data-id="${featured.id}" ${featured.playable ? '' : `title="${escapeHtml(PLAY_UNAVAILABLE_TIP)}"`}>${ICON_PLAY_SMALL} Reproductor</button>
          <button class="btn-arrow" id="heroDetails" data-id="${featured.id}">Detalls</button>
        </div>
      </div>
    </section>
  ` : '';

  const rows = groupRows(titles).map(row => `
    <section class="row" data-group="${escapeHtml(row.key)}">
      <div class="row-head">
        <h2 class="row-title">${escapeHtml(row.label)}</h2>
        <div class="row-side">
          <span class="row-arrows">
            <button class="row-arrow" data-dir="-1" aria-label="Enrere">${ICON_CHEV_L}</button>
            <button class="row-arrow" data-dir="1" aria-label="Endavant">${ICON_CHEV_R}</button>
          </span>
        </div>
      </div>
      <div class="hscroll">${row.list.map(posterCard).join('')}</div>
    </section>
  `).join('');

  content.innerHTML = `
    ${watchRow}
    ${hero}
    <div class="hero-rows">
      ${hero ? '' : '<h1 class="page-title">Catàleg</h1>'}
      ${rows || '<div class="empty">No hi ha títols encara.</div>'}
    </div>
    ${newRows}
    ${contRow}
  `;

  $('#heroPlay')?.addEventListener('click', async (e) => {
    const id = e.currentTarget.dataset.id;
    const title = withPlayableEpisode(await api(`/api/titles/${id}`));
    const playTarget = (title.episodes?.find(ep => !ep.progress || ep.progress.completed !== true) || title.episodes?.[0]);
    if (playTarget) openPlayer(playTarget.id, title);
    else toast(PLAY_UNAVAILABLE_TIP, 'error');
  });
  $('#heroPlayOff')?.addEventListener('click', () => toast(PLAY_UNAVAILABLE_TIP, 'error'));
  $('#heroDetails')?.addEventListener('click', (e) => renderDetail(e.currentTarget.dataset.id));

  // Fletxes de filera: mou el scroll horitzontal
  wireRowArrows(content);

  const search = $('#searchInput');
  if (search) {
    let t;
    search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => { state.search = search.value.trim(); state.page = 1; renderLibrary(); }, 350);
    });
  }
}



async function renderContinueWatching() {
  const content = $('#content');
  try {
    const items = await api('/api/continue-watching');
    if (!items.length) {
      content.innerHTML = '<h1 class="page-title">Continuar veient</h1><div class="empty">Encara no tens episodis en progrés.</div>';
      return;
    }
    content.innerHTML = '<h1 class="page-title">Continuar veient</h1>';
    const list = document.createElement('div');
    list.className = 'episode-list';
    list.innerHTML = items.map(it => `
      <div class="episode-item" data-episode="${it.episode_id}" data-titleid="${it.title_id}">
        <span class="episode-num">${it.type === 'movie' ? 'Pel·lícula' : 'Sèrie'}</span>
        <span class="episode-title"><strong>${escapeHtml(it.catalan_title || it.original_title)}</strong></span>
        <span class="episode-progress">${formatSeconds(it.position_seconds)}</span>
      </div>
    `).join('');
    content.appendChild(list);
    list.querySelectorAll('.episode-item[data-episode]').forEach(el => {
      el.onclick = async () => {
        const title = withPlayableEpisode(await api(`/api/titles/${el.dataset.titleid}`));
        if (title.episodes?.length) openPlayer(el.dataset.episode, title);
        else toast('Aquest contingut encara no és reproduïble', 'error');
      };
    });
  } catch (e) {
    content.innerHTML = `<div class="empty">Error: ${escapeHtml(e.message)}</div>`;
  }
}

function formatSeconds(sec) {
  sec = Math.floor(sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}min ${s}s`;
  return `${s}s`;
}

async function renderMyList() {
  const content = $('#content');
  try {
    const saved = await api('/api/me/watchlist');
    if (!saved.length) {
      content.innerHTML = '<h1 class="page-title">La meva llista</h1><div class="empty">Encara no has desat cap títol. Toca el cor d\'un pòster per desar-lo aquí.</div>';
      return;
    }
    content.innerHTML = `
      <h1 class="page-title">La meva llista</h1>
      <div class="grid">${saved.map(posterCard).join('')}</div>
    `;
  } catch (e) {
    content.innerHTML = `<div class="empty">Error carregant la llista: ${escapeHtml(e.message)}</div>`;
  }
}

/** Pàgina d'usuari: perfil + la seva llista + accés a la configuració. */
async function renderUserPage() {
  const content = $('#content');
  const uid = activeProfileId();

  if (!uid) {
    content.innerHTML = `
      <div class="user-page">
        <div class="user-head">
          <span class="user-avatar">?</span>
          <div class="user-head-info">
            <h1 class="user-name">Benvingut a Hermes</h1>
            <p class="user-sub">Crea un compte per guardar la teva llista, el progrés i les preferències.</p>
            <div class="user-actions">
              <button class="btn btn-play" id="userLoginBtn">Inicia sessió o registra't</button>
            </div>
          </div>
        </div>
      </div>`;
    $('#userLoginBtn').onclick = () => openAuth('login');
    return;
  }

  content.innerHTML = `
    <div class="user-page">
      <div class="user-head">
        <span class="user-avatar" id="userPageAvatar">?</span>
        <div class="user-head-info">
          <h1 class="user-name" id="userPageName">…</h1>
          <p class="user-sub">La teva llista i la teva configuració</p>
        </div>
        <button class="user-gear" id="userGearBtn" title="Configuració" aria-label="Configuració">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>
        </button>
      </div>
      <div id="userListWrap">${skeletonGrid(8)}</div>
    </div>`;

  try {
    const me = await api('/api/me');
    applyMeToUI(me);
    $('#userPageName').textContent = me.display_name;
    renderUserAvatar($('#userPageAvatar'), me);
  } catch { /* sessió caducada: seguim amb el cache local */ }

  try {
    const saved = await api('/api/me/watchlist');
    const wrap = $('#userListWrap');
    if (!saved.length) {
      wrap.innerHTML = '<h2 class="row-title" style="margin-top:1.4rem;">La meva llista</h2><div class="empty">Encara no has desat cap títol. Toca el cor d\'un pòster per desar-lo aquí.</div>';
    } else {
      wrap.innerHTML = `<h2 class="row-title" style="margin-top:1.4rem;">La meva llista</h2><div class="grid">${saved.map(posterCard).join('')}</div>`;
    }
  } catch (e) {
    $('#userListWrap').innerHTML = `<div class="empty">Error carregant la llista: ${escapeHtml(e.message)}</div>`;
  }

  $('#userGearBtn').onclick = () => openSettings();
}

/** Pinta un avatar (foto o inicial) en un contenidor. */
function renderUserAvatar(el, me) {
  if (!el) return;
  if (me && me.photo) {
    el.innerHTML = `<img src="${escapeHtml(me.photo)}" alt="">`;
    el.classList.add('has-photo');
  } else {
    const name = (me && me.display_name) || localStorage.getItem('hermes.activeName') || '?';
    el.textContent = profileInitial(name);
    el.classList.remove('has-photo');
  }
}

/** Aplica nom/foto de l'usuari a la navbar (PC) i a la barra inferior (mòbil). */
function applyMeToUI(me) {
  if (!me) return;
  localStorage.setItem('hermes.activeName', me.display_name);
  localStorage.setItem('hermes.activePhoto', me.photo || '');
  updateAuthUI();
}

/* ── Modal de configuració del compte ── */

let settingsMe = null;

function openSettings() {
  const overlay = $('#settingsOverlay');
  $('#settingsError').textContent = '';
  $('#settingsPassword').value = '';
  $('#settingsPassword2').value = '';
  $('#settingsNameHint').textContent = '';
  $('#settingsPasswordHint').textContent = '';
  $('#settingsConfirmHint').textContent = '';
  overlay.classList.remove('hidden');
  void (async () => {
    try {
      settingsMe = await api('/api/me');
    } catch {
      settingsMe = null;
    }
    if (!settingsMe) { overlay.classList.add('hidden'); return; }
    $('#settingsName').value = settingsMe.display_name;
    $('#photoRemove').hidden = !settingsMe.photo;
    renderUserAvatar($('#settingsAvatar'), settingsMe);
    $('#settingsAnimeState').textContent = showAnimeEnabled() ? 'Activat' : 'Desactivat';
  })();
}
function closeSettings() {
  $('#settingsOverlay').classList.add('hidden');
}

function settingsValidate() {
  const name = $('#settingsName').value.trim();
  if (!USERNAME_RE.test(name)) return 'El nom ha de tenir 3-20 caràcters: lletres, números, punt, guió o guió baix';
  const p1 = $('#settingsPassword').value;
  const p2 = $('#settingsPassword2').value;
  if (p1 && p1.length < 6) return 'La contrasenya ha de tenir com a mínim 6 caràcters';
  if (p1 && p1 !== p2) return 'Les contrasenyes no coincideixen';
  return null;
}

async function saveSettings() {
  const err = settingsValidate();
  if (err) { $('#settingsError').textContent = err; return; }
  $('#settingsError').textContent = '';
  const btn = $('#settingsSave');
  btn.disabled = true;
  try {
    const body = { displayName: $('#settingsName').value.trim() };
    const pwd = $('#settingsPassword').value;
    if (pwd) body.password = pwd;
    const me = await fetch('/api/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...requestHeaders() },
      body: JSON.stringify(body)
    }).then(r => r.json());
    if (me.error) throw new Error(me.error);
    settingsMe = me;
    applyMeToUI(me);
    if (state.section === 'usuari') renderLibrary();
    $('#settingsPassword').value = '';
    $('#settingsPassword2').value = '';
    toast('Canvis desats', 'success');
  } catch (e) {
    $('#settingsError').textContent = e.message || 'No s\'han pogut desar els canvis';
  } finally {
    btn.disabled = false;
  }
}

/** Redimensiona la imatge triada a 160×160 i la converteix en data URL. */
function readPhotoFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const size = 160;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        // retall quadrat centrat
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function initSettingsModal() {
  $('#settingsClose').onclick = closeSettings;
  $('#settingsOverlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeSettings(); });
  $('#settingsSave').addEventListener('click', saveSettings);
  $('#settingsAnimeToggle').addEventListener('click', () => {
    setShowAnime(!showAnimeEnabled());
    $('#settingsAnimeState').textContent = showAnimeEnabled() ? 'Activat' : 'Desactivat';
  });
  $('#settingsLogout').addEventListener('click', () => { closeSettings(); logout(); });
  $('#settingsEye').addEventListener('click', () => {
    const input = $('#settingsPassword');
    input.type = input.type === 'password' ? 'text' : 'password';
  });
  $('#settingsName').addEventListener('input', () => {
    const name = $('#settingsName').value.trim();
    const hint = $('#settingsNameHint');
    if (name && !USERNAME_RE.test(name)) {
      hint.textContent = '3-20 caràcters: lletres, números, punt, guió o guió baix';
      hint.classList.add('auth-hint-error');
    } else {
      hint.textContent = '';
      hint.classList.remove('auth-hint-error');
    }
  });
  const syncHints = () => {
    const p1 = $('#settingsPassword').value;
    const p2 = $('#settingsPassword2').value;
    const h1 = $('#settingsPasswordHint');
    const h2 = $('#settingsConfirmHint');
    if (p1 && p1.length < 6) {
      h1.textContent = 'Mínim 6 caràcters';
      h1.classList.add('auth-hint-error');
    } else { h1.textContent = ''; h1.classList.remove('auth-hint-error'); }
    if (p2 && p1 && p1 !== p2) {
      h2.textContent = 'No coincideixen';
      h2.classList.add('auth-hint-error');
    } else { h2.textContent = ''; h2.classList.remove('auth-hint-error'); }
  };
  $('#settingsPassword').addEventListener('input', syncHints);
  $('#settingsPassword2').addEventListener('input', syncHints);

  $('#photoInput').addEventListener('change', async () => {
    const file = $('#photoInput').files && $('#photoInput').files[0];
    if (!file) return;
    try {
      const dataUrl = await readPhotoFile(file);
      const r = await fetch('/api/me/avatar', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...requestHeaders() },
        body: JSON.stringify({ photo: dataUrl })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Error');
      settingsMe = d.photo !== undefined ? { ...settingsMe, photo: d.photo } : settingsMe;
      renderUserAvatar($('#settingsAvatar'), settingsMe);
      applyMeToUI(settingsMe);
      if (state.section === 'usuari') renderLibrary();
      $('#photoRemove').hidden = false;
      toast('Foto actualitzada', 'success');
    } catch (e) {
      toast(e.message || 'No s\'ha pogut pujar la foto', 'error');
    } finally {
      $('#photoInput').value = '';
    }
  });

  $('#photoRemove').addEventListener('click', async () => {
    try {
      const r = await fetch('/api/me/avatar', { method: 'DELETE', headers: requestHeaders() });
      if (!r.ok) throw new Error('Error');
      settingsMe = { ...settingsMe, photo: null };
      renderUserAvatar($('#settingsAvatar'), settingsMe);
      applyMeToUI(settingsMe);
      if (state.section === 'usuari') renderLibrary();
      $('#photoRemove').hidden = true;
      toast('Foto eliminada', 'success');
    } catch (e) {
      toast('No s\'ha pogut eliminar la foto', 'error');
    }
  });
}

async function renderDetail(id, opts) {
  opts = opts || {};
  if (opts.navigate !== false) navigateTo(`/detall/${encodeURIComponent(id)}`);
  const content = $('#content');
  content.innerHTML = skeletonDetail();
  try {
    const title = withPlayableEpisode(await api(`/api/titles/${id}`));
    const typeLabel = TYPE_LABELS[title.type] || title.type;
    const poster = title.poster_url
      ? `<img class="detail-poster" src="${escapeHtml(title.poster_url)}" alt="">`
      : `<div class="detail-poster placeholder" style="aspect-ratio:2/3;background:#1f1f33;display:flex;align-items:center;justify-content:center;"><div style="width:28%;color:#4a4a6a;">${ICON_POSTER_PLACEHOLDER.replace('<svg class="poster-ph" width="40" height="40"', '<svg class="poster-ph" width="100%" height="auto"')}</div></div>`;
    const playTarget = title.episodes?.[0];
    const rating = Number(title.vote_average || 0);
    const ratingHtml = rating > 0
      ? `<span class="meta-pill pill-rating">${ICON_STAR} ${rating.toFixed(1)}</span>`
      : '';

    // Bloc "On veure-ho": proveïdors amb àudio/subtítols en català (enllaç extern)
    const providers = title.providers || [];
    const providerRows = providers.map(p => {
      const name = PROVIDER_LABELS[p.name] || p.name;
      const kind = PROVIDER_KIND_LABELS[p.kind] || p.kind;
      return `<a class="episode-item provider-item" href="${escapeHtml(p.url || '#')}" target="_blank" rel="noopener noreferrer">
        <span class="episode-num">${escapeHtml(name)}</span>
        <span class="episode-title">${escapeHtml(kind)}</span>
        <span class="episode-progress">Obre-hi ${ICON_CHEV_R}</span>
      </a>`;
    }).join('');

    // Enllaços de cerca quan no tenim l'existència confirmada
    const searchLinks = (title.search_links || []).map(l => `
      <a class="episode-item provider-item" href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">
        <span class="episode-num">Cerca</span>
        <span class="episode-title">${escapeHtml(l.name)}</span>
        <span class="episode-progress">Obre-hi ${ICON_CHEV_R}</span>
      </a>`).join('');

    content.innerHTML = `
      <button class="btn-arrow" id="backBtn" style="margin-top:1rem;">${ICON_CHEV_L} Torna</button>
      <div class="detail" style="margin-top:0.6rem;">
        ${title.poster_url ? `<div class="detail-bg" style="background-image:url('${escapeHtml(title.poster_url)}')"></div>` : ''}
        ${poster}
        <div class="detail-info">
          <h1>${escapeHtml(title.catalan_title || title.original_title)}</h1>
          <div class="detail-meta">
            <span class="meta-pill">${escapeHtml(typeLabel)}</span>
            ${title.is_anime ? '<span class="meta-pill pill-anime">Anime</span>' : ''}
            ${title.year ? `<span class="meta-pill">${escapeHtml(title.year)}</span>` : ''}
            ${title.runtime ? `<span class="meta-pill">${title.runtime} min</span>` : ''}
            ${ratingHtml}
            ${title.original_title !== (title.catalan_title || title.original_title) ? `<span>${escapeHtml(title.original_title)}</span>` : ''}
          </div>
          ${(title.synopsis_ca || title.synopsis_fallback) ? `<p class="detail-synopsis">${escapeHtml(title.synopsis_ca || title.synopsis_fallback)}</p>` : ''}
          ${(title.genres && title.genres.length) ? `<div class="genres">${title.genres.map(g => `<span class="genre-tag">${escapeHtml(GENRE_LABELS[g] || g)}</span>`).join('')}</div>` : ''}
          <div class="detail-actions">
            ${playTarget
              ? `<button class="btn-play" id="playBtn" data-episode="${playTarget.id}">${ICON_PLAY_SMALL} Reproductor</button>`
              : `<button class="btn-play btn-unavailable" id="playBtnOff" title="${escapeHtml(PLAY_UNAVAILABLE_TIP)}">${ICON_PLAY_SMALL} Reproductor</button>`}
            <button class="btn-watch-detail ${state.watch.has(title.id) ? 'saved' : ''}" id="detailWatchBtn" data-watch-detail="${title.id}">
              <span class="win-ico">${state.watch.has(title.id) ? ICON_HEART_FILL : ICON_HEART_EMPTY}</span>
              <span class="win-txt">${state.watch.has(title.id) ? 'A la meva llista' : 'Desa a la meva llista'}</span>
            </button>
          </div>
        </div>
      </div>
      ${providers.length ? `
      <div class="episodes">
        <h2>On veure-ho en català</h2>
        <div class="episode-list">${providerRows}</div>
      </div>` : ''}
      ${searchLinks ? `
      <div class="episodes">
        <h2>No el trobes? Cerca'l aquí</h2>
        <div class="episode-list">${searchLinks}</div>
      </div>` : ''}
    `;

    $('#backBtn').onclick = () => {
    if (history.state && history.state.h && location.pathname !== '/') history.back();
    else if (history.length > 1) history.back();
    else setSection('inici');
  };
    $('#playBtn')?.addEventListener('click', (e) => openPlayer(e.currentTarget.dataset.episode, title));
    $('#playBtnOff')?.addEventListener('click', () => toast(PLAY_UNAVAILABLE_TIP, 'error'));
    $('#detailWatchBtn')?.addEventListener('click', async (e) => {
      const id = e.currentTarget.dataset.watchDetail;
      await toggleWatch(id, null);
      const saved = state.watch.has(id);
      e.currentTarget.classList.toggle('saved', saved);
      e.currentTarget.querySelector('.win-ico').innerHTML = saved ? ICON_HEART_FILL : ICON_HEART_EMPTY;
      e.currentTarget.querySelector('.win-txt').textContent = saved ? 'A la meva llista' : 'Desa a la meva llista';
    });
  } catch (e) {
    content.innerHTML = `<div class="empty">Error carregant el títol: ${escapeHtml(e.message)}</div>`;
  }
}

/** Reproducció directa des d'una targeta de "Continuar veient". */
async function openPlayerDirect(episodeId) {
  try {
    const items = await api('/api/continue-watching');
    const item = items.find(x => x.episode_id === episodeId);
    if (item) {
      const title = withPlayableEpisode(await api(`/api/titles/${item.title_id}`));
      if (title.episodes?.length) {
        openPlayer(episodeId, title);
        return;
      }
    }
  } catch (e) {
    console.error('Error obrint episodi:', e);
  }
  // Episodi no trobat o no reproduïble (per exemple en recarregar una URL directa)
  if (location.pathname.startsWith('/reproductor/')) navigateTo('/');
}

function stageEnterFullscreen() {
  const stage = $('#playerStage');
  try {
    if (stage.requestFullscreen) stage.requestFullscreen().catch(() => {});
    else {
      const v = window.__player && window.__player.video;
      if (v && v.webkitEnterFullscreen) v.webkitEnterFullscreen();
    }
  } catch (e) { /* no és fatal */ }
}

function stageToggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else stageEnterFullscreen();
}

function retryPlay(video) {
  const tryPlay = () => { const p = video.play(); if (p && p.catch) p.catch(() => {}); };
  tryPlay();
  if (!video.paused) return;
  const onceReady = () => { tryPlay(); video.removeEventListener('loadedmetadata', onceReady); };
  video.addEventListener('loadedmetadata', onceReady);
  const iv = setInterval(() => {
    if (!video.paused) { clearInterval(iv); return; }
    tryPlay();
  }, 300);
  setTimeout(() => clearInterval(iv), 4000);
}

/* ── Comportament global de la UI del reproductor ── */

let _hideTimer = null;
let _seekHintTimer = null;
let _lastPointerDown = { x: 0, y: 0 };

function menuOpen() {
  return ['menuAudio', 'menuSubs', 'menuSpeed', 'menuEpisodes'].some(id => {
    const el = document.getElementById(id);
    return el && !el.classList.contains('hidden');
  });
}

function playerControlsShow(persist) {
  clearTimeout(_hideTimer);
  $('#playerStage').classList.remove('controls-hidden');
  if (!persist) playerControlsScheduleHide();
}

function playerControlsHide() {
  const stage = $('#playerStage');
  if (stage.classList.contains('controls-hidden')) return;
  closePlayerMenus();
  stage.classList.add('controls-hidden');
}

function playerControlsScheduleHide(delay) {
  clearTimeout(_hideTimer);
  _hideTimer = setTimeout(() => {
    const p = window.__player;
    if (!p || !p.video || p.video.paused || p.video.ended) return;
    if (menuOpen()) { playerControlsShow(true); return; }
    $('#playerStage').classList.add('controls-hidden');
  }, delay || 3000);
}

function playerControlsToggle() {
  const stage = $('#playerStage');
  if (stage.classList.contains('controls-hidden')) playerControlsShow();
  else playerControlsHide();
}

function togglePlay(video) {
  if (!video) return;
  if (video.paused) video.play(); else video.pause();
  playerControlsShow();
}

function showSeekHint(text) {
  const el = $('#seekHint');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('hidden');
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(_seekHintTimer);
  _seekHintTimer = setTimeout(() => el.classList.add('hidden'), 800);
}

function seekRelative(video, delta) {
  if (!video || !isFinite(video.duration)) return;
  video.currentTime = Math.min(video.duration || 0, Math.max(0, (video.currentTime || 0) + delta));
  showSeekHint((delta < 0 ? '↶' : '↷') + ' ' + Math.abs(delta));
}

/* ── Volum (nivell global, recordat) ── */

const VOLUME_KEY = 'hermes_volume';
function loadVolume() {
  const v = parseFloat(localStorage.getItem(VOLUME_KEY));
  return isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}
function saveVolume(v) {
  try { localStorage.setItem(VOLUME_KEY, String(v)); } catch (e) { /* quota */ }
}
function setVolume(video, state, val) {
  val = Math.min(1, Math.max(0, val));
  state.volume = val;
  video.volume = val;
  if (val > 0 && state.muted) { state.muted = false; video.muted = false; }
  updateVolumeUI();
  saveVolume(val);
}
function toggleMute(video, state) {
  if (state.muted || state.volume <= 0) {
    state.muted = false;
    video.muted = false;
    if (state.volume <= 0) setVolume(video, state, 0.5);
  } else {
    state._prevVolume = state.volume;
    state.muted = true;
    video.muted = true;
  }
  updateVolumeUI();
  saveVolume(state.volume);
}
function updateVolumeUI() {
  const p = window.__player;
  if (!p) return;
  const st = p.state;
  const btn = $('#btnVolume');
  const slider = $('#volumeSlider');
  const shown = st.muted && st._prevVolume != null ? st._prevVolume : st.volume;
  const muted = st.muted || st.volume <= 0;
  let icon = ICON_MUTE;
  if (!muted) icon = shown <= 0.33 ? ICON_VOLUME_LOW : (shown <= 0.67 ? ICON_VOLUME : ICON_VOLUME_HIGH);
  if (btn) btn.innerHTML = icon;
  if (slider) slider.value = Math.round(shown * 100);
  setVolumeFill(Math.round(shown * 100));
}

/* ── Esdeveniments globals del reproductor (es vinculen una sola vegada) ── */

function initPlayerUI() {
  const stage = $('#playerStage');

  // Fullscreen real del navegador: Esc / botó del navegador mantenen la icona al dia
  document.addEventListener('fullscreenchange', () => {
    const btn = $('#btnFullscreen');
    if (btn) btn.innerHTML = document.fullscreenElement === stage ? ICON_FULLSCREEN_EXIT : ICON_FULLSCREEN;
    if (window.__player) playerControlsShow(true);
  });

  // Activitat del ratolí → controls visibles i reinicia el temporitzador d'amagat
  stage.addEventListener('pointermove', () => playerControlsShow());
  stage.addEventListener('pointerdown', () => playerControlsShow());

  // Mentre el ratolí és sobre els controls, no s'amaguen
  $('#playerControls').addEventListener('pointerenter', () => playerControlsShow(true));
  $('#playerControls').addEventListener('pointerleave', () => playerControlsShow());

  // En sortir del stage amb ratolí s'amaguen els controls (només punter fi)
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    stage.addEventListener('mouseleave', () => {
      const p = window.__player;
      if (!(p && p.video && p.video.paused)) playerControlsHide();
    });
  }

  // Clic amb ratolí sobre el vídeo = play/pausa (no interfereix amb el tàctil)
  stage.addEventListener('pointerdown', (e) => { _lastPointerDown = { x: e.clientX, y: e.clientY }; });
  stage.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'mouse') return;
    if (e.target.closest('.player-controls, .player-header, .player-menu, .volume-pop')) return;
    const dx = e.clientX - _lastPointerDown.x;
    const dy = e.clientY - _lastPointerDown.y;
    if (Math.hypot(dx, dy) > 10) return; // era un arrossegament
    const p = window.__player;
    if (p && p.video) togglePlay(p.video);
  });

  // Gestos tàctils: 1 toc → mostrar/amagar controls; doble toc → -10s | play/pausa | +10s
  let lastTap = 0, lastTapX = -1, lastTapY = -1, singleTimer = null;
  stage.addEventListener('touchend', (e) => {
    const touch = e.changedTouches && e.changedTouches[0];
    if (!touch) return;
    if (e.target.closest('.player-controls, .player-header, .player-menu, .volume-pop')) return;
    const r = stage.getBoundingClientRect();
    const x = touch.clientX - r.left;
    const y = touch.clientY - r.top;
    const now = Date.now();
    const isDouble = (now - lastTap < 300) && Math.abs(x - lastTapX) < 44 && Math.abs(y - lastTapY) < 44;
    lastTap = now; lastTapX = x; lastTapY = y;
    if (isDouble) {
      clearTimeout(singleTimer);
      const p = window.__player;
      if (!p || !p.video) return;
      const zone = x < r.width * 0.34 ? 'left' : x > r.width * 0.66 ? 'right' : 'center';
      if (zone === 'left') seekRelative(p.video, -10);
      else if (zone === 'right') seekRelative(p.video, 10);
      else togglePlay(p.video);
    } else {
      clearTimeout(singleTimer);
      singleTimer = setTimeout(() => playerControlsToggle(), 300);
    }
  }, { passive: true });

  // Volum: en ratolí el clic fa mute/unmute; en tàctil alterna el popup amb el slider
  const coarse = window.matchMedia('(pointer: coarse), (hover: none)').matches;
  const wrap = $('#volumeWrap');
  $('#btnVolume').onclick = (e) => {
    e.stopPropagation();
    const p = window.__player;
    if (!p) return;
    if (coarse) {
      closePlayerMenus();
      wrap.classList.toggle('open');
      if (wrap.classList.contains('open')) playerControlsShow(true);
    } else {
      toggleMute(p.video, p.state);
      playerControlsShow();
    }
  };
  $('#volumeSlider').oninput = (e) => {
    const p = window.__player;
    if (!p) return;
    setVolume(p.video, p.state, Number(e.target.value) / 100);
    playerControlsShow(true);
  };

  // Menús contextuals (àudio / subtítols / velocitat / episodis)
  [['btnAudio', 'menuAudio'], ['btnSubs', 'menuSubs'], ['btnSpeed', 'menuSpeed'], ['btnEpisodes', 'menuEpisodes']].forEach(([btnId, menuId]) => {
    const btn = $('#' + btnId);
    const menu = document.getElementById(menuId);
    btn.onclick = (e) => {
      e.stopPropagation();
      const isHidden = menu.classList.contains('hidden');
      closePlayerMenus();
      if (isHidden) menu.classList.remove('hidden');
      playerControlsShow(true);
    };
  });

  // Pantalla completa
  $('#btnFullscreen').onclick = () => { stageToggleFullscreen(); playerControlsShow(true); };

  // Botons ±10 s i play/pausa (usen el reproductor actiu)
  $('#btnPlay').onclick = () => { const p = window.__player; if (p) togglePlay(p.video); };
  $('#btnBack10').onclick = () => { const p = window.__player; if (p) seekRelative(p.video, -10); };
  $('#btnFwd10').onclick = () => { const p = window.__player; if (p) seekRelative(p.video, 10); };
}

async function openPlayer(episodeId, title) {
  const overlay = $('#playerOverlay');
  const video = $('#videoElement');
  const ep = title.episodes.find(x => x.id === episodeId);
  const isMovie = title.type === 'movie';
  $('#playerTitle').textContent = `${title.catalan_title || title.original_title}${ep && !isMovie && ep.episode_title ? ' — ' + ep.episode_title : ''}`;

  // Estat intern del reproductor actual
  const state = {
    episodeId,
    title,
    ep,
    isMovie,
    currentAudio: null,   // index de pista
    currentSub: null,     // clave: 'external' | 'embedded-<idx>' | null
    speed: 1,
    muted: false,
    volume: loadVolume(),
    tracks: null,
    prefs: {},
    nextEp: null,
    prevEp: null
  };

  // Ordenar episodis i calcular prev/next (només sèries)
  if (!isMovie && title.episodes && title.episodes.length) {
    const list = [...title.episodes].sort((a, b) =>
      (a.season_number || 0) - (b.season_number || 0) || (a.episode_number || 0) - (b.episode_number || 0));
    const idx = list.findIndex(e => e.id === episodeId);
    state.prevEp = idx > 0 ? list[idx - 1] : null;
    state.nextEp = idx > -1 && idx < list.length - 1 ? list[idx + 1] : null;
  }

  const epsBtn = $('#btnEpisodes');
  epsBtn.hidden = isMovie || !title.episodes || title.episodes.length <= 1;
  buildEpisodesMenu(state);

  overlay.classList.remove('hidden');
  closePlayerMenus();

  // Ruta dedicada al reproductor: URL pròpia i botó «enrere» que torna on eres
  const playerPath = `/reproductor/${encodeURIComponent(episodeId)}`;
  if (location.pathname !== playerPath) {
    if (location.pathname.startsWith('/reproductor/')) {
      history.replaceState({ h: (history.state && history.state.h) || '/' }, '', playerPath);
    } else {
      history.pushState({ h: location.pathname + location.search }, '', playerPath);
    }
  }

  // Exposar el reproductor actiu per als atalls de teclat globals
  window.__player = { video, state };

  // Reproducció immediata dins del gest de l'usuari (el reproductor omple el
  // viewport sense entrar en fullscreen real del navegador):
  // si esperem peticions asíncrones, el navegador pot bloquejar l'autoplay.
  setupVideoElement(video, state, ep);
  refreshAudioMenu(state, video);
  refreshSubsMenu(state, video, ep);
  refreshSpeedMenu(state, video);
  retryPlay(video);
  playerControlsShow();

  // Carregar pistes + preferències de l'usuari (en segon pla, un cop ja reprodueix)
  let tracks = null;
  try { tracks = await api(`/api/episodes/${episodeId}/tracks`); } catch (e) { /* ignore */ }
  state.tracks = tracks;
  try { state.prefs = await api('/api/me/preferences'); } catch (e) { state.prefs = {}; }

  // Pre-generar les pistes d'àudio alternatives en background (canvi instantani)
  if (tracks && tracks.audios && tracks.audios.length > 1) {
    fetch(`/api/episodes/${episodeId}/prefetch`, { method: 'POST', headers: requestHeaders() }).catch(() => {});
  }

  // Aplicar preferències desades (àudio / subs / velocitat) un cop carregades
  let audioChanged = false;
  if (state.prefs.audioIndex != null && tracks && tracks.audios.some(a => a.index === state.prefs.audioIndex) && state.currentAudio !== state.prefs.audioIndex) {
    state.currentAudio = state.prefs.audioIndex;
    audioChanged = true;
  }
  let subChanged = false;
  if (state.prefs.subtitles === 'external' && ep && ep.subtitle_path) {
    if (state.currentSub !== 'external') { state.currentSub = 'external'; subChanged = true; }
  } else if (state.prefs.subtitles && typeof state.prefs.subtitles === 'string' && state.prefs.subtitles.startsWith('embedded-') && tracks) {
    const idx = Number(state.prefs.subtitles.replace('embedded-', ''));
    if (tracks.subtitles.some(s => s.index === idx) && state.currentSub !== state.prefs.subtitles) { state.currentSub = state.prefs.subtitles; subChanged = true; }
  }
  if (state.prefs.speed) state.speed = state.prefs.speed;

  if (audioChanged || subChanged) {
    if (audioChanged) applyAudio(video, state);
    if (subChanged) {
      const track = document.querySelector('#subtitleTrack');
      applySubtitles(track, video, state, ep);
    } else {
      video.load();
    }
    retryPlay(video);
  } else {
    video.playbackRate = state.speed;
  }

  refreshAudioMenu(state, video);
  refreshSubsMenu(state, video, ep);
  refreshSpeedMenu(state, video);
}

/* ── Helpers i controls del reproductor ── */

function formatTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function langLabel(lang, fallback) {
  if (!lang) return fallback || 'Sense idioma';
  const map = { cat: 'Català', ca: 'Català', spa: 'Castellà', es: 'Castellà', eng: 'Anglès', en: 'Anglès', jpn: 'Japonès', ja: 'Japonès', fra: 'Francès', fr: 'Francès', deu: 'Alemany', de: 'Alemany', ita: 'Italià', it: 'Italià', por: 'Portuguès', pt: 'Portuguès' };
  return map[lang.toLowerCase()] || lang.toUpperCase();
}

function closePlayerMenus() {
  ['menuAudio', 'menuSubs', 'menuSpeed', 'menuEpisodes'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
}

function savePrefs(prefs) {
  fetch('/api/me/preferences', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...requestHeaders() },
    body: JSON.stringify(prefs)
  }).catch(e => console.error('Error desant preferències:', e));
}

function buildEpisodesMenu(state) {
  const menu = $('#menuEpisodes');
  const list = state.title.episodes && state.title.episodes.length ? [...state.title.episodes].sort((a, b) =>
    (a.season_number || 0) - (b.season_number || 0) || (a.episode_number || 0) - (b.episode_number || 0)) : [];
  menu.innerHTML =
    `<div class="menu-caption">Episodis</div>` +
    list.map(e => {
      const active = e.id === state.episodeId;
      const label = e.episode_title || `Episodi ${e.episode_number || e.id.slice(0, 6)}`;
      return `<button class="menu-item${active ? ' active' : ''}" data-ep="${e.id}"><span>${escapeHtml(label)}</span>${active ? '<span class="check"></span>' : ''}</button>`;
    }).join('');
  menu.querySelectorAll('[data-ep]').forEach(btn => {
    btn.onclick = () => {
      const target = btn.dataset.ep;
      const targetTitle = state.title;
      closePlayer();
      // Reactivar el reproductor amb el mateix títol però el nou episodi
      setTimeout(() => openPlayer(target, targetTitle), 60);
    };
  });
}

/* ── Icones SVG del reproductor ── */

const ICON_PLAY = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><polygon points="7,4 20,12 7,20"/></svg>';
const ICON_PAUSE = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
const ICON_VOLUME = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>';
const ICON_VOLUME_LOW = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><path d="M9.5 9.5a3 3 0 0 1 0 5"/></svg>';
const ICON_VOLUME_HIGH = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a8.5 8.5 0 0 1 0 13"/></svg>';
const ICON_MUTE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';

function setPlayIcon(paused) {
  const btn = $('#btnPlay');
  if (!btn) return;
  btn.innerHTML = paused ? ICON_PLAY : ICON_PAUSE;
}

function setVolumeIcon(muted) {
  const btn = $('#btnVolume');
  if (!btn) return;
  btn.innerHTML = muted ? ICON_MUTE : ICON_VOLUME;
}

function setProgressFill(pct) {
  const bar = $('#progressBar');
  if (!bar) return;
  bar.style.background = `linear-gradient(to right, var(--amber) ${pct}%, rgba(255,255,255,0.25) ${pct}%)`;
}

function setVolumeFill(pct) {
  const slider = $('#volumeSlider');
  if (!slider) return;
  slider.style.background = `linear-gradient(to right, var(--amber) ${pct}%, rgba(255,255,255,0.28) ${pct}%)`;
}

function setupVideoElement(video, state, ep) {
  // Netejar antics listeners/tracks globals
  $('#playerStage').classList.remove('controls-hidden');
  video.pause();

  // Restablir els controls a l'inici
  setPlayIcon(true);
  $('#ctrlTime').textContent = '0:00 / 0:00';
  $('#progressBar').value = 0;
  setProgressFill(0);
  video.volume = state.volume;
  video.muted = state.muted;
  updateVolumeUI();

  // Configurar la pista d'àudio i el src (remux si cal)
  applyAudio(video, state);

  // Crear el <track> de subtítols (prefixat)
  const oldTrack = document.querySelector('video#videoElement track');
  if (!oldTrack) {
    const t = document.createElement('track');
    t.id = 'subtitleTrack';
    t.kind = 'subtitles';
    video.appendChild(t);
  }

  const track = document.querySelector('#subtitleTrack');
  applySubtitles(track, video, state, ep);

  // Restaurar progrés (només just després d'obrir)
  if (ep && ep.progress && ep.progress.position_seconds > 0 && !ep.progress.completed) {
    const onLoaded = () => { video.currentTime = ep.progress.position_seconds; };
    video.addEventListener('loadedmetadata', onLoaded, { once: true });
  }

  // Temps / progrés / duració
  video.ontimeupdate = () => {
    $('#ctrlTime').textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
    if (video.duration) {
      const pct = (video.currentTime / video.duration) * 100;
      $('#progressBar').value = pct;
      setProgressFill(pct);
    }
  };
  $('#progressBar').oninput = (e) => {
    if (video.duration) {
      video.currentTime = (e.target.value / 100) * video.duration;
      setProgressFill(e.target.value);
    }
  };

  // Buffering
  const buff = $('#playerBuffering');
  video.onwaiting = () => { if (buff) buff.classList.remove('hidden'); };
  video.onplaying = () => { if (buff) buff.classList.add('hidden'); };

  video.onplay = () => { setPlayIcon(false); playerControlsShow(); };
  video.onpause = () => { setPlayIcon(true); playerControlsShow(true); };

  // Desar progrés periòdicament
  clearInterval(video._progressTimer);
  video._progressTimer = setInterval(() => {
    if (!video.paused && !video.ended && video.currentTime > 0) {
      const completed = video.duration && (video.duration - video.currentTime) < 5;
      postProgress(state.episodeId, video.currentTime, completed);
    }
  }, 5000);

  // Fi de la reproducció: desa progrés i avança al següent episodi (si n'hi ha)
  video.onended = () => {
    postProgress(state.episodeId, Math.floor(video.duration || 0), true);
    if (state.nextEp && window.__player && window.__player.state === state) {
      setTimeout(() => {
        if (window.__player && window.__player.state === state) openPlayer(state.nextEp.id, state.title);
      }, 1000);
    } else {
      playerControlsShow(true);
    }
  };

  video.playbackRate = state.speed;

  // Autoreproducció en obrir el reproductor
  const autoplay = () => { video.play().catch(() => {}); };
  if (video.readyState >= 1) autoplay();
  else video.addEventListener('loadedmetadata', autoplay, { once: true });

  video.focus();
}

/** Plega un menú i aplica la pista d'àudio sol·licitada (remux a demanda). */
function applyAudio(video, state) {
  const audioIndex = state.currentAudio;
  closePlayerMenus();
  if (audioIndex == null) {
    // Pista per defecte: fitxer original via Nginx
    video.src = `/api/stream/${state.episodeId}`;
    return;
  }
  // Seleccionar pista alternativa amb remux
  video.src = `/api/stream/${state.episodeId}?audio=${audioIndex}`;
}

/** Aplica els subtítols: cap/extern/incrustat. */
function applySubtitles(track, video, state, ep) {
  const key = state.currentSub;
  const position = video.currentTime;

  if (key == null) {
    track.removeAttribute('src');
    if (track.track) track.track.mode = 'disabled';
    return;
  }
  let src;
  if (key === 'external') {
    src = `/api/subtitles/${state.episodeId}`;
  } else {
    const idx = key.replace('embedded-', '');
    src = `/api/episodes/${state.episodeId}/subtitles/embedded/${idx}`;
  }
  // Si ja havíem començat a reproduir, conservem la posició (no reinicia).
  if (position > 0) {
    const onMeta = () => { video.currentTime = position; };
    video.addEventListener('loadedmetadata', onMeta, { once: true });
  }
  track.setAttribute('src', src);
  if (track.track) track.track.mode = 'showing';
  video.load();
}

/* ── Menús (construcció) ── */

function refreshAudioMenu(state, video) {
  const menu = $('#menuAudio');
  const btn = $('#btnAudio');
  const tracks = state.tracks;
  const audios = (tracks && tracks.audios) || [];

  if (audios.length <= 1) {
    btn.hidden = true;
    menu.innerHTML = '';
    return;
  }
  btn.hidden = false;
  btn.classList.toggle('active', state.currentAudio != null);

  const audioIndex = state.currentAudio;
  const defaultIdx = tracks && tracks.defaultAudioIndex;
  const activeKey = audioIndex != null ? audioIndex : defaultIdx;

  menu.innerHTML = `<div class="menu-caption">Pista d'àudio</div>` +
    audios.map(a => {
      const key = a.index;
      const isActive = key === activeKey;
      const label = langLabel(a.lang, `Pista ${a.index + 1}`) + (a.channels ? ` (${a.channels}.${a.channels > 2 ? '1' : '0'})` : '');
      return `<button class="menu-item${isActive ? ' active' : ''}" data-audio="${key}"><span>${escapeHtml(label)}</span>${isActive ? '<span class="check"></span>' : ''}</button>`;
    }).join('');

  menu.querySelectorAll('[data-audio]').forEach(item => {
    item.onclick = () => {
      const idx = Number(item.dataset.audio);
      state.currentAudio = idx;
      savePrefs({ audioIndex: idx, audioLang: (audios.find(a => a.index === idx) || {}).lang || null });
      applyAudio(video, state);
      refreshAudioMenu(state, video);
      playerControlsShow();
    };
  });
}

function refreshSubsMenu(state, video, ep) {
  const menu = $('#menuSubs');
  const btn = $('#btnSubs');
  const tracks = state.tracks;
  const embedded = (tracks && tracks.subtitles) || [];
  const hasExternal = !!(ep && ep.subtitle_path);

  const hasAny = hasExternal || embedded.length > 0;
  if (!hasAny) {
    btn.hidden = true;
    btn.classList.remove('active');
    menu.innerHTML = '';
    return;
  }
  btn.hidden = false;

  const current = state.currentSub;
  btn.classList.toggle('active', current != null);

  let html = `<div class="menu-caption">Subtítols</div>` +
    `<button class="menu-item${current == null ? ' active' : ''}" data-sub="off"><span>Desactivats</span>${current == null ? '<span class="check"></span>' : ''}</button>`;
  if (hasExternal) {
    const isActive = current === 'external';
    html += `<button class="menu-item${isActive ? ' active' : ''}" data-sub="external"><span>Subtítols externs</span>${isActive ? '<span class="check"></span>' : ''}</button>`;
  }
  embedded.forEach(s => {
    const key = `embedded-${s.index}`;
    const isActive = current === key;
    html += `<button class="menu-item${isActive ? ' active' : ''}" data-sub="${key}"><span>${escapeHtml(langLabel(s.lang, 'Incrustat') + (s.lang ? '' : ` ${s.index + 1}`))}</span>${isActive ? '<span class="check"></span>' : ''}</button>`;
  });
  menu.innerHTML = html;

  menu.querySelectorAll('[data-sub]').forEach(item => {
    item.onclick = () => {
      const val = item.dataset.sub;
      state.currentSub = val === 'off' ? null : val;
      savePrefs({ subtitles: state.currentSub });
      const track = document.querySelector('#subtitleTrack');
      applySubtitles(track, video, state, ep);
      refreshSubsMenu(state, video, ep);
      playerControlsShow();
    };
  });
}

function refreshSpeedMenu(state, video) {
  const menu = $('#menuSpeed');
  const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
  const label = $('#speedLabel');
  if (label) label.textContent = `${state.speed}×`;
  menu.innerHTML = `<div class="menu-caption">Velocitat</div>` +
    speeds.map(v => {
      const isActive = v === state.speed;
      return `<button class="menu-item${isActive ? ' active' : ''}" data-speed="${v}"><span>${v}×</span>${isActive ? '<span class="check"></span>' : ''}</button>`;
    }).join('');
  menu.querySelectorAll('[data-speed]').forEach(item => {
    item.onclick = () => {
      const val = Number(item.dataset.speed);
      state.speed = val;
      video.playbackRate = val;
      savePrefs({ speed: val });
      refreshSpeedMenu(state, video);
      playerControlsShow();
    };
  });
}

function postProgress(episodeId, positionSeconds, completed) {
  fetch('/api/progress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...requestHeaders() },
    body: JSON.stringify({ episodeId, positionSeconds: Math.floor(positionSeconds), completed: !!completed })
  }).then(r => { if (!r.ok) throw new Error(r.status); }).catch(e => console.error('Error desant progrés:', e));
}

function closePlayer() {
  const video = $('#videoElement');
  clearInterval(video._progressTimer);
  video.pause();
  video.removeAttribute('src');
  video.load();
  const stage = $('#playerStage');
  stage.classList.remove('controls-hidden');
  closePlayerMenus();
  const buff = $('#playerBuffering');
  if (buff) buff.classList.add('hidden');
  window.__player = null;
  const wasOpen = !$('#playerOverlay').classList.contains('hidden');
  $('#playerOverlay').classList.add('hidden');
  // Sortir de la pàgina dedicada del reproductor: tornar on era l'usuari
  // (només si el reproductor estava realment obert; si no, som en una navegació/recàrrega)
  if (wasOpen && location.pathname.startsWith('/reproductor/')) {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    const backState = history.state && history.state.h;
    if (backState && backState.startsWith('/')) history.back();
    else navigateTo('/');
  }
}

// ——— Perfils (RF-13) ———
// ——— Gestió del compte (perfils) ———
function activeProfileId() { return localStorage.getItem(PROFILE_KEY) || ''; }

function profileInitial(name) { return (name || '?').trim().charAt(0).toUpperCase() || '?'; }

// ── Inici de sessió / registre ──────────────────────────────────────
let authMode = 'login';

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,20}$/;

function setAuthMode(mode) {
  authMode = mode;
  const isSignup = mode === 'signup';
  $('#authTitle').textContent = isSignup ? 'Crea el teu compte' : 'Inicia sessió';
  $('#authSubmit').textContent = isSignup ? 'Registra\'t' : 'Inicia sessió';
  $('#authSwitch').textContent = isSignup ? 'Ja tens compte? Inicia sessió' : 'No tens compte? Registra\'t';
  $('#authPassword').autocomplete = isSignup ? 'new-password' : 'current-password';
  $('#confirmField').hidden = !isSignup;
}

function setPasswordVisible(visible) {
  for (const id of ['authPassword', 'authPassword2']) {
    const input = document.getElementById(id);
    if (input) input.type = visible ? 'text' : 'password';
  }
  for (const eye of [$('#passwordEye'), $('#passwordEye2')]) {
    if (eye) {
      eye.classList.toggle('active', visible);
      eye.setAttribute('aria-pressed', visible ? 'true' : 'false');
    }
  }
}

function openAuth(mode) {
  setAuthMode(mode);
  $('#authError').textContent = '';
  $('#authName').value = '';
  $('#authPassword').value = '';
  $('#authPassword2').value = '';
  $('#authConfirmHint').textContent = '';
  setAuthFieldHints();
  setPasswordVisible(false);
  $('#authOverlay').classList.remove('hidden');
  setTimeout(() => $('#authName').focus(), 30);
}
function closeAuth() {
  $('#authOverlay').classList.add('hidden');
}

/** Validació del formulari; retorna null si és correcte o el missatge d'error. */
function validateAuthForm() {
  const name = $('#authName').value.trim();
  const password = $('#authPassword').value;
  if (!name) return "Omple el nom d'usuari.";
  if (!USERNAME_RE.test(name)) return "El nom d'usuari ha de tenir 3-20 caràcters (lletres, números, punt, guió o guió baix).";
  if (!password) return 'Omple la contrasenya.';
  if (password.length < 6) return 'La contrasenya ha de tenir com a mínim 6 caràcters.';
  if (authMode === 'signup') {
    const confirm = $('#authPassword2').value;
    if (!confirm) return 'Confirma la contrasenya.';
    if (password !== confirm) return 'Les contrasenyes no coincideixen.';
  }
  return null;
}

function setAuthFieldHints() {
  // Missatges només quan el camp no compleix (res de text per defecte)
  const name = $('#authName').value.trim();
  const nameHint = $('#authNameHint');
  if (name && !USERNAME_RE.test(name)) {
    nameHint.textContent = "El nom ha de tenir 3-20 caràcters: lletres, números, punt, guió o guió baix";
    nameHint.classList.add('auth-hint-error');
  } else {
    nameHint.textContent = '';
    nameHint.classList.remove('auth-hint-error');
  }

  const p1 = $('#authPassword').value;
  const p1Hint = $('#authPasswordHint');
  if (p1 && p1.length < 6) {
    p1Hint.textContent = 'La contrasenya ha de tenir com a mínim 6 caràcters';
    p1Hint.classList.add('auth-hint-error');
  } else {
    p1Hint.textContent = '';
    p1Hint.classList.remove('auth-hint-error');
  }

  if (authMode === 'signup') {
    const p2 = $('#authPassword2').value;
    const cHint = $('#authConfirmHint');
    if (p2 && p1 && p1 !== p2) {
      cHint.textContent = 'Les contrasenyes no coincideixen';
      cHint.classList.add('auth-hint-error');
    } else {
      cHint.textContent = '';
      cHint.classList.remove('auth-hint-error');
    }
  }
}
function setSession(id, name) {
  localStorage.setItem(PROFILE_KEY, id);
  localStorage.setItem('hermes.activeName', name);
  loadWatchlist();
  loadAnimePrefFromServer();
  updateAuthUI();
  setSection('inici');
}
function logout() {
  localStorage.removeItem(PROFILE_KEY);
  localStorage.removeItem('hermes.activeName');
  localStorage.removeItem('hermes.activePhoto');
  updateAuthUI();
  applyRoute();
}
async function submitAuth() {
  const clientError = validateAuthForm();
  if (clientError) {
    $('#authError').textContent = clientError;
    return;
  }
  const name = $('#authName').value.trim();
  const password = $('#authPassword').value;
  $('#authError').textContent = '';
  const url = authMode === 'signup' ? '/api/profiles' : '/api/login';
  const btn = $('#authSubmit');
  btn.disabled = true;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...requestHeaders() },
      body: JSON.stringify({ displayName: name, password })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Error ${r.status}`);
    closeAuth();
    setSession(data.id, data.display_name || name);
  } catch (e) {
    $('#authError').textContent = e.message || 'Ha fallat la connexió. Torna-ho a provar.';
  } finally {
    btn.disabled = false;
  }
}
function updateAuthUI() {
  const logged = activeProfileId();
  $('#guestMenu').toggleAttribute('hidden', !!logged);
  $('#accountMenu').toggleAttribute('hidden', !logged);
  const photo = localStorage.getItem('hermes.activePhoto') || '';
  if (logged) {
    const name = localStorage.getItem('hermes.activeName') || 'Compte';
    renderUserAvatar($('#avatarLetter'), { display_name: name, photo });
    $('#profileName').textContent = name;
    const bu = $('#bottomUserLabel');
    if (bu) bu.textContent = name;
    renderUserAvatar($('#bottomAvatar'), { display_name: name, photo });
  } else {
    const bu = $('#bottomUserLabel');
    if (bu) bu.textContent = 'Usuari';
    renderUserAvatar($('#bottomAvatar'), null);
  }
}

// Navegació
const SECTION_ROUTES = {
  'inici': '/',
  'cataleg': '/cataleg',
  'pel·lícules': '/pelicules',
  'sèries': '/series',
  'continuar': '/continuar',
  'meva-llista': '/meva-llista',
  'usuari': '/usuari'
};
const ROUTE_SECTIONS = Object.fromEntries(Object.entries(SECTION_ROUTES).map(([k, v]) => [v, k]));

function routeForSection(section) { return SECTION_ROUTES[section] || '/'; }

function navigateTo(path, replace) {
  path = path || '/';
  if (location.pathname === path) return;
  const method = replace ? 'replaceState' : 'pushState';
  history[method]({ h: path }, '', path);
}

/** Render de la vista segons la ruta actual. */
function applyRoute() {
  const path = location.pathname || '/';
  if (typeof closePlayer === 'function') closePlayer();
  const player = path.match(/^\/reproductor\/(.+)$/);
  if (player) {
    openPlayerDirect(decodeURIComponent(player[1]));
    return;
  }
  const detail = path.match(/^\/detall\/(.+)$/);
  if (detail) {
    renderDetail(decodeURIComponent(detail[1]), { navigate: false });
    return;
  }
  const section = ROUTE_SECTIONS[path] || 'inici';
  setSection(section, { navigate: false });
}

function setSection(section, opts) {
  opts = opts || {};
  state.section = section;
  state.page = 1;
  document.body.classList.toggle('on-home', section === 'inici');
  document.querySelectorAll('.section-link').forEach(b =>
    b.classList.toggle('active', b.dataset.section === section));
  // Canviar de secció netega la cerca activa (excepte quan venim de buscar)
  if (!opts.keepSearch) {
    state.search = '';
    const navSearch = $('#navbarSearch');
    if (navSearch) navSearch.value = '';
  }
  if (section === 'pel·lícules') { state.type = 'movie'; }
  else if (section === 'sèries') { state.type = 'series'; }
  else { state.type = ''; }
  if (opts.navigate !== false) navigateTo(routeForSection(section));
  renderLibrary();
}

// Inicialització
function init() {
  loadAnimePrefFromServer();
  updateAnimeToggleUI();
  // Sincronitza nom/foto del compte actiu (la foto viva a la navbar)
  if (activeProfileId()) {
    api('/api/me').then(applyMeToUI).catch(() => {});
  }
  document.querySelectorAll('.section-link').forEach(btn => {
    btn.onclick = () => setSection(btn.dataset.section);
  });

  const brandBtn = $('#brandBtn');
  if (brandBtn) brandBtn.onclick = (e) => { e.preventDefault(); setSection('inici'); };

  $('#closePlayer').onclick = closePlayer;
  initPlayerUI();

  // ── Auth: menú de convidat, modal i compte ──
  const guestToggle = () => {
    $('#guestDropdown').toggleAttribute('hidden');
  };
  $('#guestBtn').addEventListener('click', (e) => { e.stopPropagation(); guestToggle(); });
  $('#guestLogin').addEventListener('click', () => { $('#guestDropdown').setAttribute('hidden', ''); openAuth('login'); });
  $('#guestSignup').addEventListener('click', () => { $('#guestDropdown').setAttribute('hidden', ''); openAuth('signup'); });
  $('#authSwitch').addEventListener('click', () => openAuth(authMode === 'signup' ? 'login' : 'signup'));
  $('#authClose').addEventListener('click', closeAuth);
  $('#authOverlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeAuth(); });
  $('#authSubmit').addEventListener('click', submitAuth);
  $('#passwordEye').addEventListener('click', () => {
    setPasswordVisible($('#authPassword').type === 'password');
  });
  $('#passwordEye2').addEventListener('click', () => {
    setPasswordVisible($('#authPassword').type === 'password');
  });
  $('#authName').addEventListener('input', setAuthFieldHints);
  $('#authPassword').addEventListener('input', setAuthFieldHints);
  $('#authPassword2').addEventListener('input', setAuthFieldHints);
  $('#authName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#authPassword').focus(); } });
  $('#authPassword2').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitAuth(); } });
  $('#authPassword').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (authMode === 'signup') $('#authPassword2').focus(); else submitAuth(); }
  });

  // ── Cerca de la navbar (barra fixa) ──
  $('#navbarSearch').addEventListener('input', () => {
    state.search = $('#navbarSearch').value.trim();
    state.page = 1;
    if (state.section === 'inici') {
      // Des de la benvinguda: salta a la vista de resultats sense netejar la cerca
      state.section = 'cataleg';
      document.body.classList.remove('on-home');
      navigateTo('/cataleg');
    }
    renderLibrary();
  });

  // Perfil: obre la secció d'usuari (PC i mòbil)
  $('#profileBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#guestDropdown').setAttribute('hidden', '');
    setSection('usuari');
  });
  document.addEventListener('click', () => {
    $('#guestDropdown').setAttribute('hidden', '');
  });
  initSettingsModal();

  // Botó de cerca a la barra inferior (mòbil): porta a la benvinguda i, si ja hi som, enfoca la barra
  $('#bottomSearchBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.section !== 'inici') {
      state.search = '';
      setSection('inici');
      return;
    }
    const input = $('#searchInput');
    if (input) {
      input.focus();
      input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  // Botó d'usuari a la barra inferior (mòbil): pàgina d'usuari (o accés si no hi ha sessió)
  $('#bottomUserBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('#guestDropdown').setAttribute('hidden', '');
    if (activeProfileId()) setSection('usuari');
    else openAuth('login');
  });

  // Delegació de clics a targetes
  $('#content').addEventListener('click', (e) => {
    // Targetes de "Continuar veient": reproducció directa
    const cont = e.target.closest('.continue-card[data-episode]');
    if (cont) {
      openPlayerDirect(cont.dataset.episode);
      return;
    }

    const card = e.target.closest('.card[data-id]');

    // Botó de "la meva llista" (no ha d'obrir el detall)
    const watchBtn = e.target.closest('.watch-btn[data-watch]');
    if (watchBtn) {
      e.stopPropagation();
      toggleWatch(watchBtn.dataset.watch, watchBtn);
      return;
    }

    if (card) return renderDetail(card.dataset.id);
  });

  // Router: el botó "endarrere" del navegador navega dins l'app.
  window.addEventListener('popstate', () => applyRoute());

  // Dreceres de teclat del reproductor (estil YouTube/Netflix)
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const p = window.__player;
    if (!p) return;
    const v = p.video, st = p.state;
    const k = e.key;
    if (k === ' ' || k === 'Spacebar' || k === 'k' || k === 'K') {
      e.preventDefault(); togglePlay(v);
    } else if (k === 'ArrowLeft') {
      e.preventDefault(); seekRelative(v, -5);
    } else if (k === 'ArrowRight') {
      e.preventDefault(); seekRelative(v, 5);
    } else if (k === 'j' || k === 'J') {
      e.preventDefault(); seekRelative(v, -10);
    } else if (k === 'l' || k === 'L') {
      e.preventDefault(); seekRelative(v, 10);
    } else if (k === 'ArrowUp') {
      e.preventDefault(); setVolume(v, st, st.volume + 0.1);
    } else if (k === 'ArrowDown') {
      e.preventDefault(); setVolume(v, st, st.volume - 0.1);
    } else if (k === 'm' || k === 'M') {
      e.preventDefault(); toggleMute(v, st);
    } else if (k === 'f' || k === 'F') {
      e.preventDefault(); stageToggleFullscreen();
    } else if (k === 'Escape') {
      if (!document.fullscreenElement) {
        if (menuOpen()) closePlayerMenus();
        else closePlayer();
      }
      // En fullscreen, Esc el navegador ja torna enrere (no interceptem)
    } else if (k === '0' || k === 'Home') {
      e.preventDefault(); v.currentTime = 0; playerControlsShow();
    } else if (k === 'End') {
      e.preventDefault(); v.currentTime = v.duration || 0; playerControlsShow();
    }
  });

  // PWA: registrar el service worker perquè el navegador pugui instal·lar l'app
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .catch((err) => console.warn('Service Worker no registrat:', err));
  }

  updateAuthUI();
  initLibrary();
}

/** Mostra la vista segons la ruta actual de la URL (amb router). */
function initLibrary() {
  if (activeProfileId()) loadWatchlist();
  applyRoute();
}

document.addEventListener('DOMContentLoaded', init);
