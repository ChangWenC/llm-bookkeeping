import { createHash } from 'node:crypto';
export function canonical(value: unknown): string {
    if (Array.isArray(value))
        return '[' + value.map(canonical).join(',') + ']';
    if (value !== null && typeof value === 'object')
        return '{' + Object.keys(value).sort().filter(k => (value as any)[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical((value as any)[k])).join(',') + '}';
    return JSON.stringify(value);
}
export function digest(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
