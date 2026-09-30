# Ownership

Integration: contracts/config/CLI/package/docs/integration tests. A: adapters and adapter tests. B: store/review/schema and associated tests. C: publish and associated tests. Coordinator: serial interface merges, production Wiki writer, automation and cutover. Second-wave consumers/import/archive/migration owners are assigned explicitly.

First dependency is contracts commit 707624a. Follow-up contract additions must be cherry-picked before dependent module commits. `npm test` is the common synthetic test entry. No old implementation, tests or runtime is an oracle.
