# Behavior and acceptance map

| SPEC area | Contract/orchestration | Implementation owner / acceptance |
| --- | --- | --- |
| 2–3 environment / contracts / CLI | Node pin, native TS, package lock, DTOs, validators, all command routes | Integration; synthetic CLI tests |
| 4 atomic capture / review / outbox | Store ports; pending patches; complete file intents; independent PublishResult | B/C; transaction/file failure tests pending |
| 5 bounded native source capture | SourceAdapter budgets, lane-specific merged checkpoints, explicit identity/time/coverage | A; bounded-tail, malformed, relocation, DST cases pending |
| 6 journals / effective archive | JournalSuggestion/Patch exact edits, fact revisions, legacy import port | B/C + second wave; no resurrection/folding/archive cases pending |
| 7 Analytics | Explicit privacy projection and ready batch consumer port | Second wave; attribution/revision/confirmation/action cases pending |
| 8 WeChat/import | Read-only adapter and manifest route; missing identity/coverage stays partial | A + second wave; real PoC mandatory pending |
| 9 migration/cutover/retirement | Stable migration import port; runbook and coordinator boundary | Coordinator; real manual + scheduled evidence pending |

M0 verification establishes argument validation, temporal/config invariants, wide-ID parsing, explicit zero facts and prepare materials. It does not claim business, production, WeChat or retirement completion.
