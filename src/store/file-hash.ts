import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { openSync, readSync, closeSync } from 'node:fs';

const READ_BYTES = 1024 * 1024;

/** Hash arbitrary-size local files without accumulating their bytes in memory. */
export async function fileSha256(path: string): Promise<string> {
    const file = await open(path, 'r');
    try {
        const hash = createHash('sha256');
        const buffer = Buffer.allocUnsafe(READ_BYTES);
        while (true) {
            const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
            if (bytesRead === 0) break;
            hash.update(buffer.subarray(0, bytesRead));
        }
        return hash.digest('hex');
    } finally {
        await file.close();
    }
}

/** Synchronous variant for proof revalidation inside SQLite transactions. */
export function fileSha256Sync(path: string): string {
    const fd = openSync(path, 'r');
    try {
        const hash = createHash('sha256');
        const buffer = Buffer.allocUnsafe(READ_BYTES);
        while (true) {
            const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
            if (bytesRead === 0) break;
            hash.update(buffer.subarray(0, bytesRead));
        }
        return hash.digest('hex');
    } finally {
        closeSync(fd);
    }
}
