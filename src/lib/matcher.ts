// Paràmetres del matcher de títols (especificació §4).
// Confiança final = 0.7·títol + 0.3·any, amb llindar d'acceptació 0.75 i
// marge d'ambigüitat 0.06 entre els dos millors candidats.

export const TITLE_WEIGHT = 0.7;
export const YEAR_WEIGHT = 0.3;
export const MATCH_THRESHOLD = 0.75;
export const AMBIGUITY_MARGIN = 0.06;

export interface MatcherCandidate {
  title: string;
  year: number | null;
  confidence: number;
}

export function yearSimilarity(localYear: number | null, candidateYear: number | null): number {
  if (localYear == null || candidateYear == null) return 0.5;
  return localYear === candidateYear ? 1 : 0;
}

export function matchConfidence(queryTitle: string, localYear: number | null, candidate: MatcherCandidate): number {
  return TITLE_WEIGHT * candidate.confidence + YEAR_WEIGHT * yearSimilarity(localYear, candidate.year);
}

export function isAmbiguous(best: MatcherCandidate, second: MatcherCandidate | undefined): boolean {
  if (!second) return false;
  return best.confidence - second.confidence < AMBIGUITY_MARGIN;
}