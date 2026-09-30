import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  appendFile,
  rename,
  open,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAdapters,
  parseLossless,
  parseTime,
  parseWechatHistory,
  WechatAdapter,
  parseChatExport,
} from "../../src/adapters/index.ts";
import type {
  BookkeepingConfig,
  CollectRequest,
  CollectionBatch,
  SourceCheckpoint,
} from "../../src/contracts/types.ts";
const cfg = (provider = "codex", roots: string[] = []): BookkeepingConfig => ({
  schema_version: 1,
  wiki_root: "/synthetic/wiki",
  data_dir: "/synthetic/data",
  journal_timezone: "Europe/Amsterdam",
  analysis_timezone: "Europe/Amsterdam",
  cutover_at: "2026-09-30T00:00:00Z",
  live_start: "2026-09-30T00:00:00Z",
  journal_timezone_timeline: [],
  providers: [
    {
      schema_version: 1,
      provider,
      enabled: true,
      account_id: "self",
      roots,
      options: {},
    },
  ],
  limits: {
    chunk_events: 80,
    chunk_body_bytes: 32768,
    bundle_bytes: 131072,
    bundles_per_round: 4,
  },
  project_whitelist: [],
  goal_whitelist: [],
});
const req = (lane: "live" | "history" = "live"): CollectRequest => ({
  lane,
  cutoff: "2026-09-30T21:30:00Z",
  range: {
    schema_version: 1,
    from: "2026-09-28T00:00:00Z",
    to: "2026-09-30T21:30:00Z",
  },
  budget: {
    max_duration_ms: 10000,
    max_bytes: 64 * 1024 * 1024,
    max_directory_entries: 2000,
  },
});
const head = (id = "sess") => ({
  timestamp: "2026-09-30T12:00:00Z",
  type: "session_meta",
  payload: { id, source: "vscode", originator: "Codex Desktop" },
});
const user = (body = "hello", id?: string) => ({
  timestamp: "2026-09-30T12:01:00Z",
  type: "event_msg",
  payload: { type: "user_message", message: body, ...(id ? { id } : {}) },
});
const lines = (...rows: any[]) =>
  rows.map((r) => JSON.stringify(r) + "\n").join("");
async function collect(
  config: BookkeepingConfig,
  request = req(),
  checkpoints: SourceCheckpoint[] = [],
) {
  const out: CollectionBatch[] = [];
  const adapter = createAdapters(config)[0];
  try {
    for await (const b of adapter.collect(request, { config, checkpoints }))
      out.push(b);
  } finally {
    if ("close" in adapter) await (adapter as any).close();
  }
  return out;
}
function checkpoints(batches: CollectionBatch[], old: SourceCheckpoint[] = []) {
  const map = new Map(old.map((x) => [x.checkpoint_id, x]));
  for (const b of batches)
    for (const c of b.checkpoints) map.set(c.checkpoint_id, c);
  return [...map.values()];
}
const events = (b: CollectionBatch[]) => b.flatMap((x) => x.events);
test("lossless parses numeric IDs before JS rounding", () => {
  assert.equal(
    parseLossless(
      '{"id":9223372036854775807,"text":"id 9223372036854775807","n":2}',
    ).id,
    "9223372036854775807",
  );
  assert.equal(parseLossless('{"id":9007199254740993}').id, "9007199254740993");
});
test("desktop Codex user response/voice/final/commentary and mirror handling", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bk-adapter-"));
  await writeFile(
    path.join(dir, "a.jsonl"),
    lines(
      head(),
      user("hello"),
      {
        timestamp: "2026-09-30T12:01:00Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          id: "u",
          content: [{ type: "input_text", text: "hello" }],
        },
      },
      user("hello"),
      {
        timestamp: "2026-09-30T12:02:00Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          id: "a",
          phase: "commentary",
          content: [{ type: "output_text", text: "work" }],
        },
      },
      {
        timestamp: "2026-09-30T12:03:00Z",
        type: "event_msg",
        payload: {
          type: "transcript_segment",
          session_id: "sess",
          id: "voice",
          role: "user",
          text: "spoken",
        },
      },
    ),
  );
  const e = events(await collect(cfg("codex", [dir])));
  assert.equal(e.length, 4);
  assert.notEqual(e[0].event_id, e[1].event_id);
  assert.equal(e[2].channel, "commentary");
  assert.equal(e[3].kind, "voice_transcript");
  assert.equal(new Set(e.map((x) => x.event_id)).size, e.length);
});
test("Claude same message multi blocks and distinct multiple finals survive", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bk-claude-"));
  await writeFile(
    path.join(dir, "a.jsonl"),
    lines(
      {
        type: "assistant",
        sessionId: "c",
        timestamp: "2026-09-30T12:00:00Z",
        message: {
          id: "m",
          role: "assistant",
          content: [
            { type: "text", text: "one" },
            { type: "text", text: "two" },
          ],
          stop_reason: "end_turn",
        },
      },
      {
        type: "assistant",
        sessionId: "c",
        timestamp: "2026-09-30T12:01:00Z",
        message: {
          id: "m",
          role: "assistant",
          content: [{ type: "text", text: "three" }],
          stop_reason: "end_turn",
        },
      },
    ),
  );
  const e = events(await collect(cfg("claude", [dir])));
  assert.equal(e.length, 3);
  assert.equal(new Set(e.map((x) => x.event_id)).size, 3);
});
test("append half line, move and truncation maintain stable IDs and independent history", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bk-increment-"));
  const file = path.join(dir, "a.jsonl");
  const row = JSON.stringify(user("split", "m"));
  await writeFile(file, lines(head()) + row.slice(0, 25));
  const config = cfg("codex", [dir]);
  const first = await collect(config);
  assert.equal(events(first).length, 0);
  await appendFile(file, row.slice(25) + "\n");
  const second = await collect(config, req(), checkpoints(first));
  assert.equal(events(second).length, 1);
  const id = events(second)[0].event_id;
  const moved = path.join(dir, "b.jsonl");
  await rename(file, moved);
  const third = await collect(
    config,
    req(),
    checkpoints(second, checkpoints(first)),
  );
  assert.equal(events(third).length, 0);
  await writeFile(moved, lines(head(), user("rewritten", "n")));
  const fourth = await collect(
    config,
    req(),
    checkpoints(third, checkpoints(second, checkpoints(first))),
  );
  assert.equal(events(fourth).length, 1);
  assert.notEqual(events(fourth)[0].generation, "0");
  assert.notEqual(events(fourth)[0].event_id, id);
});
test("empty 2GB sparse file bootstraps tail bounded without prefix scan", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bk-big-"));
  const file = path.join(dir, "huge.jsonl");
  const f = await open(file, "w");
  const size = 2 * 1024 * 1024 * 1024;
  await f.write(lines(head()), 0, "utf8");
  await f.truncate(size);
  const tail = Buffer.from("\n" + lines(user("today", "today")));
  await f.write(tail, 0, tail.length, size - tail.length);
  await f.close();
  const config = cfg("codex", [dir]);
  const b = await collect(config);
  assert.equal(events(b).length, 1);
  assert(
    b
      .flatMap((x) => x.coverage)
      .some((c) =>
        c.gaps.some((g) => g.reason.startsWith("unread_history_prefix")),
      ),
  );
  assert(
    b
      .flatMap((x) => x.fragments)
      .reduce((n, f) => n + Buffer.from(f.bytes_base64, "base64").length, 0) <=
      8 * 1024 * 1024 + 64 * 1024,
  );
  const live = checkpoints(b).find((x) => x.locator === file)!;
  assert(live.cursor.offset === size);
  const hist = await collect(config, req("history"), checkpoints(b));
  const h = checkpoints(hist).find((x) => x.locator === file)!;
  assert.equal(h.lane, "history");
  assert(Number(h.cursor.offset) < Number(live.cursor.offset));
});
test("structural exclusions and missing source isolated", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bk-exclude-"));
  await writeFile(
    path.join(dir, "bad.jsonl"),
    lines(
      {
        ...head("sub"),
        payload: { id: "sub", source: { subagent: { parent_thread_id: "p" } } },
      },
      user(),
    ),
  );
  await writeFile(
    path.join(dir, "good.jsonl"),
    lines(head("good"), user("safe")),
  );
  const out = await collect(cfg("codex", ["/no-such-fixture", dir]));
  assert.equal(events(out).length, 1);
  assert.equal(events(out)[0].source.conversation_id, "good");
});
test("timezone timeline follows historical location and DST rejects ambiguity", async () => {
  assert.equal(
    parseTime("2026-10-25 02:30:00", "Europe/Amsterdam").reason,
    "ambiguous_local_time",
  );
  assert.equal(
    parseTime("2026-03-29 02:30:00", "Europe/Amsterdam").reason,
    "nonexistent_local_time",
  );
  assert.equal(parseTime("2026-09-30 12:00:00").utc, null);
  const dir = await mkdtemp(path.join(tmpdir(), "bk-zone-"));
  await writeFile(
    path.join(dir, "a.jsonl"),
    lines(head(), { ...user(), timestamp: "2026-09-30T22:30:00Z" }),
  );
  const config = cfg("codex", [dir]);
  config.journal_timezone_timeline = [
    {
      schema_version: 1,
      effective_from: "2026-09-01T00:00:00Z",
      timezone: "Asia/Shanghai",
      basis: "travel-confirmed",
    },
  ];
  const e = events(await collect(config))[0];
  assert.equal(e.journal_date.value, "2026-10-01");
  assert.equal(e.journal_timezone_basis, "travel-confirmed");
});
test("bad line does not attribute implicit voice; tool output never user", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bk-bad-"));
  await writeFile(
    path.join(dir, "a.jsonl"),
    lines(head()) +
      "{invalid}\n" +
      lines(
        {
          timestamp: "2026-09-30T12:01:00Z",
          type: "event_msg",
          payload: { type: "transcript_segment", text: "ambiguous" },
        },
        {
          timestamp: "2026-09-30T12:01:00Z",
          type: "response_item",
          payload: { type: "function_call_output", output: "tool" },
        },
        user("real"),
      ),
  );
  const out = await collect(cfg("codex", [dir]));
  assert.equal(events(out).length, 1);
  assert(
    out
      .flatMap((b) => b.coverage)
      .some((c) => c.gaps.some((g) => g.reason.startsWith("malformed"))),
  );
});
function wxconfig() {
  const config = cfg("wechat");
  config.providers[0].options = {
    bundle_id: "synthetic.bundle",
    chats: ["friend"],
    self_ids: ["owner"],
    identity_verified: true,
    coverage_verified: true,
    cursor_readonly_verified: true,
    verified_ranges_by_chat: {
      friend: [{ from: req().range.from, to: req().range.to }],
      "g@chatroom": [{ from: req().range.from, to: req().range.to }],
    },
    limit: 5,
  };
  return config;
}
const wxrow = (id: string, sender = "owner", time = 1790769660) => ({
  server_id: id,
  chat_id: "friend",
  sender_wxid: sender,
  create_time: time,
  message_kind: "text",
  message_content: "same",
});
const wxpayload = (rows: any[]) =>
  JSON.stringify({
    meta: {
      status: "windowed",
      since_resolved: Date.parse(req().range.from) / 1000,
      until_resolved: Date.parse(req().range.to) / 1000,
      shards_scanned: 1,
      shards_hit: 1,
    },
    rows,
  });
test("wechat runner is readonly explicit account/bundle no transcribe and repeated IDs stable", async () => {
  const config = wxconfig();
  let calls = 0;
  const adapter = new WechatAdapter(
    config.providers[0],
    config,
    async (bin, args) => {
      calls++;
      assert.deepEqual(args.slice(0, 5), [
        "--account",
        "self",
        "--bundle-id",
        "synthetic.bundle",
        "history",
      ]);
      assert(args.includes("--no-transcribe"));
      assert(
        !args.some((x) =>
          ["send", "new-messages", "init", "--brief"].includes(x),
        ),
      );
      return wxpayload([
        wxrow("9223372036854775807"),
        wxrow("9223372036854775807"),
        wxrow("9007199254740993"),
      ]);
    },
  );
  const out = [];
  for await (const b of adapter.collect(req(), { config, checkpoints: [] }))
    out.push(b);
  assert.equal(calls, 1);
  assert.equal(events(out).length, 2);
  assert.equal(events(out)[0].source.message_id, "9223372036854775807");
});
test("wechat cap, unknown self, stale, media and raw malformed stay partial", () => {
  const config = wxconfig();
  const source = config.providers[0];
  source.options.identity_verified = false;
  source.options.limit = 1;
  const parsed = parseWechatHistory(
    wxpayload([{ ...wxrow("1"), message_kind: "voice", sender_wxid: null }]),
    source,
    "friend",
    req(),
    config,
  );
  assert(parsed.gaps.some((x) => x.reason.includes("identity")));
  assert(parsed.gaps.some((x) => x.reason.includes("limit_hit")));
  assert(parsed.gaps.some((x) => x.reason.includes("media")));
  assert.equal(parsed.events[0].role, "unknown");
  assert.throws(() =>
    parseWechatHistory("[]", source, "friend", req(), config),
  );
});
test("wechat group keeps participation +/-20min context only and scoped identities", () => {
  const config = wxconfig(),
    source = config.providers[0];
  const chat = "g@chatroom";
  const rows = [
    { ...wxrow("1", "other"), chat_id: chat, create_time: 1790766000 },
    { ...wxrow("2", "owner"), chat_id: chat, create_time: 1790769660 },
    { ...wxrow("3", "other"), chat_id: chat, create_time: 1790770000 },
  ];
  const p = parseWechatHistory(wxpayload(rows), source, chat, req(), config);
  assert.equal(p.events.length, 2);
});
test("ChatLab JSON/JSONL and legacy import preserve IDs, repetitions, no-offset pending", () => {
  const config = cfg("wechat");
  const manifest = {
    account_id: "self",
    conversation_id: "c",
    owner_id: "owner",
    identity_verified: true,
    locator: "fixture:1",
  };
  const doc = {
    chatlab: { version: "0.0.2" },
    meta: { type: "private" },
    members: [{ platformId: "owner" }],
    messages: [
      {
        sender: "owner",
        timestamp: 1790769660,
        type: 0,
        content: "hi",
        platformMessageId: "9223372036854775807",
      },
    ],
  };
  const json = parseChatExport(
    JSON.stringify(doc),
    "chatlab-json",
    manifest,
    config,
  );
  assert.equal(json.events[0].source.message_id, "9223372036854775807");
  assert.equal(json.events[0].role, "user");
  assert(json.gaps.some((g) => g.reason.includes("coverage")));
  const jsonl = parseChatExport(
    lines(
      { _type: "header", chatlab: doc.chatlab, meta: doc.meta },
      { _type: "member", ...doc.members[0] },
      { _type: "message", ...doc.messages[0] },
    ),
    "chatlab-jsonl",
    manifest,
    config,
  );
  assert.equal(jsonl.events[0].event_id, json.events[0].event_id);
  const legacy = lines(
    {
      source: "f",
      chat: "c",
      timestamp: "2026-09-30 12:00:00",
      sender: "Roy",
      message_type: "text",
      content: "repeat",
      source_offset: 10,
    },
    {
      source: "f",
      chat: "c",
      timestamp: "2026-09-30 12:00:00",
      sender: "Roy",
      message_type: "text",
      content: "repeat",
      source_offset: 11,
    },
  );
  const p = parseChatExport(legacy, "legacy-jsonl", manifest, config);
  assert.equal(p.events[0].utc_time.value, null);
  assert.equal(p.events[0].role, "other");
  assert.notEqual(p.events[0].event_id, p.events[1].event_id);
  const zoned = parseChatExport(
    legacy,
    "legacy-jsonl",
    { ...manifest, source_timezone: "Asia/Shanghai" },
    config,
  );
  assert.equal(zoned.events[0].utc_time.value, "2026-09-30T04:00:00.000Z");
});
test("history captures complete prefix in independent advancing checkpoint", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bk-history-"));
  const file = path.join(dir, "a.jsonl");
  await writeFile(
    file,
    lines(
      head(),
      ...Array.from({ length: 80 }, (_, i) => ({
        ...user("x".repeat(1000), `m${i}`),
        timestamp: "2026-09-29T12:00:00Z",
      })),
      user("today", "latest"),
    ),
  );
  const config = cfg("codex", [dir]);
  config.providers[0].options.tail_bytes = 1024;
  const live = await collect(config);
  const lc = checkpoints(live).find((x) => x.locator === file)!;
  assert(Number(lc.cursor.history_end) > 0);
  const hist = await collect(config, req("history"), checkpoints(live));
  assert(events(hist).length > 0);
  const hc = checkpoints(hist).find((x) => x.locator === file)!;
  assert.equal(hc.cursor.history_end, lc.cursor.history_end);
  assert.equal(hc.cursor.offset, hc.cursor.history_end);
  const again = await collect(
    config,
    req("history"),
    checkpoints(hist, checkpoints(live)),
  );
  assert.equal(events(again).length, 0);
});
test("bounded discovery resumes rotating entries without relying on filename UUID", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bk-discover-"));
  for (let i = 0; i < 9; i++)
    await writeFile(
      path.join(dir, `f${i}.jsonl`),
      lines(head(`thread${i}`), user("a", `m${i}`)),
    );
  const config = cfg("codex", [dir]);
  const request = req();
  request.budget.max_directory_entries = 2;
  let cp: SourceCheckpoint[] = [];
  const seen = new Set();
  const adapter = createAdapters(config)[0];
  for (let i = 0; i < 8; i++) {
    const b: CollectionBatch[] = [];
    for await (const batch of adapter.collect(request, {
      config,
      checkpoints: cp,
    }))
      b.push(batch);
    cp = checkpoints(b, cp);
    events(b).forEach((e) => seen.add(e.event_id));
  }
  assert.equal(seen.size, 9);
  await (adapter as any).close();
});
test("captures events after frozen cutoff for later accurate-date review without losing bytes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bk-cutoff-"));
  await writeFile(
    path.join(dir, "a.jsonl"),
    lines(head(), {
      ...user("late", "late"),
      timestamp: "2026-09-30T21:31:00Z",
    }),
  );
  const e = events(await collect(cfg("codex", [dir])));
  assert.equal(e.length, 1);
  assert.equal(e[0].utc_time.value, "2026-09-30T21:31:00.000Z");
});
test("unavailable provider does not claim zero activity and runner failure isolates chats", async () => {
  const config = wxconfig();
  config.providers[0].options.chats = ["bad", "friend"];
  const adapter = new WechatAdapter(
    config.providers[0],
    config,
    async (bin, args) => {
      if (args[args.indexOf("--chat") + 1] === "bad")
        throw new Error("offline");
      return wxpayload([wxrow("1")]);
    },
  );
  const out = [];
  for await (const b of adapter.collect(req(), { config, checkpoints: [] }))
    out.push(b);
  assert.equal(out[0].coverage[0].capture_status, "unavailable");
  assert.equal(events(out).length, 1);
});
test("wechat query UTC boundary is truly half open independent of ISO fractional spelling", () => {
  const config = wxconfig();
  const end = Date.parse(req().range.to) / 1000;
  const p = parseWechatHistory(
    wxpayload([wxrow("1", "owner", end), wxrow("2", "owner", end - 1)]),
    config.providers[0],
    "friend",
    req(),
    config,
  );
  assert.equal(p.events.length, 1);
  assert.equal(p.events[0].source.message_id, "2");
});
test("same native Codex final ID with distinct body blocks preserves both final outputs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bk-finals-"));
  await writeFile(
    path.join(dir, "a.jsonl"),
    lines(
      head(),
      ...["first", "second"].map((text) => ({
        timestamp: "2026-09-30T12:01:00Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          id: "same-final",
          phase: "final",
          content: [{ type: "output_text", text }],
        },
      })),
    ),
  );
  const e = events(await collect(cfg("codex", [dir])));
  assert.equal(e.length, 2);
  assert.notEqual(e[0].event_id, e[1].event_id);
});
test("long history JSONL record reconstructs bounded persisted continuation before parsing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bk-long-"));
  const file = path.join(dir, "a.jsonl");
  const body = "x".repeat(2 * 1024 * 1024 + 500);
  await writeFile(file, lines(head(), user(body, "huge")));
  const config = cfg("codex", [dir]);
  let cp: SourceCheckpoint[] = [];
  let found: ReturnType<typeof events> = [];
  for (let i = 0; i < 4; i++) {
    const b = await collect(config, req("history"), cp);
    cp = checkpoints(b, cp);
    found.push(...events(b));
  }
  assert.equal(found.length, 1);
  assert.equal(found[0].body?.length, body.length);
  assert.equal(
    cp.find((c) => c.locator === file)?.cursor.pending_line_base64,
    "",
  );
});
test("file coverage and discovery can complete frozen snapshot after history prefix caught up", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bk-complete-"));
  await writeFile(path.join(dir, "a.jsonl"), lines(head(), user("one", "1")));
  const config = cfg("codex", [dir]);
  const b = await collect(config);
  assert(
    b.flatMap((x) => x.coverage).some((c) => c.capture_status === "complete"),
  );
  assert(
    !b
      .flatMap((x) => x.coverage)
      .some((c) => c.gaps.some((g) => g.reason.includes("late_arrivals"))),
  );
});
test("checkpoint isolation includes account/source roots and symlink replacement cannot escape scope", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bk-scope-"));
  const outside = await mkdtemp(path.join(tmpdir(), "bk-outside-"));
  const file = path.join(dir, "a.jsonl");
  await writeFile(file, lines(head(), user("allowed", "same")));
  const config = cfg("codex", [dir]);
  const first = await collect(config);
  const other = cfg("codex", [dir]);
  other.providers[0].account_id = "different";
  const isolated = await collect(other, req(), checkpoints(first));
  assert.equal(events(isolated).length, 1);
  assert.notEqual(events(isolated)[0].event_id, events(first)[0].event_id);
  const { unlink, symlink } = await import("node:fs/promises");
  await writeFile(
    path.join(outside, "hidden.jsonl"),
    lines(head(), user("outside", "outside")),
  );
  await unlink(file);
  await symlink(path.join(outside, "hidden.jsonl"), file);
  const rejected = await collect(config, req(), checkpoints(first));
  assert.equal(events(rejected).length, 0);
  assert(
    rejected
      .flatMap((x) => x.coverage)
      .some((c) => c.capture_status === "unavailable"),
  );
});
test("real-shaped realtime_item envelope and turn context; analysis is excluded", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bk-realtime-"));
  await writeFile(
    path.join(dir, "a.jsonl"),
    lines(
      { ...head(), payload: { ...head().payload, thread_source: "user" } },
      {
        timestamp: "2026-09-30T12:00:00Z",
        type: "turn_context",
        payload: { cwd: "/synthetic/project" },
      },
      {
        timestamp: "2026-09-30T12:00:01Z",
        ordinal: 1,
        type: "realtime_item",
        payload: {
          type: "transcript_segment",
          session_id: "sess",
          id: "segment",
          role: "user",
          text: "voice",
        },
      },
      {
        timestamp: "2026-09-30T12:00:02Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          channel: "analysis",
          content: [{ type: "output_text", text: "hidden" }],
        },
      },
      {
        timestamp: "2026-09-30T12:00:03Z",
        type: "response_item",
        payload: { type: "reasoning", encrypted_content: "hidden" },
      },
      {
        timestamp: "2026-09-30T12:00:04Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          id: "final",
          content: [{ type: "output_text", text: "done" }],
        },
      },
    ),
  );
  const e = events(await collect(cfg("codex", [dir])));
  assert.equal(e.length, 2);
  assert.equal(e[0].kind, "voice_transcript");
  assert.equal(e[0].context.cwd, "/synthetic/project");
  assert.equal(e[1].channel, "final_answer");
});
test("2000-entry cap reports actual skipped budget, explicit raised budget resumes across restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bk-entries-"));
  const { mkdir } = await import("node:fs/promises");
  for (let i = 0; i < 2010; i++)
    await mkdir(path.join(dir, `d${String(i).padStart(4, "0")}`));
  const config = cfg("codex", [dir]);
  const first = await collect(config);
  const firstCp = checkpoints(first);
  const restarted = await collect(config, req(), firstCp);
  assert(
    restarted
      .flatMap((b) => b.coverage)
      .some((c) =>
        c.gaps.some((g) => g.reason.includes("minimum_directory_budget:2001")),
      ),
  );
  config.providers[0].options.max_directory_entries = 8192;
  const resumed = await collect(config, req(), checkpoints(restarted, firstCp));
  assert(
    resumed
      .flatMap((b) => b.coverage)
      .some((c) => c.capture_status === "complete"),
  );
});
test("wechat per-chat numeric real_sender_id never uses a global magic self ID", () => {
  const config = wxconfig();
  const source = config.providers[0];
  source.options.self_ids = ["2"];
  const row = { ...wxrow("1"), sender_wxid: null, real_sender_id: "2" };
  const raw = wxpayload([row]).replace(
    '"server_id":"1"',
    '"server_id":9223372036854775807',
  );
  const unknown = parseWechatHistory(raw, source, "friend", req(), config);
  assert.equal(unknown.events[0].role, "unknown");
  assert.equal(unknown.events[0].source.message_id, "9223372036854775807");
  source.options.self_ids_by_chat = { friend: ["2"] };
  const mapped = parseWechatHistory(raw, source, "friend", req(), config);
  assert.equal(mapped.events[0].role, "user");
});
test("proved adjacent mirror across atomic batches emits once; subsequent true repeat survives", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bk-cross-mirror-"));
  const file = path.join(dir, "a.jsonl");
  await writeFile(file, lines(head(), user("same")));
  const config = cfg("codex", [dir]);
  const first = await collect(config);
  assert.equal(events(first).length, 1);
  const canonical = structuredClone(events(first)[0]);
  await appendFile(
    file,
    lines(
      {
        timestamp: "2026-09-30T12:01:00Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          id: "native",
          content: [{ type: "input_text", text: "same" }],
        },
      },
      user("same"),
    ),
  );
  const second = await collect(config, req(), checkpoints(first));
  assert.equal(events(second).length, 1);
  assert.notEqual(events(second)[0].event_id, canonical.event_id);
  assert.deepEqual(events(first)[0], canonical);
});
test("replay event fragment references are invariant under changed batch byte ranges", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bk-fragment-"));
  const file = path.join(dir, "a.jsonl");
  await writeFile(file, lines(head(), user("small", "stable")));
  const config = cfg("codex", [dir]);
  const initial = events(await collect(config))[0];
  await appendFile(file, lines(user("next", "another")));
  const replay = events(await collect(config, req("history"))).find(
    (e) => e.event_id === initial.event_id,
  )!;
  assert.equal(replay.fragment_ref, initial.fragment_ref);
  const strip = (e: any) => {
    const result = { ...e };
    delete result.locator;
    return result;
  };
  assert.deepEqual(strip(replay), strip(initial));
});
test("wechat native event is immutable across different window positions and raw batches", async () => {
  const config = wxconfig();
  let call = 0;
  const adapter = new WechatAdapter(config.providers[0], config, async () => {
    call++;
    return wxpayload(
      call === 1
        ? [wxrow("stable")]
        : [wxrow("previous", "other", 1790769600), wxrow("stable")],
    );
  });
  const first: CollectionBatch[] = [];
  for await (const b of adapter.collect(req(), { config, checkpoints: [] }))
    first.push(b);
  const second: CollectionBatch[] = [];
  for await (const b of adapter.collect(req(), { config, checkpoints: [] }))
    second.push(b);
  const a = events(first)[0],
    b = events(second).find((e) => e.event_id === a.event_id)!;
  assert.deepEqual(a, b);
  const af = first
    .flatMap((x) => x.fragments)
    .find((f) => f.fragment_id === a.fragment_ref);
  const bf = second
    .flatMap((x) => x.fragments)
    .find((f) => f.fragment_id === b.fragment_ref);
  assert.deepEqual(af, bf);
});
test("managed bundle route verifies unique live account binding every round without account flag", async () => {
  const config = wxconfig();
  config.providers[0].options.routing = "managed_bundle";
  let binding = "self";
  let accounts = 0,
    histories = 0;
  const adapter = new WechatAdapter(
    config.providers[0],
    config,
    async (binary, args) => {
      if (args[0] === "accounts") {
        accounts++;
        assert.deepEqual(args, ["accounts", "--json"]);
        return JSON.stringify({
          accounts: [{ bundle_id: "synthetic.bundle", wxid: binding }],
          default: null,
        });
      }
      histories++;
      assert.deepEqual(args.slice(0, 3), [
        "--bundle-id",
        "synthetic.bundle",
        "history",
      ]);
      assert(!args.includes("--account"));
      return wxpayload([wxrow("1")]);
    },
  );
  const good: CollectionBatch[] = [];
  for await (const b of adapter.collect(req(), { config, checkpoints: [] }))
    good.push(b);
  assert.equal(accounts, 1);
  assert.equal(histories, 1);
  assert.equal(events(good)[0].source.account_id, "self");
  binding = "wrong";
  const bad: CollectionBatch[] = [];
  for await (const b of adapter.collect(req(), { config, checkpoints: [] }))
    bad.push(b);
  assert.equal(accounts, 2);
  assert.equal(histories, 1);
  assert.equal(bad[0].coverage[0].capture_status, "unavailable");
});

test("bounded sessions discovery adds new private/group/FileHelper; excludes public and ignored chats", async () => {
  const config = wxconfig();
  const source = config.providers[0];
  source.options.chats = [];
  source.options.discover_sessions = true;
  source.options.sessions_limit = 6;
  source.options.ignored_chats = ["ignored"];
  source.options.pinned_chats = ["pinned"];
  const asked: string[] = [];
  const adapter = new WechatAdapter(source, config, async (bin, args) => {
    if (args.includes("sessions"))
      return JSON.stringify({
        meta: { status: "ok", unknown_shards: 0, unreadable_shards: 0 },
        rows: [
          { chat_type: "private", username: "new" },
          { chat_type: "group", username: "g@chatroom" },
          { chat_type: "unknown", username: "filehelper" },
          { chat_type: "private", username: "gh_public" },
          { chat_type: "private", username: "ignored" },
          { chat_type: "official_account", username: "systemholder" },
        ],
      });
    const chat = args[args.indexOf("--chat") + 1];
    asked.push(chat);
    return wxpayload([{ ...wxrow("1"), chat_id: chat }]);
  });
  const b = [];
  for await (const batch of adapter.collect(req(), { config, checkpoints: [] }))
    b.push(batch);
  assert.deepEqual(asked.sort(), ["filehelper", "g@chatroom", "new", "pinned"]);
  assert(
    b
      .flatMap((x) => x.coverage)
      .some((c) =>
        c.gaps.some((g) => g.reason === "wechat_sessions_limit_hit"),
      ),
  );
  assert(
    b
      .flatMap((x) => x.checkpoints)
      .some((c) => c.locator === "wechat:@discovery"),
  );
});
test("verified ranges prove only per-chat windows; new-copy missing prefix remains an explicit gap", () => {
  const config = wxconfig(),
    source = config.providers[0];
  delete source.options.verified_ranges_by_chat;
  source.options.coverage_verified = true;
  source.options.verified_since_by_chat = { friend: "2026-09-30T12:00:00Z" };
  const partial = parseWechatHistory(
    wxpayload([wxrow("1")]),
    source,
    "friend",
    req(),
    config,
  );
  const missing = partial.gaps.find(
    (g) => g.reason === "wechat_copy_history_range_unverified",
  )!;
  assert.equal(missing.range?.from, "2026-09-28T00:00:00.000Z");
  assert.equal(missing.range?.to, "2026-09-30T12:00:00.000Z");
  const later = {
    ...req(),
    range: {
      schema_version: 1 as const,
      from: "2026-09-30T12:00:00Z",
      to: req().range.to,
    },
  };
  const raw = JSON.stringify({
    meta: {
      status: "windowed",
      since_resolved: Date.parse(later.range.from) / 1000,
      until_resolved: Date.parse(later.range.to) / 1000,
      shards_hit: 1,
      shards_scanned: 1,
      unknown_shards: [],
      unreadable_shards: [],
    },
    rows: [wxrow("1")],
  });
  assert(
    !parseWechatHistory(raw, source, "friend", later, config).gaps.some(
      (g) => g.reason === "wechat_copy_history_range_unverified",
    ),
  );
  assert(
    parseWechatHistory(raw, source, "unproved-chat", later, config).gaps.some(
      (g) => g.reason === "wechat_copy_history_range_unverified",
    ),
  );
});
test("nonempty unknown shard arrays and service holder private metadata remain partial/excluded", async () => {
  const config = wxconfig(),
    source = config.providers[0];
  const raw = parseLossless(wxpayload([wxrow("1")]));
  raw.meta.unknown_shards = ["missing.db"];
  raw.meta.unreadable_shards = [];
  const p = parseWechatHistory(
    JSON.stringify(raw),
    source,
    "friend",
    req(),
    config,
  );
  assert(
    p.gaps.some((g) => g.reason === "wechat_unknown_or_unreadable_shards"),
  );
  source.options.chats = [];
  source.options.discover_sessions = true;
  let histories = 0;
  const adapter = new WechatAdapter(source, config, async (bin, args) => {
    if (args.includes("sessions"))
      return JSON.stringify({
        meta: { status: "ok", unknown_shards: [], unreadable_shards: [] },
        rows: [{ username: "brandservicesessionholder", chat_type: "private" }],
      });
    histories++;
    return wxpayload([]);
  });
  for await (const b of adapter.collect(req(), { config, checkpoints: [] })) {
  }
  assert.equal(histories, 0);
});
test("group query captures 20 minute preceding context and marks it separate from in-range participation", async () => {
  const config = wxconfig(),
    source = config.providers[0];
  source.options.chats = ["g@chatroom"];
  const request = {
    ...req(),
    range: {
      schema_version: 1 as const,
      from: "2026-09-30T12:00:00Z",
      to: "2026-09-30T13:00:00Z",
    },
  };
  const start = Date.parse(request.range.from) / 1000;
  const adapter = new WechatAdapter(source, config, async (bin, args) => {
    assert.equal(args[args.indexOf("--since") + 1], String(start - 1200));
    assert.equal(
      args[args.indexOf("--until") + 1],
      String(Date.parse(request.range.to) / 1000 + 1200),
    );
    return JSON.stringify({
      meta: {
        status: "windowed",
        since_resolved: start - 1200,
        until_resolved: Date.parse(request.range.to) / 1000 + 1200,
        shards_scanned: 1,
        shards_hit: 1,
      },
      rows: [
        { ...wxrow("previous", "other", start - 60), chat_id: "g@chatroom" },
        { ...wxrow("anchor", "owner", start + 60), chat_id: "g@chatroom" },
      ],
    });
  });
  const out = [];
  for await (const b of adapter.collect(request, { config, checkpoints: [] }))
    out.push(b);
  const e = events(out);
  assert.equal(e.length, 2);
  assert.equal(e[0].context.context_only, true);
  assert.equal(e[1].context.context_only, undefined);
});
test("WeChat history persists bounded split windows and asc newest subset eventually reaches older messages", async () => {
  const config = wxconfig(),
    source = config.providers[0];
  source.options.limit = 2;
  source.options.history_queries_per_round = 3;
  const start = Date.parse("2026-09-30T12:00:00Z") / 1000;
  const request = {
    ...req("history"),
    range: {
      schema_version: 1 as const,
      from: new Date(start * 1000).toISOString(),
      to: new Date((start + 8) * 1000).toISOString(),
    },
  };
  source.options.verified_ranges_by_chat = {
    friend: [{ from: request.range.from, to: request.range.to }],
  };
  const rows = Array.from({ length: 8 }, (_, i) =>
    wxrow(String(i), "owner", start + i),
  );
  let queries = 0;
  let cp: SourceCheckpoint[] = [];
  const seen = new Set<string>();
  for (let round = 0; round < 10; round++) {
    const adapter = new WechatAdapter(source, config, async (bin, args) => {
      queries++;
      const from = Number(args[args.indexOf("--since") + 1]),
        to = Number(args[args.indexOf("--until") + 1]);
      return JSON.stringify({
        meta: {
          status: "windowed",
          since_resolved: from,
          until_resolved: to,
          shards_scanned: 1,
          shards_hit: 1,
        },
        rows: rows
          .filter((r) => r.create_time >= from && r.create_time < to)
          .slice(-2),
      });
    });
    const out: CollectionBatch[] = [];
    const before = queries;
    for await (const b of adapter.collect(request, { config, checkpoints: cp }))
      out.push(b);
    assert(queries - before <= 3);
    events(out).forEach((e) => seen.add(e.source.message_id!));
    cp = checkpoints(out, cp);
  }
  assert.equal(seen.size, 8);
  const history = cp.find((c) => c.locator === "wechat:friend")!.cursor
    .history as any;
  assert.equal(history.queue.length, 0);
  assert.equal(history.blocked.length, 0);
  const before = queries;
  const done = new WechatAdapter(source, config, async () => {
    queries++;
    throw new Error("should not requery completed fixed history");
  });
  for await (const b of done.collect(request, { config, checkpoints: cp })) {
  }
  assert.equal(queries, before);
});
test("WeChat same-second cap stops splitting and leaves explicit import gap without repeated page loop", async () => {
  const config = wxconfig(),
    source = config.providers[0];
  source.options.limit = 2;
  const time = Date.parse("2026-09-30T12:00:00Z") / 1000;
  const request = {
    ...req("history"),
    range: {
      schema_version: 1 as const,
      from: new Date(time * 1000).toISOString(),
      to: new Date((time + 1) * 1000).toISOString(),
    },
  };
  source.options.verified_ranges_by_chat = {
    friend: [{ from: request.range.from, to: request.range.to }],
  };
  let queries = 0;
  const adapter = new WechatAdapter(source, config, async () => {
    queries++;
    return JSON.stringify({
      meta: {
        status: "windowed",
        since_resolved: time,
        until_resolved: time + 1,
        shards_hit: 1,
        shards_scanned: 1,
      },
      rows: [wxrow("1", "owner", time), wxrow("2", "owner", time)],
    });
  });
  const first: CollectionBatch[] = [];
  for await (const b of adapter.collect(request, { config, checkpoints: [] }))
    first.push(b);
  assert(
    first
      .flatMap((x) => x.coverage)
      .some((c) => c.gaps.some((g) => g.reason.includes("dense_second"))),
  );
  for await (const b of adapter.collect(request, {
    config,
    checkpoints: checkpoints(first),
  })) {
  }
  assert.equal(queries, 1);
});
test("minute precision legacy timestamps preserve original wall time and require explicit source zone", () => {
  const config = cfg("wechat");
  const raw = lines({
    source: "f",
    source_offset: 42,
    timestamp: "2024-01-01 18:22",
    sender: "someone",
    message_type: "text",
    content: "fixture",
  });
  const manifest = {
    account_id: "self",
    conversation_id: "c",
    locator: "fixture",
  };
  const pending = parseChatExport(raw, "legacy-jsonl", manifest, config);
  assert.equal(pending.events[0].original_time.value, "2024-01-01 18:22");
  assert.equal(pending.events[0].time_precision, "minute");
  assert.equal(pending.events[0].utc_time.value, null);
  const zoned = parseChatExport(
    raw,
    "legacy-jsonl",
    { ...manifest, source_timezone: "Asia/Shanghai" },
    config,
  );
  assert.equal(zoned.events[0].utc_time.value, "2024-01-01T10:22:00.000Z");
  assert.equal(zoned.events[0].time_precision, "minute");
});
test("account copy verified_since applies to new private chats without proving earlier main history", () => {
  const config = wxconfig(),
    source = config.providers[0];
  delete source.options.verified_ranges_by_chat;
  source.options.copy_verified_since = "2026-09-30T12:00:00Z";
  const request = {
    ...req(),
    range: {
      schema_version: 1 as const,
      from: "2026-09-30T12:00:00Z",
      to: req().range.to,
    },
  };
  const raw = JSON.stringify({
    meta: {
      status: "windowed",
      since_resolved: Date.parse(request.range.from) / 1000,
      until_resolved: Date.parse(request.range.to) / 1000,
      shards_scanned: 1,
      shards_hit: 1,
    },
    rows: [{ ...wxrow("1"), chat_id: "new-private" }],
  });
  assert(
    !parseWechatHistory(raw, source, "new-private", request, config).gaps.some(
      (g) => g.reason === "wechat_copy_history_range_unverified",
    ),
  );
  assert(
    parseWechatHistory(raw, source, "new-private", req(), config).gaps.some(
      (g) => g.reason === "wechat_copy_history_range_unverified",
    ),
  );
});
test("source fragments remain immutable after path relocation and replay", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bk-raw-move-"));
  const file = path.join(dir, "first.jsonl");
  await writeFile(file, lines(head(), user("same", "id")));
  const config = cfg("codex", [dir]);
  const first = await collect(config);
  await rename(file, path.join(dir, "second.jsonl"));
  const replay = await collect(config, req("history"));
  const previous = new Map(
    first.flatMap((b) => b.fragments).map((f) => [f.fragment_id, f]),
  );
  for (const fragment of replay.flatMap((b) => b.fragments)) {
    if (previous.has(fragment.fragment_id))
      assert.deepEqual(fragment, previous.get(fragment.fragment_id));
  }
  assert.equal(events(replay)[0].event_id, events(first)[0].event_id);
});
