export type TitleType = 'movie' | 'series' | 'anime_movie' | 'anime_series';
export type ExternalSource = 'tmdb' | 'anilist';
export type TitleStatus = 'indexed' | 'quarantined' | 'missing';
export type EpisodeStatus = 'active' | 'missing';

export interface TitleRow {
  id: string;
  type: TitleType;
  original_title: string;
  catalan_title: string | null;
  year: number | null;
  synopsis_ca: string | null;
  synopsis_fallback: string | null;
  poster_url: string | null;
  genres: string;
  external_id: string | null;
  external_source: ExternalSource | null;
  root_path: string;
  status: TitleStatus;
  created_at: string;
  updated_at: string;
  backdrop_url?: string | null;
}

export interface EpisodeRow {
  id: string;
  title_id: string;
  season_number: number | null;
  episode_number: number | null;
  episode_title: string | null;
  file_path: string;
  subtitle_path: string | null;
  duration_seconds: number | null;
  file_hash: string;
  status: EpisodeStatus;
}

export interface MetadataCandidate {
  title: string;
  year: number | null;
  posterUrl: string | null;
  externalSource: ExternalSource;
  externalId: string;
  confidence: number;
  ambiguous: boolean;
  genres: string[];
  synopsis: string | null;
  bannerUrl?: string | null;
}

export interface ScanCounters {
  newTitles: number;
  updatedTitles: number;
  missingEpisodes: number;
  quarantined: number;
  errors: string[];
}