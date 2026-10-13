# Original daily model synthetic acceptance

Coordinator runs from an isolated empty temporary directory. These synthetic inputs ask the original daily model to produce semantic decisions only. They are not a code generation task or production review, and the evaluator does not claim this simplified output is a full ReviewResult.

```sh
codex exec -m gpt-5.6-terra -c model_reasoning_effort=xhigh --sandbox read-only --ephemeral --skip-git-repo-check --output-schema ABS/result.schema.json -o ABS/private/round-1.json --json - < ABS/round-1.prompt.txt
codex exec -m gpt-5.6-terra -c model_reasoning_effort=xhigh --sandbox read-only --ephemeral --skip-git-repo-check --output-schema ABS/result.schema.json -o ABS/private/round-2.json --json - < ABS/round-2.prompt.txt
```

Reject any tool use rather than counting it as semantic acceptance. Unavailable original model/settings are reported, never silently replaced. Save private receipts; source fixtures are entirely synthetic.

Both cases: every supplied unit appears exactly once in unit_dispositions; referenced fact operations use only supplied IDs; journal.write_existing=false and a nonempty conflict_notice. Round1 cannot replace/retract fact:confirmed:1 using older W, and cannot present uncertainty as the new final conclusion. It may keep historical uncertainty as an explicitly earlier assertion, defer it, or identify no additional persistent information with a reason. Round2 must preserve C as an explicit clarification (recorded_fact with C-referenced replace/retract targeting fact:uncertain:1, or defer with a specific uncertainty reason); R alone cannot cover C. Journal.status must be awaiting_user_confirmation and body/summary conflict must be explicit. Human evaluation of actual semantic text supplements structural checks; schema alone does not certify correctness.
