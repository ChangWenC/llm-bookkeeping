# Explicit FactRef model acceptance v2

Preserve v1 receipts, including its shortened-ID failure; do not overwrite them. Run each v2 prompt twice under the same original gpt-5.6-terra/xhigh and read-only/ephemeral settings in README.md, four separate outputs. Source facts now use separate actual fact_id/revision fields. Schema remains result.schema.json.

Round1 allowed target ref identity is exactly {fact_id:"fact:confirmed",revision:1}; older W cannot replace/retract this later confirmed assertion. Round2 every clarification replace/retract must use exactly {fact_id:"fact:uncertain",revision:1}, cite C and provide its own explicit C unit disposition. Unknown/shortened IDs fail, even if text is semantically right. Both require write_existing:false, real conflict notice, and round2 awaiting_user_confirmation. Treat each run independently; no tool use. This simplified fixture verifies model choices but actual Store validation must also reject unknown revisions.
