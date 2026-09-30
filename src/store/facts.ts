import type { FactRevision } from '../contracts/types.ts';
/** Revision identity, rather than arrival order, determines the effective ledger. */
export function foldFacts(rows: FactRevision[]): FactRevision[] {
    const maximum = new Map<string, number>(), retired = new Map<string, number>();
    for (const fact of rows) {
        maximum.set(fact.fact_id, Math.max(maximum.get(fact.fact_id) ?? 0, fact.revision));
        if (fact.action !== 'assert')
            for (const target of fact.target_refs)
                retired.set(target.fact_id, Math.max(retired.get(target.fact_id) ?? 0, target.revision));
    }
    return rows.filter(fact => fact.action !== 'retract' && fact.revision === maximum.get(fact.fact_id) && fact.revision > (retired.get(fact.fact_id) ?? 0));
}
