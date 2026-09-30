import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { BookkeepingConfig, PageBaseline } from '../contracts/types.ts';
import { resolveWikiPath } from '../publish/files.ts';
/** Full digest with a bounded excerpt; explicit page requests never scan namespaces. */
export async function readPageBaseline(config: BookkeepingConfig, path: string, maxBytes = Math.max(64, Math.floor(config.limits.bundle_bytes / 4))): Promise<PageBaseline> {
    const target = await resolveWikiPath(config.wiki_root, path);
    let handle;
    try {
        handle = await open(target.absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
            return { schema_version: 1, path: target.path, digest: 'absent', content: null };
        throw error;
    }
    const hash = createHash('sha256');
    const prefix: Buffer[] = [];
    let saved = 0;
    let total = 0;
    try {
        for await (const bytes of handle.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
            const chunk = bytes as Buffer;
            hash.update(chunk);
            total += chunk.length;
            const amount = Math.min(chunk.length, maxBytes + 4 - saved);
            if (amount > 0) {
                prefix.push(chunk.subarray(0, amount));
                saved += amount;
            }
        }
    }
    finally {
        await handle.close();
    }
    const bytes = Buffer.concat(prefix);
    let end = Math.min(maxBytes, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80)
        end--;
    const excerpt = total > maxBytes;
    return { schema_version: 1, path: target.path, digest: hash.digest('hex'), content: bytes.subarray(0, end).toString('utf8'),
        ...(excerpt ? { context_excerpt: true, excerpt_reason: `Only first ${end} UTF-8 bytes provided; full digest retained` } : {}) };
}
