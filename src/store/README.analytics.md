# Analytics persistence

Only ready artifacts enter the Analytics ledger. Stored/output professional facts consist of the explicitly cropped AnalyticsProjection, exact FactRef, fact kind and occurred time; original mixed text, source bodies and cwd are not read. `project:<configured slug>` and `goal:<configured path>` are canonical scopes; bare configured values are accepted aliases. Career/learning uses `career_and_learning`. Unknown projects and life scopes are excluded.

Weekly input exposes application-assigned observation candidates and exact confirmed goal contracts. Semantic results must reference those exact observation revisions, professional fact revisions and confirmed goals. Coverage completeness requires provider/account discovery coverage and the completion of every relevant conversation scope; a complete chat cannot cover another chat's unknown history. Missing projection or unresolved legacy evidence produces partial Analytics material. Partial/unknown coverage cannot assert decline or divergence.

New contracts are candidate/confirmed:false. Only append-only user review events for the exact current revision activate them. Observation×capability overlays retain responsibility basis and exact evidence; correction/rejection/retraction rebuild them without altering history. Replaced fact/observation/goal versions do not inherit confirmation. A major decision requires an active exact confirmed goal/decision contract, subject/goal target version/deadline/validity match, and an ExplicitVerification with basis user_explicit_verification. Ordinary activity, inference, assistant output and cwd cannot trigger it. Notification identity is decision revision × fact revision.

The consumer stores immutable per-batch JSON output before acknowledging analytics. Cockpit updates use SafeWikiWriter and the shared Wiki lock, replacing only a uniquely delimited derived region. Manual changes in that region conflict; manual content outside it survives. Output/ack crashes can be retried without repeating semantic review. Weekly capabilities, goal gaps, direction, patterns, up to four weeks and one current validation action are rendered from typed semantic snapshots. Prior active actions require explicit continue/narrow/abandon; missing runs never automatically fail them. Raw historical snapshots remain immutable while current views discard withdrawn evidence and queue semantic recomputation.

Factories: `createAnalyticsConsumer(store, config)` in `src/consumers/analytics/index.ts` exposes `consume()` and validated `review(input)`; `prepareWeeklyAnalysis(store, config, Sunday)` builds typed materials. Pure projection/coverage/validation rules live under `src/analytics` and do not depend on Store or consumers. Consumer code obtains a restricted Store persistence port, never a DB handle. SQLite schema, fact folding, semantic acceptance and Analytics history are separate Store modules.

`WeeklyAnalysisInput.analysis_ref` is application assigned (`weekly:<Sunday>`). Changed content consumes the exact prepared next revision. Identical immutable snapshot content reuses `previous_snapshot.analysis_ref` and appends freshness. Only ready artifacts activate snapshots; semantic reservations prevent competing accepted results from assigning different content to one revision. Major-decision notices are durable local records and a cockpit display; no message is sent to another person or service.

`createAnalyticsHistoryPort(store, config)` (`src/store/history.ts`) preserves explicit professional legacy payloads. Reliable legacy confirmation requires both actual target and weekly content hashes plus exact current target revision. History retention and review activation are one transaction; unresolved records remain queryable and require review. Migration raw originals remain in the migration owner’s sealed records, outside Analytics input.

`validateStore(store, 'changed'|'all')` (`src/store/health.ts`) reads a consistent SQLite snapshot. It reports database/accepted-transaction corruption as errors, and ordinary missing exports, file conflicts or consumer work as pending items.

Reviewer daily `page_paths` accepts at most sixteen explicit safe Wiki paths. It hashes the entire page but bounds supplied UTF-8 text, setting `context_excerpt`/`excerpt_reason`. An excerpt permits append or a local exact replacement present in the supplied text. Page-only maintenance does not certify an empty day. No namespace scan is performed. Metadata omission always leaves a compact unfinished notice, even when coverage/fact context fills the bundle budget. Monthly prepared work IDs are bounded, and an accepted monthly result can complete only IDs present in that prepared input; publication/ack belong to the monthly owner.

Collection identity rows now store a versioned digest, IDs and fragment hashes; original raw bytes are held once by immutable fragments rather than duplicated in every collection. Existing new-format full collection rows remain replay-compatible. No historical raw deletion or automatic database rewrite is performed.

Verification uses Node 25.8, synthetic messages and temporary Wiki roots. Live private projections, weekly Codex semantics, production locks/scheduling and production migrations are not exercised by these module tests.
# 原文材料续读

## 职业分析审阅

`analytics_catalog` 保留配置中的正式能力/方向定义和明确项目映射；`repo_hint` 只是提示。新能力通过 `capability_candidate` 注册候选 exact revision，再用同 revision 的用户确认晋升。已配置正式定义不伪造 review 事件。

普通 observation 确认只确认活动。归因审阅必须提供 `selected_pairs`，每对绑定 observation revision 与 capability definition revision。确认只作用于选中对；纠正确认选中对、争议其余对。`retracts_review_id` 撤回一条确切、同 target 的已应用效果，审计事件保留并重建 fold；撤回撤回可以恢复前效。新 observation/definition revision 不继承旧确认。

周材料包含目录、仅当前有效的精确已确认目标契约、以及明确 `goal_whitelist` Wiki 路径的有界页上下文。目标页面不会自动生成契约。专业消费者通过传入 clock 计算重大决策契约当前有效期；过期通知不再显示，历史记录仍保留。没有新批次时也能刷新已有 cockpit 的期限状态。

`consume analytics` 返回四个已结束 Amsterdam 周的 `analytics_pilot`：实际覆盖、精确 pair 审计、历史/当前通知与动作继续/收窄/放弃/完成/当前状态。未测量的回顾耗时为 null 加原因。事实、语义快照和消费者输出仍各自独立；输出失败不会回滚事实。

月准备支持明确 `page_paths` 与 `archive_context_offset`。归档仅读取已入队、精确路径的 immutable v2 JSON；原文 bytes/digest/date/locator 必须相符。首次事实快照同时冻结归档 work 列表（含已完成项），之后完成任务与后到任务不会移动偏移。上下文不分配新事实。

截断项保留 pending，并说明原文 bytes 和重读同偏移所需 `limits.bundle_bytes`；提高预算可以读到尾部。`completed_archive_context_ids` 仅接受本页完整显示项，月发布成功后由月 consumer 精确完成。材料页身份包含事实偏移、明确源页及归档原文身份；零事实多页也累积已接受摘要，重读同页不会重复累加。旧 `semantic_pages` 接受记录仍参与汇总。
