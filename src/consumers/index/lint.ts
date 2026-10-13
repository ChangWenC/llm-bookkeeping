/** Public Wiki lint is the sole archive-target validation authority. */
export const PUBLIC_LINT_REPORT_VERSION = 1;
export const PUBLIC_LINT_REQUIRED_CAPABILITY = 'daily-journal-archive-target-v2';
export interface Diagnostic { level: 'Error' | 'Warning' | 'Suggestion'; code: string; path: string; message: string }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function parsePublicLint(stdout: string): { errors: Diagnostic[]; cache_identity: string } {
  const value: unknown = JSON.parse(stdout);
  if (!object(value) || value.report_contract_version !== PUBLIC_LINT_REPORT_VERSION || !Array.isArray(value.capabilities) || !value.capabilities.every(item => typeof item === 'string') || !value.capabilities.includes(PUBLIC_LINT_REQUIRED_CAPABILITY))
    throw new Error('Unsupported public lint report version or missing full-v2 capability');
  if (!object(value.counts)) throw new Error('Unknown public lint counts shape');
  const counts = value.counts;
  if (!['generated_at', 'disabled_checks', 'tag_source_report', 'synthesis_candidates'].every(key => key in value) || typeof value.generated_at !== 'string' || !Number.isFinite(Date.parse(value.generated_at)) || !Array.isArray(value.disabled_checks) || !Array.isArray(value.synthesis_candidates) || !['pages', 'errors', 'warnings', 'suggestions'].every(key => Number.isSafeInteger(counts[key]) && Number(counts[key]) >= 0))
    throw new Error('Unknown public lint JSON shape');
  const arrays = [['errors', 'Error'], ['warnings', 'Warning'], ['suggestions', 'Suggestion']] as const;
  for (const [key, level] of arrays) {
    const items = value[key];
    if (!Array.isArray(items) || value.counts[key] !== items.length || !items.every(item => object(item) && item.level === level && ['code', 'path', 'message'].every(field => typeof item[field] === 'string') && typeof item.code === 'string' && /^[EWS]\d{3}$/.test(item.code) && item.code[0] === level[0]))
      throw new Error('Public lint diagnostic severity, shape or counts do not agree');
  }
  return { errors: value.errors as Diagnostic[], cache_identity: JSON.stringify({ report_contract_version: value.report_contract_version, capabilities: [...value.capabilities].sort(), counts: value.counts, errors: value.errors, warnings: value.warnings, suggestions: value.suggestions }) };
}
