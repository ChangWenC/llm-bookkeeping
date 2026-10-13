export type StorageFailureContext = 'local_write' | 'source_read';
/** Capacity and SQLite errors are global; I/O/read-only errors require write provenance. */
export function storageFailureCode(error: unknown, context?: StorageFailureContext): string | null {
  let current = error;
  let provenance = context;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    const value = current as NodeJS.ErrnoException & { cause?: unknown; storage_context?: StorageFailureContext };
    provenance = value.storage_context ?? provenance;
    if (typeof value.code === 'string') {
      if (/^(?:BOOKKEEPING_STORAGE_FAILURE|ERR_SQLITE|SQLITE_)/.test(value.code) || ['ENOSPC','EDQUOT'].includes(value.code)) return value.code;
      if (provenance === 'local_write' && ['EIO','EROFS'].includes(value.code)) return value.code;
    }
    current = value.cause;
  }
  return null;
}
/** Mark the failed operation at its boundary; never mark an entire source adapter as a write. */
export function markStorageFailure(error: unknown, context: StorageFailureContext): Error {
  const original = error as NodeJS.ErrnoException | null;
  return Object.assign(new Error(error instanceof Error ? error.message : String(error), { cause: error }), {
    ...(typeof original?.code === 'string' ? { code: original.code } : {}), storage_context: context,
  });
}
export function storageExecutionError(message: string, receipt?: unknown): Error {
  return Object.assign(new Error(message), { code: 'BOOKKEEPING_STORAGE_FAILURE', receipt });
}
export function assertStorageAvailable(receipt: unknown): void {
  const value = receipt as { execution_status?: string; failure_scope?: string; publication?: { execution_status?: string }; consumers?: {failure_scope?:string}[]; files?:{failure_scope?:string}[] } | null;
  if (value?.execution_status === 'storage_unavailable' || value?.publication?.execution_status === 'storage_unavailable' || value?.failure_scope === 'storage' || value?.consumers?.some(c=>c.failure_scope==='storage') || value?.files?.some(f=>f.failure_scope==='storage')) throw storageExecutionError('Shared storage unavailable; prior accepted/export/file outcomes retained', receipt);
}
