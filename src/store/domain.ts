import type { SourceEvent, FactRef, TimeRange, FactRevision } from '../contracts/types.ts';
import { isNativeWechatContactId } from './wechat-identity.ts';
import { canonical } from '../analytics/serialization.ts';
export const refKey = (ref: FactRef) => `${ref.fact_id}:${ref.revision}`;
export const utc = (value: string) => {
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value) || !Number.isFinite(Date.parse(value)))
        throw new Error('Invalid UTC timestamp: ' + value);
};
export const normalized = (value: string) => {
    const match = value.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/);
    if (!match)
        throw new Error('Invalid UTC timestamp');
    return match[1] + '.' + (match[2] ?? '').padEnd(9, '0') + 'Z';
};
export const rangeCheck = (range: TimeRange) => {
    utc(range.from);
    utc(range.to);
    if (normalized(range.from) >= normalized(range.to))
        throw new Error('Range must be nonempty and half open');
};
export const version = (value: any) => {
    if (value?.schema_version !== 1)
        throw new Error('Unsupported schema_version');
};
export const unique = (ids: string[], label: string) => {
    if (ids.some(id => !id) || new Set(ids).size !== ids.length)
        throw new Error('Duplicate or empty ' + label);
};
// Correct the known Date millisecond truncation only when the unchanged source
// timestamp independently proves both the old truncation and the exact instant.
function preciseOriginalUtc(original: string | null): { exact: string; truncated: string; precision: SourceEvent['time_precision'] } | null {
    // The adapter contract interprets exactly ten integer digits as epoch seconds;
    // never infer units for millisecond epochs or another numeric width.
    const epoch = original?.match(/^(\d{10})\.(\d{4,9})$/);
    if (epoch) {
        const second = Number(epoch[1]) * 1000;
        return {
            exact: new Date(second).toISOString().slice(0, 19) + '.' + epoch[2].padEnd(9, '0') + 'Z',
            truncated: normalized(new Date(Number(original) * 1000).toISOString()),
            precision: epoch[2].length > 6 ? 'nanosecond' : 'microsecond',
        };
    }
    const match = original?.match(/^(\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d)\.(\d{4,9})(Z|[+-]\d\d:?\d\d)$/);
    if (!match || !Number.isFinite(Date.parse(original!)))
        return null;
    const second = Date.parse(match[1] + match[3]);
    if (!Number.isFinite(second))
        return null;
    return {
        exact: new Date(second).toISOString().slice(0, 19) + '.' + match[2].padEnd(9, '0') + 'Z',
        truncated: normalized(new Date(Date.parse(original!)).toISOString()),
        precision: match[2].length > 6 ? 'nanosecond' : 'microsecond',
    };
}
export function enrichEvent(previous: SourceEvent, incoming: SourceEvent): SourceEvent {
    const provenSource = previous.source.message_id !== null
        || (previous.event_id === incoming.event_id && previous.locator === incoming.locator && previous.generation === incoming.generation);
    if (provenSource && canonical(previous.source) === canonical(incoming.source)
        && previous.body === incoming.body && previous.original_time.value === incoming.original_time.value
        && previous.utc_time.value && incoming.utc_time.value) {
        const proof = preciseOriginalUtc(previous.original_time.value);
        const oldTime = normalized(previous.utc_time.value), newTime = normalized(incoming.utc_time.value);
        if (proof && proof.exact !== proof.truncated
            && ((oldTime === proof.truncated && newTime === proof.exact)
                || (oldTime === proof.exact && newTime === proof.truncated))) {
            previous = { ...previous, utc_time: { ...previous.utc_time, value: proof.exact }, time_precision: proof.precision };
            incoming = { ...incoming, utc_time: { ...incoming.utc_time, value: proof.exact }, time_precision: proof.precision };
        }
    }
    const nativeCompatible = previous.source.message_id !== null && canonical(previous.source) === canonical(incoming.source) && previous.body === incoming.body && (!previous.utc_time.value || !incoming.utc_time.value || normalized(previous.utc_time.value) === normalized(incoming.utc_time.value)) && (previous.role === incoming.role || previous.role === 'unknown' || incoming.role === 'unknown');
    if (nativeCompatible) {
        const verifiedWechatSender = previous.source.provider === 'wechat' && previous.role === 'unknown'
            && typeof previous.body === 'string' && previous.utc_time.value !== null && incoming.utc_time.value !== null
            && normalized(previous.utc_time.value) === normalized(incoming.utc_time.value)
            && !previous.context.sender_wxid && incoming.role !== 'unknown' && incoming.context.identity_verified === true
            && isNativeWechatContactId(incoming.context.sender_wxid)
            && incoming.context.sender_id === incoming.context.sender_wxid;
        for (const key of ['sender_id', 'real_sender_id'])
            if (previous.context[key] !== undefined && incoming.context[key] !== undefined && String(previous.context[key]) !== String(incoming.context[key])) {
                const provisionalNumeric = verifiedWechatSender && /^[0-9]+$/.test(String(previous.context[key]))
                    && String(incoming.context[key]) === incoming.context.sender_wxid;
                if (!provisionalNumeric) throw new Error('Conflicting known sender');
            }
        const retainedContext = { ...previous.context, ...incoming.context };
        for (const key of ['identity_verified', 'media_transcribed'])
            if (previous.context[key] === true)
                retainedContext[key] = true;
        // Native transport retries may repeat an earlier unfinished snapshot.
        // A completion witness is retained; the independent incomplete marker
        // clears only when the incoming snapshot explicitly proves completion.
        if (previous.context.turn_complete === true || incoming.context.turn_complete === true)
            retainedContext.turn_complete = true;
        if (previous.context.incomplete_turn === true)
            retainedContext.incomplete_turn = !(incoming.context.turn_complete === true && incoming.context.incomplete_turn === false);
        if (previous.context.context_only === false || incoming.context.context_only === false)
            retainedContext.context_only = false;
        const candidate = { ...incoming, physical_order: previous.physical_order, generation: previous.generation, time_precision: previous.time_precision === 'unknown' ? incoming.time_precision : previous.time_precision, context: retainedContext };
        if (previous.utc_time.value && incoming.utc_time.value && previous.original_time.value !== null)
            candidate.original_time = previous.original_time;
        if (previous.journal_timezone.value === incoming.journal_timezone.value && previous.journal_date.value === incoming.journal_date.value)
            candidate.journal_timezone_basis = previous.journal_timezone_basis;
        if (previous.wire_timezone.value !== null)
            candidate.wire_timezone = previous.wire_timezone;
        previous = { ...previous, context: retainedContext };
        incoming = candidate;
    }
    const merged = structuredClone(previous);
    const nullable = ['original_time', 'utc_time', 'wire_timezone', 'journal_timezone', 'journal_date'] as const;
    for (const key of nullable) {
        const a = previous[key];
        const b = incoming[key];
        if (a.value === null && b.value !== null)
            (merged as any)[key] = b;
        else if (b.value !== null && a.value !== b.value) {
            if (['utc_time', 'original_time'].includes(key) && a.value?.endsWith('Z') && b.value.endsWith('Z') && normalized(a.value) === normalized(b.value))
                continue;
            throw new Error('Conflicting known event ' + key);
        }
    }
    for (const key of ['message_id', 'block_id'] as const) {
        if (merged.source[key] === null)
            merged.source[key] = incoming.source[key];
        else if (incoming.source[key] !== null && merged.source[key] !== incoming.source[key])
            throw new Error('Conflicting native source identity');
    }
    if (previous.classification === 'unknown')
        merged.classification = incoming.classification;
    if (previous.role === 'unknown')
        merged.role = incoming.role;
    if (previous.time_precision === 'unknown')
        merged.time_precision = incoming.time_precision;
    if (previous.journal_timezone_basis === null)
        merged.journal_timezone_basis = incoming.journal_timezone_basis;
    if (previous.fragment_ref === null)
        merged.fragment_ref = incoming.fragment_ref;
    if (previous.context.turn_complete === false && incoming.context.turn_complete === true)
        merged.context.turn_complete = true;
    if (previous.context.incomplete_turn === true && incoming.context.incomplete_turn === false)
        merged.context.incomplete_turn = false;
    merged.locator = incoming.locator;
    const normalizeComparable = (e: SourceEvent) => ({ ...e, locator: null, fragment_ref: null, ...Object.fromEntries(nullable.map(key => [key, { ...e[key], value: e[key].value && ['utc_time', 'original_time'].includes(key) && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(e[key].value!) ? normalized(e[key].value!) : e[key].value }])) });
    // Incoming nulls cannot erase known information. Rebuild its comparison shape with retained values.
    const comparator = { ...incoming, source: { ...incoming.source }, context: { ...incoming.context } };
    for (const key of nullable)
        if (incoming[key].value === null)
            (comparator as any)[key] = merged[key];
    for (const key of ['message_id', 'block_id'] as const)
        if (comparator.source[key] === null)
            comparator.source[key] = merged.source[key];
    if (comparator.classification === 'unknown')
        comparator.classification = merged.classification;
    if (comparator.role === 'unknown')
        comparator.role = merged.role;
    if (comparator.time_precision === 'unknown')
        comparator.time_precision = merged.time_precision;
    if (comparator.journal_timezone_basis === null)
        comparator.journal_timezone_basis = merged.journal_timezone_basis;
    if (canonical(normalizeComparable(merged)) !== canonical(normalizeComparable(comparator)))
        throw new Error('Conflicting event content/identity');
    return merged;
}
export function weekFor(date: string): string { const d = new Date(date + 'T12:00:00Z'); const dow = d.getUTCDay(); d.setUTCDate(d.getUTCDate() - (dow + 6) % 7); return d.toISOString().slice(0, 10); }
export function factWeek(fact: FactRevision): string | null {
    const time = fact.occurred_at.value;
    if (!time)
        return null;
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time));
    return weekFor(date);
}
