import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileAdapter } from "../../src/adapters/files.ts";
import { parseSessionRow, sessionIdentity, type ParseState } from "../../src/adapters/parsers.ts";
import { codexTurnId, parseHeartbeatPacket } from "../../src/adapters/codex-turns.ts";
import { config as defaults } from "../../test/fixtures/basic.ts";
import type { BookkeepingConfig, CollectionBatch, CollectRequest, SourceCheckpoint } from "../../src/contracts/types.ts";

const packet = `<heartbeat>
  <automation_id>synthetic-monitor</automation_id>
  <current_time_iso>2026-09-30T07:11:52.919Z</current_time_iso>
  <instructions>synthetic automation instructions</instructions>
</heartbeat>`;
const header = {
  type: "session_meta",
  payload: { id: "synthetic-human-session", source: "vscode", thread_source: "user", originator: "Codex Desktop" },
};
function message(role: "user" | "assistant", body: string, turn: string | null, id: string, phase = "final_answer") {
  return {
    timestamp: "2026-09-30T07:11:52.919Z", ordinal: 1, type: "response_item",
    payload: {
      type: "message", id, role, phase,
      content: [{ type: role === "user" ? "input_text" : "output_text", text: body }],
      ...(turn ? { internal_chat_message_metadata_passthrough: { turn_id: turn, create_time: 1790752312, content_item_kinds: ["text"] } } : {}),
    },
    metadata: {
      retained_source: { id: { message_id: id, ...(turn ? { turn_id: turn } : {}), role }, revision: 1, complete: true },
      client_authored: false, user_input_order: 1, mcp_attribution: {},
    },
  };
}
function parse(rows: any[], state: ParseState = {}) {
  const identity = sessionIdentity("codex", [header]);
  return rows.flatMap((row, index) => parseSessionRow("codex", row, identity, "/synthetic/source.jsonl", "0", index * 1000, defaults, state, "synthetic"));
}
function jsonl(...rows: any[]) { return rows.map(row => JSON.stringify(row) + "\n").join(""); }

test("Codex complete heartbeat affects only its native turn and preserves human turns before and after", () => {
  const result = parse([
    message("user", "synthetic human before", "turn-0", "human-0"),
    message("assistant", "synthetic human answer", "turn-0", "answer-0"),
    message("user", packet, "turn-1", "heartbeat-1"),
    message("assistant", "synthetic progress", "turn-1", "progress-1", "commentary"),
    message("assistant", "synthetic automation final", "turn-1", "final-1"),
    message("user", "Please explain heartbeat and synthetic-monitor; this is human input", "turn-2", "human-2"),
    message("assistant", "synthetic human after", "turn-2", "answer-2"),
  ]);
  assert.deepEqual(result.map(event => event.classification), ["main", "main", "automation", "automation", "automation", "main", "main"]);
  const proof = result[2].context.automation_origin as any;
  assert.equal(proof.anchor_event_id, result[2].event_id);
  assert.equal(proof.anchor_offset, 2000);
  assert.equal(proof.turn_id, "turn-1");
  assert.deepEqual(result[3].context.automation_origin, proof);
  assert.deepEqual(result[4].context.automation_origin, proof);
  assert.equal(result[5].context.automation_origin, undefined);
  assert.equal(result[2].body, packet);
});

test("Codex heartbeat mirror keeps its canonical anchor across a persisted parse state", () => {
  const state: ParseState = {};
  const first = parse([
    { timestamp: "2026-09-30T07:11:52.919Z", type: "event_msg", payload: { type: "user_message", id: "heartbeat-1", turn_id: "turn-1", message: packet } },
    message("user", packet, "turn-1", "heartbeat-1"),
  ], state);
  assert.equal(first.length, 1);
  const resumed = parse([message("assistant", "synthetic resumed automation", "turn-1", "answer-1")], structuredClone(state));
  assert.equal(resumed[0].classification, "automation");
  assert.deepEqual(resumed[0].context.automation_origin, first[0].context.automation_origin);
});

test("Codex quoted heartbeat, assistant prose and UUID never establish automation origin", () => {
  for (const text of ["heartbeat synthetic-monitor", "Explain this packet:\n" + packet, "```xml\n" + packet + "\n```", "synthetic UUID 123e4567-e89b-12d3-a456-426614174000"]) {
    assert.equal(parseHeartbeatPacket(text), null);
    assert.equal(parse([message("user", text, "human", "u")])[0].classification, "main");
  }
  const result = parse([message("user", "synthetic human", "human", "u"), message("assistant", packet, "human", "a")]);
  assert.deepEqual(result.map(event => event.classification), ["main", "main"]);
});

test("Codex incomplete heartbeat, conflicting native turn and missing user boundary remain local unknown", () => {
  const invalid = packet.replace("</heartbeat>", "");
  assert.equal(parseHeartbeatPacket(invalid), null);
  assert.equal(parseHeartbeatPacket(packet.replace("2026-09-30", "2026-02-30")), null);
  const conflict = message("user", packet, "turn-1", "conflict");
  conflict.metadata.retained_source.id.turn_id = "turn-other";
  assert.deepEqual(codexTurnId(conflict), { id: null, conflict: true });
  const result = parse([
    message("user", invalid, "turn-1", "partial"),
    message("assistant", "synthetic uncertain assistant", "turn-1", "a1"),
    message("user", "synthetic human reset", "turn-2", "human"),
    conflict,
    message("user", packet, "turn-3", "valid"),
    { type: "turn_context", payload: { turn_id: "turn-4", cwd: "/synthetic/human" } },
    message("assistant", "synthetic other turn without input", "turn-4", "a4"),
    message("user", "synthetic human after unknown", "turn-5", "human-after"),
  ]);
  assert.deepEqual(result.map(event => event.classification), ["unknown", "unknown", "main", "unknown", "automation", "unknown", "main"]);
});

async function sourceFixture(t: test.TestContext, rows: any[], tailBytes?: number) {
  const root = await mkdtemp(join(tmpdir(), "bookkeeping-heartbeat-"));
  const file = join(root, "source.jsonl");
  await writeFile(file, jsonl(header, ...rows));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config: BookkeepingConfig = { ...defaults, providers: [{ schema_version: 1, provider: "codex", enabled: true, account_id: "synthetic", roots: [root], options: tailBytes ? { tail_bytes: tailBytes } : {} }] };
  const request: CollectRequest = {
    lane: "live", cutoff: "2026-09-30T12:00:00Z",
    range: { schema_version: 1, from: "2026-09-30T00:00:00Z", to: "2026-09-30T12:00:00Z" },
    budget: { max_bytes: 1024 * 1024, max_directory_entries: 20, max_duration_ms: 10000 },
  };
  async function collect(checkpoints: SourceCheckpoint[] = []) {
    const adapter = new FileAdapter(config.providers[0], config);
    const batches: CollectionBatch[] = [];
    try { for await (const batch of adapter.collect(request, { config, checkpoints })) batches.push(batch); }
    finally { await adapter.close(); }
    const map = new Map(checkpoints.map(checkpoint => [checkpoint.checkpoint_id, checkpoint]));
    for (const batch of batches) for (const checkpoint of batch.checkpoints) map.set(checkpoint.checkpoint_id, checkpoint);
    return { events: batches.flatMap(batch => batch.events), checkpoints: [...map.values()], gaps: batches.flatMap(batch => batch.coverage.flatMap(coverage => coverage.gaps)) };
  }
  return { file, collect };
}

test("Codex heartbeat origin survives file checkpoint restart; old cursor and malformed line do not guess origin", async t => {
  const { file, collect } = await sourceFixture(t, [message("user", packet, "turn-1", "heartbeat")]);
  const first = await collect();
  await appendFile(file, jsonl(message("assistant", "synthetic append", "turn-1", "assistant")));
  const second = await collect(structuredClone(first.checkpoints));
  assert.equal(second.events[0].classification, "automation");
  assert.deepEqual(second.events[0].context.automation_origin, first.events[0].context.automation_origin);
  const legacy = structuredClone(second.checkpoints);
  for (const checkpoint of legacy) if (checkpoint.locator === file) delete (checkpoint.cursor.parse_state as ParseState).codex_turn_origin;
  await appendFile(file, jsonl(message("assistant", "synthetic old cursor", "turn-1", "unknown")));
  const old = await collect(legacy);
  assert.equal(old.events[0].classification, "unknown");
  assert.ok(old.gaps.some(gap => gap.reason === "source_turn_origin_unknown"));
  await appendFile(file, "{bad\n" + jsonl(message("assistant", "synthetic malformed boundary", "turn-1", "unknown2"), message("user", "synthetic human restored", "turn-2", "human")));
  const broken = await collect(second.checkpoints);
  assert.deepEqual(broken.events.map(event => event.classification), ["automation", "unknown", "main"]);
});

test("Codex tail starting after heartbeat stays unknown while proved automation recapture bypasses native dedup", async t => {
  const { file, collect } = await sourceFixture(t, [
    message("user", packet, "turn-1", "heartbeat"),
    { type: "response_item", payload: { type: "reasoning", encrypted_content: "synthetic padding".repeat(10000) } },
    message("assistant", "synthetic tail automation", "turn-1", "tail"),
  ], 1024);
  const tail = await collect();
  assert.deepEqual(tail.events.map(event => event.classification), ["unknown"]);
  assert.ok(tail.gaps.some(gap => gap.reason === "source_turn_origin_unknown"));
  const replay = structuredClone(tail.checkpoints);
  for (const checkpoint of replay) if (checkpoint.locator === file) {
    checkpoint.cursor.offset = 0;
    checkpoint.cursor.anchor = "";
    checkpoint.cursor.pending_line_base64 = "";
    checkpoint.cursor.parse_state = {};
  }
  const recaptured = await collect(replay);
  assert.equal(recaptured.events.find(event => event.source.message_id === "tail")?.classification, "automation");
  assert.equal(recaptured.events.find(event => event.source.message_id === "tail")?.event_id, tail.events[0].event_id);
});
