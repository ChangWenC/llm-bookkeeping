import type { FactArtifact } from '../contracts/types.ts';
/** Event months are explicit. A week label is not evidence that its start/end month changed. */
export function affectedMonths(artifact: Pick<FactArtifact, 'affected_months' | 'affected_dates'>): string[] {
  return [...new Set(artifact.affected_months ?? artifact.affected_dates.map(date => date.slice(0, 7)))].sort();
}
