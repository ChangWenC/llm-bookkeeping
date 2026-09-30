# Versioned data formats

`schemas/contracts.schema.json` publishes JSON Schema draft 2020-12 DTO shapes. `src/contracts/validation.ts` is the runtime semantic validator. Interfaces version is 1; a future breaking shape requires a new version and explicit migration.

Examples: `test/fixtures/zero-facts.json`, `partial.json`, `correction.json`, `conflict.json`. Unknown values use null + reason. Arrays are never omitted to mean complete. A complete zero-candidate chunk explicitly sets zero_facts. Review candidate IDs are local; permanent fact/revision/operation identity is assigned by the application. Review result/bundle identities become durable after acceptance and cannot be reused with changed content.

All UTC timestamps end Z, all journal dates retain historical timezone basis, all numeric source identities are strings. `parseJsonPreservingIntegers` preserves wide JSON integer tokens before parsing; adapters normalize all source IDs to strings. Bytes in fragments/intents are base64 of complete original bytes. SHA256 digests are lowercase hex, except the explicit absent sentinel.

Page suggestions distinguish creation from maintenance. `baseline_digest:"absent"` with `mode:"append"` requires `new_text` to contain a complete compliant page: current Wiki template frontmatter and H1, explicit date and ordinary journal class (`daily-active` or reconstructed history `daily-reconstructed`). Supply the complete required metadata from that template; do not treat a single journal paragraph as a new page. For an existing baseline, `new_text` is the local append or exact replacement. The common Publisher preserves locks, backup bytes and digest recovery; it does not generate missing frontmatter.
