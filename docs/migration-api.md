# Migration / Import API

入口：`createMigrationService(store, config, { analytics?, budget? })`，返回 `importManifest(manifest)` 与 `migrateManifest(manifest)`。不执行任何旧业务代码，不直接使用 SQL。CLI composition 只需将两个方法接到 RuntimeServices 的对应端口；Analytics 通过 B 的公开 `importHistory` 端口接入。

所有输入路径为显式绝对 JSON/JSONL 文件；文件只读，symlink 最终文件不跟随，代码扩展名拒绝。manifest entry 的 `source_file_id` 必须由协调者在一致恢复快照中分配，建议 `sha256:<封存完整文件摘要>`。此身份不能取当前路径或摘要标题。`recorded_at` 是固定的迁移接受 UTC 时刻，重跑相同 entry 不改变。输入快照在迁移期间保持不可变；重新导出或截断不是旧文件的同身份更新。迁移模块不自行读生产目录来补配置。

```json
{
  "schema_version": 1,
  "manifest_id": "synthetic-import-1",
  "kind": "import",
  "entries": [{
    "kind": "chat_export",
    "path": "/private/tmp/synthetic/export.jsonl",
    "source_file_id": "sha256:<sealed-file-digest>",
    "recorded_at": "2026-09-30T12:00:00Z",
    "format": "legacy-jsonl",
    "account_id": "synthetic-account",
    "conversation_id": "synthetic-chat",
    "owner_id": "synthetic-owner",
    "identity_verified": true,
    "time_source": "create_time",
    "source_timezone": "Europe/Amsterdam",
    "known_range": {
      "schema_version": 1,
      "from": "2026-09-01T00:00:00Z",
      "to": "2026-10-01T00:00:00Z"
    },
    "pagination": {"limit_hit": true}
  }]
}
```

`format` 支持 `legacy-json|legacy-jsonl|chatlab-json|chatlab-jsonl`。JSON 文档允许顶层数组或顶层 messages/rows 数组；JSONL ChatLab 识别 header/member/message，header 的 0.0.2 version 跨续读保存。JSON 逐条读取并保存数组内 offset/context，下一轮从数组内续读，避免全文件初始化。`time_source=timestamp|create_time|epoch` 明确选择原字段；这些数字 epoch 按来源 seconds 约定处理，其他单位须先提供独立显式转换的导入数据，不自动猜单位。无 offset 的时间只按显式合法 IANA source_timezone 解读；null、非法 zone、DST 缺失/歧义只留下局部 pending。群会话使用明确 conversation_type=group（Wechat @chatroom 自动识别）；unknown 群身份保守为上下文，不能作为活动。manifest 的 owner/self_ids 与 identity_verified 是账号归属依据，文件名不证明身份。

每条原片段、SourceEvent、capture coverage 和 import checkpoint 在 `Store.saveCollection` 同一事务保存。稳定 native ID 沿用 live 身份；同消息正文/身份/UTC 冲突交给 Store 保存为局部 conflict，所有原片段保留。没有 native ID 时使用封存身份+原 byte offset+内容生成稳定本次导入身份，跨其他 export/live 疑似重复不自动合并，保留 gap 与 needs_review。群非 self/non-mentioned 消息保存为 context_only=true 并留参与窗 pending；明确 self/提及 anchor 只有在 known_range 内才 context_only=false。正常 review 围绕 anchor 使用同 account/chat 的±20分钟上下文，窗外群其他人消息不入活动。旧 complete、分页上限、未知 cursor、截断和媒体缺口永不证明全天完整；导入报告始终明确 partial/unknown，不以文件 EOF 等同 capture complete。

`kind=migration` 的 entries：

- `daily_journal`，`format=jsonl`：只接收 daily-journal-jsonl-v1，sections 内 string/object 均保存为未验证 legacy_record。locator 为 JSON.stringify([source_file_id,dailyID,section,itemIndex,contentSHA,occurrence])，事实 ID 是 legacy:SHA256(locator)。原年度文件、动态 section 名、重复同文和 object 完整保留；不是纯职业投影的旧正文不会出现在 Analytics 数据中。schema_*.json entries 跳过，不将 schema 当旧日记记录。
- `analytics_observation|analytics_weekly|analytics_review`，`format=jsonl`：原 record/raw bytes 永久保留在本机 legacy_analytics_history 工作记录中。只有显式 projections [{source_id,content_hash,professional_payload}] 才发送职业字段到 Analytics history 端口。mappings 包含确切 source_id、target_ref、target_content_hash，review 另需 weekly_ref 和 weekly_content_hash。迁移 reader 先核旧 hash/weekly revision，再由 Analytics Repository 验证新目标的真实 hash/ref；任一未知不转移确认。没有 port、职业投影或精确映射仍可查旧历史，并排 needs_review；新 revision 不继承旧确认。
- `pending_state`，`format=json|jsonl`：`category=collect|review|draft|consumer|index|out_of_scope|needs_review` 转普通 history lane 工作，不加载 graph/controller。原状态正文作为本机历史保留。index 的 files/path 只接受 Wiki 内当前文件，并按规范化绝对 path 合并稳定欠账，不让旧 complete 消掉欠账。未知 category 保守 needs_review，不改变新配置范围。

默认每次总预算 8 MiB/2000 records/30 秒，单条 256 KiB；factory budget 可显式调整，硬上限 256 MiB/100000 records/90 秒、单条 4 MiB。超限记录不推进虚假 checkpoint，留操作明确的 pending，其他 manifest 项仍能独立处理。坏 JSONL 行保存原片段并排局部缺口；预算没有覆盖的项返回 unread。结果按 entry 给状态、已保存数、读取字节与 next_offset，不暴露正文。读取统计与 source capture/review/file publish/consumer 完成分别判断。

重跑依赖事务中的稳定 migration_key 与独立 import cursor。Analytics 后续 reconciliation 可用同封存资料加新的显式 mappings/projections 重新运行，产生独立 reconciliation key；原历史与已保存事实不覆盖。队列中的预算/未知映射欠账不会阻塞 live lane；完成转换并不代表 backlog、微信来源覆盖或真实自动化验收完成。

运行 `npm run typecheck`、`node --test test/migration.test.ts`、`npm test`。本轮只使用临时合成资料与 SQLite；未读取真实私人源、修改旧年度 JSONL或执行生产迁移。生产 manifest 准备、一致快照、抽样恢复、真实覆盖与两轮 scheduled daily 仍由协调者验收。
