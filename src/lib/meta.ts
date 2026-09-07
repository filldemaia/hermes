const GENRE_CA: Record<string, string> = {
  action: 'Acció',
  adventure: 'Aventura',
  animation: 'Animació',
  comedy: 'Comèdia',
  crime: 'Crim',
  documentary: 'Documental',
  drama: 'Drama',
  family: 'Familiar',
  fantasy: 'Fantasia',
  history: 'Història',
  horror: 'Terror',
  music: 'Música',
  mystery: 'Misteri',
  romance: 'Romàntic',
  'science fiction': 'Ciència-ficció',
  'tv movie': 'Pel·lícula de televisió',
  thriller: 'Thriller',
  war: 'Bélic',
  western: 'Western',
  'action & adventure': 'Acció i Aventura',
  'action and adventure': 'Acció i Aventura',
  'sci-fi': 'Ciència-ficció',
  'sci-fi & fantasy': 'Ciència-ficció i Fantasia',
  'mystery & thriller': 'Misteri i Thriller',
  'kids': 'Infantil',
  'drama & romance': 'Drama i Romàntic',
  'slice of life': 'Costumista',
  'psychological': 'Psicològic',
  'supernatural': 'Sobrenatural',
};

export function mapGenre(g: string): string {
  return GENRE_CA[String(g || '').trim().toLowerCase()] || String(g || '').trim();
}

export function mapGenres(genres: string[] | null | undefined): string[] {
  if (!genres) return [];
  return genres.map(mapGenre).filter(Boolean);
}

/** Extreu el tipus de títol original/normalitzat per a anilist (romaji/english). */
export function pickAnimeName(medium: { title?: { romaji?: string | null; english?: string | null; native?: string | null } | null }): string {
  return medium.title?.romaji || medium.title?.english || medium.title?.native || '';
}