import { readFile } from "node:fs/promises";
import { FileAdapter } from "../../src/adapters/files.ts";
import { createStore } from "../../src/store/index.ts";
const { config, request } = JSON.parse(await readFile(process.argv[2], "utf8"));
const store = await createStore(config);
let emitted = 0;
try {
  const checkpoints = [...await store.getCheckpoints("claude", "live"), ...await store.getCheckpoints("claude", "history")];
  const adapter = new FileAdapter(config.providers[0], config);
  try {
    for await (const batch of adapter.collect(request, { config, checkpoints })) {
      emitted += batch.events.length;
      await store.saveCollection(batch);
    }
  } finally { await adapter.close(); }
  const events = await store.listEvents({ range: request.range, source: "claude" });
  const reviewable = await store.getReviewableEvents({ range: request.range, source: "claude" }, "daily");
  console.log(JSON.stringify({ emitted, stored: events.length, reviewable: reviewable.length, event_id: events[0]?.event_id }));
} finally { store.close(); }
