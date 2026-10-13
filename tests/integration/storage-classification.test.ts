import test from 'node:test';
import assert from 'node:assert/strict';
import { storageFailureCode, markStorageFailure } from '../../src/storage-errors.ts';
test('capacity and SQLite failures stay global through source wrappers', () => {
  for (const code of ['ENOSPC','EDQUOT','ERR_SQLITE_ERROR','SQLITE_FULL']) {
    const error = Object.assign(new Error(code), {code});
    assert.equal(storageFailureCode(markStorageFailure(error,'source_read')),code);
  }
});
test('EIO and EROFS require exact local-write provenance', () => {
  for (const code of ['EIO','EROFS']) {
    const error = Object.assign(new Error(code), {code});
    assert.equal(storageFailureCode(error),null);
    assert.equal(storageFailureCode(error,'source_read'),null);
    assert.equal(storageFailureCode(error,'local_write'),code);
    assert.equal(storageFailureCode(new Error('adapter failure',{cause:markStorageFailure(error,'local_write')})),code);
    assert.equal(storageFailureCode(markStorageFailure(error,'source_read')),null);
  }
  assert.equal(storageFailureCode(Object.assign(new Error('access'),{code:'EACCES'}),'local_write'),null);
});
