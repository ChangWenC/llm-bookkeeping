# Behavior and acceptance map

| SPEC area | Concrete implementation and synthetic evidence | Real acceptance owner |
| --- | --- | --- |
| Contracts/CLI | Pinned Node/native TS/SQLite, typed DTOs and schema, compact private manifests, bounded explicit config | Coordinator validates deployment config |
| Atomic capture/review/outbox | Actual SQLite transaction fault/crash tests; partial chunks; durable pending patches and full-byte intents | Coordinator runs isolated sources |
| Native sources/WeChat | Bounded 2GB tail, mirrors/repeats/relocation, exact core/context pagination, verified ID/alias/range policy | Coordinator proves native source coverage and real WeChat |
| Wiki publication/archive | Shared writer lock, conflict preservation, ready facts independent of files, kill/recovery archive tests | Coordinator report-first retention and black-box lint/index |
| Effective monthly context | Imported legacy base excluded from new supplements; correction/retraction warning; reviewed task IDs only | Coordinator checks actual old archive/month pages |
| Analytics/history | Professional projection ports; actual CLI manifest → SQLite current revision/hash activation; raw retained separately | Coordinator verifies legacy mappings and real analysis |
| Migration/cutover | Stable legacy fact identity/repeat import and ordinary pending state; consistent backup/new-directory restore | Coordinator owns manual/scheduled runs and retirement |

`npm run check` runs strict types and synthetic tests against actual SQLite and subprocesses. Code, synthetic and real acceptance are separate. Missing concrete services fail explicitly during staged integration; pending work and partial coverage never become zero-activity claims. Production completion still requires the complete SPEC acceptance matrix and observed scheduled runs.
