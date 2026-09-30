import { readFile } from "node:fs/promises";
import { FileAdapter } from "../../src/adapters/files.ts";

// Each invocation is a new Node process. Its only input is a synthetic fixture
// config plus the previous public checkpoints; no memory handle can resume it.
const { config, request, checkpoints } = JSON.parse(await readFile(process.argv[2], "utf8"));
const adapter = new FileAdapter(config.providers[0], config);
const batches = [];
try {
  for await (const batch of adapter.collect(request, { config, checkpoints })) batches.push(batch);
} finally { await adapter.close(); }
const saved = new Map(checkpoints.map((checkpoint: any) => [checkpoint.checkpoint_id, checkpoint]));
for (const batch of batches) for (const checkpoint of batch.checkpoints) saved.set(checkpoint.checkpoint_id, checkpoint);
process.stdout.write(JSON.stringify({
  checkpoints: [...saved.values()],
  events: batches.flatMap(batch => batch.events).map(event => ({ id: event.event_id, conversation: event.source.conversation_id, message_id: event.source.message_id })),
  coverage: batches.flatMap(batch => batch.coverage),
}));
