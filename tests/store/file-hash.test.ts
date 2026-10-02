import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileSha256, fileSha256Sync } from '../../src/store/file-hash.ts';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
test('bounded async and synchronous file hashes match exact empty, binary and partial-final-chunk bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bookkeeping-file-hash-'));
    try {
        for (const bytes of [Buffer.alloc(0), Buffer.from([0, 255, 128, 13, 10, 0, 1]), Buffer.alloc(1024 * 1024 + 37, 0xab)]) {
            const path = join(root, 'bytes-' + bytes.length);
            await writeFile(path, bytes, { mode: 0o600 });
            assert.equal(await fileSha256(path), sha(bytes));
            assert.equal(fileSha256Sync(path), sha(bytes));
        }
    } finally { await rm(root, { recursive: true, force: true }); }
});
test('bounded hashes propagate open and post-open read failures instead of returning partial digests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bookkeeping-file-hash-errors-'));
    try {
        await assert.rejects(fileSha256(join(root, 'absent')), { code: 'ENOENT' });
        assert.throws(() => fileSha256Sync(join(root, 'absent')), { code: 'ENOENT' });
        await assert.rejects(fileSha256(root), { code: 'EISDIR' });
        assert.throws(() => fileSha256Sync(root), { code: 'EISDIR' });
    } finally { await rm(root, { recursive: true, force: true }); }
});
test('both bounded hashes cover a sparse file above 2 GiB including nonzero bytes across the old limit', { timeout: 120000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'bookkeeping-file-hash-large-'));
    const path = join(root, 'synthetic-sparse.bin'), size = 2 ** 31 + 65536 + 17;
    const head = Buffer.from('synthetic head\0\xff'), boundary = Buffer.from('cross-2GiB-boundary\0\x81'), tail = Buffer.from('synthetic tail\xff');
    const boundaryAt = 2 ** 31 - 11, tailAt = size - tail.length;
    try {
        const file = await open(path, 'wx', 0o600);
        try {
            await file.truncate(size);
            assert.equal((await file.write(head, 0, head.length, 0)).bytesWritten, head.length);
            assert.equal((await file.write(boundary, 0, boundary.length, boundaryAt)).bytesWritten, boundary.length);
            assert.equal((await file.write(tail, 0, tail.length, tailAt)).bytesWritten, tail.length);
        } finally { await file.close(); }
        const info = await stat(path);
        assert.equal(info.size, size);
        assert(info.blocks * 512 < 10 * 1024 * 1024, 'Fixture remains sparse, not a committed or allocated multi-GiB payload');
        // Independent oracle hashes the known construction, never reads the file.
        const oracle = createHash('sha256'), zeros = Buffer.alloc(1024 * 1024);
        const addZeros = (count: number) => { while (count > 0) { const n = Math.min(count, zeros.length); oracle.update(zeros.subarray(0, n)); count -= n; } };
        oracle.update(head); addZeros(boundaryAt - head.length);
        oracle.update(boundary); addZeros(tailAt - boundaryAt - boundary.length); oracle.update(tail);
        const expected = oracle.digest('hex');
        await assert.rejects(readFile(path), { code: 'ERR_FS_FILE_TOO_LARGE' });
        assert.equal(await fileSha256(path), expected);
        assert.equal(fileSha256Sync(path), expected);
    } finally { await rm(root, { recursive: true, force: true }); }
});
