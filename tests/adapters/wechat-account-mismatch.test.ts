import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WechatAdapter, type ReadonlyRunner } from "../../src/adapters/wechat.ts";
import { createStore } from "../../src/store/index.ts";
import { config as defaults } from "../../test/fixtures/basic.ts";
import type { BookkeepingConfig, CollectRequest, CollectionBatch } from "../../src/contracts/types.ts";

const request: CollectRequest = { lane: "history", cutoff: "2026-10-07T12:00:00Z",
  range: { schema_version: 1, from: "2026-10-07T00:00:00Z", to: "2026-10-07T12:00:00Z" },
  budget: { max_duration_ms: 10000, max_bytes: 1024 * 1024, max_directory_entries: 20 } };
for (const managed of [false, true]) {
  test(`history account mismatch fails closed and preserves its window while a peer chat continues (managed=${managed})`, async t => {
    const root = await mkdtemp(join(tmpdir(), "bookkeeping-wechat-account-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const config: BookkeepingConfig = { ...defaults, data_dir: join(root, "data"), wiki_root: join(root, "wiki"), providers: [{
      schema_version: 1, provider: "wechat", enabled: true, account_id: "synthetic-owner", roots: [], options: {
        bundle_id: "synthetic.bundle", ...(managed ? { routing: "managed_bundle" } : {}), chats: ["bad-chat", "good-chat"],
        identity_verified: true, self_ids: ["synthetic-owner"], cursor_readonly_verified: true,
        copy_verified_since: request.range.from, history_queries_per_round: 8, group_allowlist: [],
        chat_types: { "bad-chat": "private", "good-chat": "private" },
      },
    }] };
    let badCalls = 0, peerCalls = 0;
    const runner: ReadonlyRunner = async (_binary, args) => {
      assert.ok(!args.includes("--transcribe"));
      if (args.includes("accounts")) return JSON.stringify({ accounts: [{ bundle_id: "synthetic.bundle", wxid: "synthetic-owner" }] });
      assert.ok(args.includes("history") && args.includes("--no-transcribe"));
      const chat = args[args.indexOf("--chat") + 1];
      if (chat === "bad-chat") badCalls++; else peerCalls++;
      const since = Number(args[args.indexOf("--since") + 1]);
      const until = Number(args[args.indexOf("--until") + 1]);
      return JSON.stringify({ meta: { status: "windowed", account_id: chat === "bad-chat" ? "other-account" : "synthetic-owner",
        since_resolved: since, until_resolved: until, shards_scanned: 1, shards_hit: 1, unknown_shards: [], unreadable_shards: [] },
        rows: [{ chat_id: chat, server_id: `synthetic-${chat}`, sender_wxid: "synthetic-owner", create_time: since + 60,
          message_kind: "text", message_content: "Synthetic account-bound message" }] });
    };
    const store = await createStore(config);
    t.after(() => store.close());
    const batches: CollectionBatch[] = [];
    const adapter = new WechatAdapter(config.providers[0], config, runner);
    for await (const batch of adapter.collect(request, { config, checkpoints: [] })) { batches.push(batch); await store.saveCollection(batch); }
    const bad = batches.filter(batch => batch.coverage.some(coverage => coverage.conversation_id === "bad-chat"));
    assert.equal(bad.flatMap(batch => batch.events).length, 0);
    assert.ok(bad.some(batch => batch.coverage.some(coverage => coverage.capture_status === "partial" &&
      coverage.gaps.some(gap => gap.reason === "wechat_account_mismatch"))));
    const checkpoints = await store.getCheckpoints("wechat", "history");
    const badCheckpoint = checkpoints.find(checkpoint => checkpoint.locator === "wechat:bad-chat")!;
    assert.notEqual(badCheckpoint.cursor.enumeration_complete, true);
    assert.ok((badCheckpoint.cursor.history as any).queue.some((window: any) => window.from === request.range.from && window.to === request.range.to));
    assert.ok(peerCalls > 0 && badCalls > 0 && badCalls <= 4);
    const events = await store.listEvents({ range: request.range, source: "wechat" });
    assert.equal(events.length, 1);
    assert.equal(events[0].source.conversation_id, "good-chat");
    assert.equal(events[0].context.media_transcribed, false);
    const restarted = new WechatAdapter(config.providers[0], config, runner);
    for await (const batch of restarted.collect(request, { config, checkpoints })) await store.saveCollection(batch);
    assert.equal((await store.listEvents({ range: request.range, source: "wechat" })).length, 1);
    const retry = (await store.getCheckpoints("wechat", "history")).find(checkpoint => checkpoint.locator === "wechat:bad-chat")!.cursor.history as any;
    assert.ok(retry.queue.some((window: any) => window.from === request.range.from && window.to === request.range.to));
  });
}
