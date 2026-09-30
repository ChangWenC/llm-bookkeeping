# 数据格式与迁移映射

依据：`SPEC.md` 与允许读取的五份纯数据 JSON schema。本文没有检查任何旧源码、测试、补丁、Git diff 或真实私人正文。真实记录是否符合 schema 尚待协调者只读盘点和验收。

## 日记归档

`wiki/personal/_evidence/daily_journals/daily_YYYY.jsonl` 的旧格式为 `daily-journal-jsonl-v1`，每个非空行一个对象。必需字段：`schema_version`、`id`、`date`、`original_stem`、`title`、`summary`、`sections`、`links`、`sources`、`promoted_to`、`retention`、`created`、`updated`。`id` 形如 `daily:YYYY-MM-DD`；三个日期字段是无时区日历日期。`sections` 是动态键对象，每个值是数组，数组元素可为字符串或对象；不能把任意旧对象直接视为已验证事实。`retention` 为 `archived|pinned`，可选 `confidence` 与 `notes`。

既有年度 JSONL 永不重写。迁移保存原文件与原记录，并为每个 section/item 生成稳定 locator：封存文件身份 + dailyID + section/item 位置 + 内容摘要 + 重复出现序号。路径变更不是身份变化，真实重复条目不能因同文而吞掉。未经结构验证的叙述保留为 `legacy_record`；转换后的新归档是独立版本文件，包含完整原文、日期、locator 和 fact refs。

新 archive 与补记、更正共用有效事实视图。已归档日期或窗口外从未有日记的日期只新增补记，不复活 Markdown。旧原文中已有映射 fact 的部分不重复汇总；replace/retract 必须定位明确旧条目，缺 target 或冲突只让相关工作 pending。历史日期保留原日历归属，不能按当前旅行时区重新解释。

## Analytics observation

`self-analytics-observation-v1` 有 `id`、`logical_id`、`revision`、可选 `supersedes`、`content_hash`，以及 `date`、`occurred_at`、可空 `occurred_timezone`、可选 source/journal/analysis timezone。来源追溯由 `source_ref`、`source_hashes`、`dedup_key`、`semantic_fact_hash`、`verification` 等表示。`mapping_status` 可为 `mapped|in_scope_unmapped|context_only|mapped_activity_trace`；旧标签只作为声明，不能替代新的责任归因判断。

迁移分别保留逻辑身份与不可变 revision 身份。可靠映射表记录：旧文件身份、旧 id、旧 logical_id、旧 revision、旧 content_hash、新逻辑身份、新 revision 身份，以及映射依据。必须对确切内容和来源核对；不能仅按标题、摘要、内容相似或 cwd 建映射。无法可靠映射的旧记录保留为可查历史，相关聚合 coverage 标 partial；疑似重复的新旧记录不能同时作为独立能力证据汇总。

## Analytics weekly 与 review

`self-analytics-weekly-record-v1` 使用 `id`、`logical_id`、`revision`、可选 `supersedes`、`content_hash` 表示快照修订，记录 `week_started`、`week_ended`、`timezone`、`packet_id`、`packet_hash`、`coverage`、`coverage_status`、items、最多三个 confirmations 和 validation action。`coverage_status=ready` 或 calm_week 均不证明新版采集/审阅完整。新分析固定 Europe/Amsterdam 的周一至周日，历史记录仍保留原 timezone。

`self-analytics-review-event-v1` 是 append-only 历史事件，绑定 `weekly_id + weekly_revision + weekly_content_hash` 与 `target_id + target_content_hash`。决策包括 `confirm|reject|correct|retract|continue|narrow|abandon`。`retract` 绑定 `retracts_review_id + retracts_content_hash`；`correct|narrow` 必须有 correction。归因 overlay、重大决策 contract、能力候选 effect 均保留原事件与明确作用对象。

`self-analytics-review-input-v1` 是尚待接受的输入，包含同样的 weekly 精确绑定、最多三个 target decisions 与可选 action decision。输入文件不能当作已经接受的用户确认；必须与持久化 review event 区分。

迁移确认只绑定确切旧 revision。只有可靠映射同时验证 weekly revision/hash 与 target revision/hash 时，才能链接到对应新 revision；新 revision 不继承旧确认。已知旧确认保留原始历史，无法映射的确认保持历史可查并排队 `needs_review`，不扩大其效力。撤回 fold 必须重建可用 overlay；不能删原 review。重大决策只有有效、明确用户确认的 contract 对应的 subject、目标版本、期限与 trigger 规则才可触发。

## 状态转换

旧 graph、receipt、marker、run-dir 是待保存的历史材料，不能成为新运行前置或完整性证明。迁移按稳定 `migration_key` 建普通任务：待采、待审、草稿、consumer、index、out_of_scope、needs_review。保留旧 offset 的语义不确定性；未知前缀不能标完成，新 live/history 检查点分别建立。index 欠账按当前文件合并，不能将旧成功声明直接投射为新成功。

全量原数据、归档、review、人工内容和唯一临时材料长期保留。schema 只是格式约定；盘点、转换、采集完整、审阅完整、文件发布成功与消费者成功分别验收。
