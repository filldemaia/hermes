import { MetadataCandidate } from '../types';
import { titleConfidence } from '../util';
import { mapGenres, pickAnimeName } from './meta';

const API = 'https://graphql.anilist.co';

interface AniMedium {
  id: number;
  title: { romaji?: string | null; english?: string | null; native?: string | null } | null;
  startDate?: { year?: number | null };
  genres?: string[] | null;
  description?: string | null;
  coverImage?: { extraLarge?: string | null; large?: string | null } | null;
  bannerImage?: string | null;
}

interface AniResp {
  data?: {
    Page?: { media: AniMedium[] };
  };
}

async function anilistSearch(search: string): Promise<AniMedium[]> {
  const query = `
    query ($search: String) {
      Page(page: 1, perPage: 8) {
        media(search: $search, type: ANIME) {
          id
          title { romaji english native }
          startDate { year }
          genres
          description(asHtml: false)
          coverImage { extraLarge large }
          bannerImage
        }
      }
    }`;
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ query, variables: { search } }),
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 403 && /temporarily disabled/i.test(body)) {
      throw new Error('AniList temporarily disabled');
    }
    throw new Error(`AniList HTTP ${res.status}`);
  }
  const json = (await res.json()) as AniResp;
  return (json.data?.Page?.media) || [];
}

function stripHtml(s: string | null | undefined): string | null {
  if (!s) return null;
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function anilistCandidates(query: string): Promise<MetadataCandidate[]> {
  const media = await anilistSearch(query);
  const candidates = media.map((m) => {
    const title = pickAnimeName(m);
    return {
      title,
      year: m.startDate?.year || null,
      posterUrl: m.coverImage?.extraLarge || m.coverImage?.large || null,
      bannerUrl: m.bannerImage || null,
      externalSource: 'anilist' as const,
      externalId: String(m.id),
      confidence: titleConfidence(query, title),
      ambiguous: false,
      genres: mapGenres(m.genres || []),
      synopsis: stripHtml(m.description),
    };
  });
  const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence);
  if (sorted.length >= 2 && sorted[0].confidence > 0 && sorted[1].confidence >= Math.max(0.55, sorted[0].confidence - 0.12)) {
    sorted[0].ambiguous = sorted[1].confidence > 0.45;
  }
  return candidates.slice(0, 8);
}