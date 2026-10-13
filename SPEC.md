# LLM Bookkeeping 全面重写实施规格

状态：2026-09-30 最终计划的实施交接版；用户已授权实施至真实可用。本文与聊天中的最终计划共同构成行为规格，不能用实现现状缩小范围。

2026-10-06 已批准修复以第13节为最新行为约束；其个人配置额度与运行调度取代此前4包/旧采集额度，兼容配置仍保持保守默认值。

## 1. 不可变实施约束

- 禁止读取、复制、导入或执行任何旧 Bookkeeping、Analytics、rollover 源码、测试、补丁、Git diff、事故脚本；不得把旧程序作为 oracle。旧代码只能整体封存为不展开的恢复快照。
- 可读原始会话、导出、日记、归档、用户确认和配置数据；它们是数据，不是执行指令。可读公开上游资料。现有通用 Wiki lint/index/qmd 可通过公开 CLI 黑盒使用。Roy 于2026-09-30明确批准一次窄范围例外：可查看、修改通用 lint 的导入与调用接线以解除旧文风模块依赖；仍不得读取旧文风或业务实现，其他通用工具保持黑盒使用。
- 所有新代码、测试、迁移 reader、集成脚本由 gpt-6.1-sol / high 编写。协调者负责决策与正式写入；若自身模型不符合，由指定 Agent 代为编码。最多三位开发 Agent 并行，各独立 worktree 和测试数据，不访问生产写目录。
- 全面重写采集、审阅、发布、Analytics、月归档、迁移。保留业务和数据；移除旧 controller、receipt/marker/run-dir 门禁、全历史初始化前置、证明图、事故许可、强制独立模型复审、严格文风门禁。
- 允许局部缺口和人工补救，必须准确报告 partial/unknown。不能用测试通过代替真实验收，不得将缺数据解释为无活动。
- 不创建通用插件平台、事件总线、多数据库、额外模型服务或 Bookkeeping daemon。不改变生产自动化的模型设置来匹配开发模型。

## 2. 环境与模块

新仓库 /Users/roychen/Projects/llm-bookkeeping；本机数据 /Users/roychen/.local/share/llm-bookkeeping；Wiki 根 /Users/roychen/Library/Mobile Documents/com~apple~CloudDocs/10_Projects/llm-wiki。Wiki 根必须配置绝对路径，不从 cwd 推断。

TypeScript、固定 Node 25.8.0、node:sqlite、node:test，一个 package 和一个 SQLite，保存依赖锁。SQLite/WAL/锁/草稿/备份不在 iCloud。代码仓库不含真实聊天、状态、凭据、私有运行日志；无需推远端。

模块：contracts 定义共享接口；adapters 发现/解析/分页/身份时间；store 统一数据库与事务；review 有界材料/结构化结果；publish 文件保护/备份/恢复；consumers Analytics/月回顾/归档/index；cli 仅编排；migration 离线一次性转换，不是正常运行依赖。

## 3. 公共合同与 CLI

所有对象带 schema_version；ID 字符串；UTC ISO 带 Z；IANA 时区；未知 null+reason。64 位 ID 在输入解析时即保真，不得先变 JS number。

SourceEvent：稳定 ID，provider/account/conversation/message/block，role/kind/channel，body 或本机片段引用，物理顺序，原始时间与精度，UTC 时间，日记时区与依据，主会话分类，上下文。
SourceCoverage：来源、查询范围、截止、已读范围与缺口，capture_status=complete|partial|unavailable|disabled|unknown，review_status=complete|partial|pending|not_applicable。采集、审阅、文件发布相互独立。
ReviewBundle：bundle/chunk ID，daily|weekly|monthly，截止，事件与明确标记的上下文，相关既有事实，目标页基线，coverage 与未完成范围。
ReviewResult：对应 bundle，每 chunk complete|partial|deferred，事实候选与保留/修订关系，页面建议；完整审阅零事实必须显式记录。
FactRevision：应用分配 fact_id+revision，event refs，内容，主体归属，时间，fact|inference|recommendation，assert|replace|retract，目标 refs。
JournalPatch：应用分配 operation_id，日期/路径/基线，append 或精确局部替换，事实 refs。
FactArtifact：batch_id，事实修订，采集/审阅 coverage，受影响日期/周；零事实也可提交 coverage。
PublishResult：独立事实提交/导出状态，逐文件 applied|noop|pending|conflict，消费者状态和待办；禁止一个 boolean 压缩整体状态。

固定 CLI（均支持 --config 绝对路径）：
collect --lane live|history
prepare --kind daily|weekly|monthly --lane live|history [--period 日期/周结束日/月份] --output 目录
publish --input ReviewResult.json
publish --resume
consume --target analytics|monthly|evidence|index|all
archive --month YYYY-MM --report|--apply
import --manifest 文件
migrate --manifest 文件
replay --source 来源 --from UTC --to UTC
facts --from UTC --to UTC
analytics-review --input 文件
status
backup --output 目录
restore --input 备份 --data-dir 新目录
validate --scope changed|all

stdout JSON，stderr 诊断；0=命令执行完成（可含普通 pending/partial），1=无法执行，2=非法参数/输入。prepare 输出材料与清单，Codex 写 ReviewResult，再 publish；CLI 不嵌套调用 LLM。consume monthly 只排队待准备工作。

默认 chunk 80 events 或32KiB正文，bundle128KiB，每轮四包；长消息切片，未读部分不算完成。应用分配 event/chunk/fact/operation 身份，模型仅提供包内候选编号。结果一旦接收持久化，重跑复用；replay 提供既有事实，显式 keep/add/replace/retract，不换标题制造重复。

## 4. 持久化与恢复

采集：同一 SQLite 事务保存一小批事件、必要原片段与检查点。检查点只说明材料落盘。
审阅：单事务保存 ReviewResult、事实修订、chunk完成、文件意图和事实 outbox。失败一起回滚；已提交不因日记/索引失败重做 LLM。未完成 chunk 不顺带完成。
事实导出：独立 immutable batch JSON/JSONL，临时写+rename；不追加年度大文件。先本机 export，消费者只见 ready batch；中断按 batch ID/内容补登记或重试。Wiki 证据镜像为独立消费者，不能让 Wiki 锁阻塞 Analytics。
每消费者以 batch/fact revision 幂等，输出成功才 ack，重启可恢复。coverage变化/修订投递相关日期周月重算。
SQLite 用一致性 backup API 或 VACUUM INTO，不仅复制活 db 漏 WAL；restore 到新目录，不覆盖生产。原来源消失时仍能读已保存事实。

同 Wiki root 一个 writer lock，日记/补记/rollover/月回顾/cockpit/相关meta 全部共用。锁只覆盖文件操作，不涵盖语义思考。不按 TTL 抢活进程锁，确认持有进程死亡才回收；未获锁仅推迟写阶段。
文件 intent 保存完整 desired bytes 或 delete、旧摘要、目标、operation、完整备份。锁内重读基线→备份和持久 intent→目标同目录临时文件原子替换→登记→index待办。
恢复：目标=new补登记，target=old重试，均不等则conflict保草稿；新建/删除有明确 absent sentinel；成功重跑noop，pending不得被去重吞掉。允许一次基于人工新内容的局部重生成，仍冲突挂起此文件。跨设备无事务承诺，保留备份。

## 5. 实时、历史与来源

切换记录 T0，S=切换日确认日记时区00:00转UTC固定。每轮冻结 cutoff，live范围[max(S,cutoff-48h),cutoff)，其余历史/漏跑/迟到/未扫前缀独立排队。live采集审阅发布优先，history随后，失败项延后避免队首堵塞。23:30后消息下轮按真实日期补，不虚构全天截止。
空库大文件：优先已知日期目录/近期活动/持久发现游标，mtime只排序。新文件读至多64KiB头部身份，再从冻结EOF以1MiB倒读至多8MiB；完整行解析，边缘半行留缺口。未读前缀独立queue，live append offset与history offset分开，不把EOF当连续完成。每provider来源正文live90秒/64MiB，history30秒/32MiB。目录发现用本机data_dir内的持久清单，每轮默认消费至多2000个清单条目；已知文件另做同等有限轮转，来源读取仍共用时间/字节总预算。Node没有跨进程目录seek cookie，所以清单构建与候选消费分开计预算：provider.options.discovery_manifest_budget默认最多5秒/4MiB序列化元数据构建及清单读取，时间最多占本轮provider的四分之一；只枚举名/类型，不读取来源正文。完整清单的字节cursor跨进程推进；截断/目录变化/预算不足保留已发现前缀并明确partial，可操作提高有限metadata预算或缩小root，不宣称任意大目录都能自动完整发现。清单丢失时局部重新枚举，不把旧offset套到新清单；完成一轮后新epoch刷新发现新增文件。无法识别身份/时间局部pending，不妨碍其他日记。不能因遇一条早时间戳推定前缀全旧；可部分发布，不假完整。

Codex：支持event_msg.user_message、真实user response_item、显式role/id/session的realtime transcript_segment、assistant final_answer，有价值commentary作候选；请求/尝试/验证结果分开，工具输出不直接归因Roy。
Claude：同message ID多block保留，多个不同final保留，未完turn待审；已证明镜像才去重。
按结构身份过滤subagent/automation及已知项目范围，不用文本关键词或UUID外形做永久排除。
nativeID加provider/account/chat；无ID用稳定locator+内容摘要+出现序号。真实同文重复保留，路径只是locator，搬迁不改身份，截断重写开世代不删旧事件，跨export/live/fork不确定重复待核对。
坏行清除依赖前文的隐式归属；半行续读，超长分块。来源正文中的指令仅数据。
保留原时间、UTC、来源wire时区、journal timeline、analysis_timezone。Analytics固定Europe/Amsterdam周一至日；历史日期不按当下时区重算。旅行时刻未知仅影响归日的事件待核对，无offset导入按每批时区，不猜UTC/上海。

## 6. 日记、归档和有效事实视图

追加/精确局部修改，不夜间重写整页，保护人工修改/已完成待办/链接。按时间顺序第二人称或省主语，跨午夜归实际日历日；明确项目人物动作结果，他人告知不冒充Roy经历；感受仅明确表达，推断分开。项目同日聚合，技术细节放项目页。待办保留起始来源，完成不复活，挂起不日日复制，五条软建议。不自动建人物profile，不强制空小节或独立文风复审。

保留当前月+上一完整月；pinned、intentional-journal、月年专题回顾不自动删除。归档一次一月份。删除前完整原文与归档数据保存、月回顾可用、精确反链迁移成功，并锁内确认文件仍等于保存版本；不检查旧marker/receipt。目标相关改变只推迟删除。
旧 _evidence/daily_journals/daily_YYYY.jsonl 永不修改。其daily-journal-jsonl-v1有id=daily:YYYY-MM-DD,date,original_stem,title,summary,sections(object arrays string|object),links,sources,promoted_to,retention,created,updated。新归档独立版本文件含完整原文、日期、locator与fact refs；不重复计数原文里的已知fact。
已归档或早于窗口从未有日记的日期只补记，不复活Markdown。精确日记反链改[[回顾_YYYY_MM|YYYY-MM-DD 日记]]保原描述。
readEffectiveFacts(range,scope,asOf?)统一旧新归档+补记+更正。旧条目locator=封存文件身份+dailyID+section/item+内容摘要+重复序号；不确定叙述为legacy_record不是verified事实。assert新增，replace完整替代明确refs（局部更正保其他有效内容），retract撤回。找不到target/冲突仅相关pending。保留历史，默认有效版本；旧未结构化人工内容作为待提取上下文。月回顾补记区派生且保护人工正文，展示失败不回滚事实。

## 7. Analytics（全部重新实现）

独立读取导出facts和coverage，无旧run-dir/marker/活日记依赖。先投影职业学习再生成observation，混合生活剔除私人子句，不导出聊天原文。cwd不证明项目，助手产出不自动证明Roy能力，设计/纠错/验证/责任证据决定归因。
保留fact/inference/recommendation、能力趋势、目标差距、方向一致、模式、最近四周和证据、最多3确认+1 active validation action。上周动作每周重选continue/narrow/abandon，不自动失败。
confirm/reject/correct/retract事件append-only；绑定target稳定ID+revision，旧revision操作只局部stale。保留evidence attribution overlay（observation×capability pairs与责任依据）、candidate/formal晋升、撤回fold重建，新revision不继承旧确认。长期profile/synthesis/plan晋升仍需明确用户确认。
major-decision由用户确认有效contract（subject,目标版本,期限,trigger），只显式验证且匹配有效期与subject等规则事实触发，普通活动/inference/cwd不得触发；factrevision+decision只通知一次。
周覆盖partial不能quiet/decline/divergence；indexpending不降低事实coverage。周内容变化保存revision，不原位改已确认历史；完整无变化仍snapshot/freshness。保人工cockpit。有实质变化/需确认/coverage异常才报告。
旧observations/reviews/weekly保留ID与历史确认，可靠logicalID映射则修订避免双计数；无法映射历史可查，但不将疑似重复的新旧共同汇总，覆盖标partial。保留明确项目/goal whitelist，私密namespace不纳入docs扫描。四周pilot统计不扩大权限。

## 8. 微信与导入

wechat-use首选readonly PoC，候选v1.18.16，实际安装help/output/license固定记录；https://github.com/leeguooooo/wechat-use 。独立4.1.9副本不假设有主微信全部历史；登录/激活/系统授权由Roy处理，不自行发消息。
先实测主副本真实历史范围、新收发含本人、离线重登录补读、account/chat/self/member identity、同名联系人、超页/同秒多条/顺序/迟到/截断、上游cursor是否隐式推进、重复查询/导入与64bitIDs。doctor通过不等于覆盖通过。业务只history/sessions/contacts，另允许accounts只读核对副本与账号绑定；禁止发送/机器人/朋友圈。媒体转写默认off，留缺口。高密度窗无法枚举partial+import，不无限缩窗。
保私聊FileHelper及本人参与/被提及群聊±20分钟上下文；迁移ignored/pinned/self aliases；公众号systemholder默认排除，不自动建人物。CLI sender语义必须按会话类型实测。
importer支持旧导出+ChatLab0.0.2 JSON/JSONL(header/member/message)，规范https://github.com/ChatLab/ChatLab/blob/main/docs/cn/standard/chatlab-format.md 。manifest明确account/chat/owner/time来源/时区/已知范围。旧complete仅声明非完整证明，分页上限/重复页/截断/未知zone均缺口，raw保留。wechat未通过明确未完成，A日更继续。

## 9. 迁移切换与退役

迁移普通任务：待采/待审/草稿/consumer/index/outofscope/needsreview，稳定migration_key重跑幂等；未知旧graph不修。迁移provider范围与开关、roots、automation/subagent排除、微信账号filters、自身identity、旅行timeline、analysiszone、保留规则；未知不扩大范围。index欠账按当前文件合并。
现有Wiki dirty非常多，不覆盖/reset/stash，不以HEAD代表全部现场。相关未提交/未跟踪/ignored与唯一临时材料都保存。
严格顺序：隔离Wiki副本验收→暂停仍ACTIVE monthly rollover，其他旧任务保持暂停→确认在途writer退出→一致快照并抽样恢复→导入最小配置固定T0/S→真实手动日更→正式automation工具更新现有daily ID→替换活动prompt/memory/schema/template→新版rollover兼容共享锁恢复→观察2次真实scheduled daily→全部活跃业务入口脱离旧实现后按清单删旧专属代码。
生产daily保23:30原调度语义和原模型effort，明确新repo/CLI/wikiroot与权限，核实timezone。monthly保每月3日03:30，待新版安全才resume。补账heartbeat和Analytics weekly保持PAUSED。旧memory封存而非继续旧失败命令。不得重新开启旧controller处理新数据。
原始数据/归档/reviews/人工内容与完整恢复快照长期保留，清缓存不能删唯一副本。回退仅暂停对应新阶段/修复，文件撤回对照备份与当前内容，禁止整库回滚覆盖新人工修改。
新schema替换旧运行引用：core/workflows相关段、daily_bookkeeping两份、personal、self_analytics、rollover、模板/prompt；新业务验证独立，旧receipt/marker门禁不适用。通用lint黑盒兼容问题独立，不改旧代码适配。Wiki schema变更维护VERSION/log/index/qmd。

## 10. 多Agent与交接

M0集成Agent先独占contracts/CLI/config/dependencies/e2e skeleton，形成输入事件→review→事务→发布→consumer最小合成贯通；然后最多3agent并行：A adapters，B store+review+SQLite schema，C publish，测试跟owner。第二波wechat/import、Analytics、archive/index/migration分配独占路径。跨模块接口/依赖经协调者串行合并；禁止别人写SQLite schema。协调者唯一正式Wiki writer，不把raw私人材料传subagent。
M1当前日更、M2完整业务、M3切换观察、M4退役；当前日更可先上线但不宣称整体交付。
交接包：SPEC、contracts+JSON schema+零事实/partial/更正/conflict例、behavior-map、pitfalls+独立合成fixtures、data-formats、migration/runbook、upstream版本许可实测、agents目录owner/依赖/验收命令。报告分代码完成/合成通过/真实通过，保留实际剩余缺口。

## 11. 验收矩阵（全部必须有真实证据）

1. 空库+2GB旧session今天尾+坏文件：有界发布today，prefixunknown/history不挡；不伪完整。
2. Codex response_item/voice/mirror/multifinal、Claude多block、真同文重复、结构排除。
3. 半行/追加/搬迁/截断、23:30后、跨午夜/旅行/DST/no-offset，准确或局部pending。
4. capture complete+review半数仍partial，零事实complete不反复喂，不能声称全天quiet。
5. 语义事务各中断点不丢fact/chunk/outbox，恢复不重LLM。
6. journalconflict/lock/qmdfailure不阻事实导出和Analytics。
7. 文件写前/rename后/登记前、新建/删除、重跑no duplication、人工编辑保护、备份恢复。
8. 多writer协调，archive/body/links未完成不删，pinned不删。
9. 旧归档/无日记历史补记不复活，replace/retract统一查询/月/Analytics不双计数。
10. 无旧runtime/marker/activejournal仍Analytics，确认否认更正撤回/候选/唯一action可重建。
11. 迁移不信complete/不同zone，幂等，不移植未映射确认。
12. 微信真实PoC覆盖身份/历史/新收发/分页/cursor/relogin/IDs/import/media。
13. SQLite一致备份新目录恢复，源暂不可用仍读facts。
14. 新路径/权限/prompt/memory，一次真实manual+两次真实scheduled，四任务状态明确。

完成报告分A当前日更、B微信自动采集、C历史与消费者兼容、D旧实现退役；全部完成才标goal complete。历史不要求当天清空，来源缺口必须如实可操作。不能以更容易通过的子集替代本规格。


## 12. 2026-10-02 已批准的微信范围与独立运行修订

本节取代第8节中“本人参与/被提及群聊”的一般范围描述：正式配置只允许用户确认的7个群，使用完整稳定原生group ID精确allowlist，参与/提及与±20分钟上下文规则仍适用。正式私有配置保留13个已核验私聊人物映射，绑定对应账号、稳定原生联系人ID、显示名、既有人物页与关系说明；真实名字/ID不得写入仓库或合成fixture。私聊与FileHelper继续，ignored/service/公众号始终排除；显式allowlist下未知会话类型fail closed，可用按稳定ID记录的已核验chat_types作证据，不按显示名猜测。未提供allowlist只为既有配置兼容，不授权正式范围扩大；显式空数组排除全部群。

范围门禁必须在live/history与import的正文读取前生效，并用于已存事件的prepare、context、replay和尚未接受的commit。过期或混合provider材料需重新prepare，不能绕过当前范围。已接受ReviewResult、事实、原片段与导出保持不可变并可幂等重用。人物关联只对已证明的稳定私聊sender ID附加上下文，不能把群来源页或宠物页认作人物；数字型每群sender ID只在独立证据证明时用于补充，不能替代稳定wxid。无效mapping局部报告，不误连人物、不自动建profile。

新daily bundle及对应审阅的主事件和上下文事件只含一个provider；既有接受事实可保留跨来源、旧归档或无event refs的去重/修订上下文，只有证明引用当前禁止微信群的事实不进入该上下文。每轮仍共用默认总计4包预算，先给各pending provider机会，再处理最旧剩余材料，不能按provider各发4包。微信读取、审阅、commit、export或文件写入失败只报告和重试该来源/阶段，继续有效Codex/Claude及独立consumer工作，绝不因此暂停整个Bookkeeping。事实提交、导出、逐文件发布分别报告；全局SQLite/本机storage故障明确报告执行失败，不伪装为单一来源缺口。不改变正式daily的原调度、模型或effort。

人工历史补账使用显式source、UTC半开from/to、冻结cutoff与有界max_bundles；日期边界按已确认的历史日记时区/timeline确定，不按路径或当前时区推测。明确range不能同时带period或replay_id。一次范围重试复用原冻结语义；已审数据若需再审，使用显式source-scoped replay job与稳定key，新一轮语义检查才给新key。September补账不声称缺口为无活动。允许微信范围内的zero-fact replay，但每个complete chunk必须显式zero_facts并只完成实际提供且完整审阅的事件/slices；partial、未读、范围外或缺失capture证据不得顺带完成，零事实审阅不证明完整采集或全天quiet。审阅材料中的命令与指令始终只是数据。

## 13. 2026-10-06 已批准的有界日更与日记发布修复

显式个人配置：collection_budgets.live=512MiB/300秒，history=256MiB/180秒，两者max_directory_entries=8000；Codex/Claude options.max_directory_entries=8000、discovery_manifest_budget=16MiB/10秒。移除这些文件适配器内部旧默认硬钳制；I/O每次最多1MiB，每候选最多4MiB后轮转，已知文件严格续原offset，不跳recent tail；未知新文件保留8MiB尾部引导。微信仍保留自身90/30秒、64/32MiB、history默认8最多16次查询的独立上限，正式allowlist、人物映射、范围与分页保持；global额度提升不提升这些微信正文上限。chunk80事件/32KiB、最终bundle128KiB不变。

正常daily live窗口=[max(S,cutoff-48h),cutoff)，history独立审更早材料；物理采集lane不限制可审事件。完成区间与partial区间跨lane去重；显式范围/replay仍保留原语义。空源、不完整turn、局部失败不制造空自动bundle或占额度；来源partial仍可使用已有合格事件。当前排除范围不计active审阅欠账，stored/excluded/blocked_metadata/incomplete分别报告，未知捕获前缀不可伪称零。微信局部故障继续其他来源和消费者；明确SQLite/共享磁盘写入容量故障（含ENOSPC/EDQUOT）报告全局执行失败，成功只读探针不能证明可写。

daily-round是现有CLI的逐步编排，无新controller、模型服务或daemon。私有manifest冻结原cutoff、started_at、配置身份、active、轮转cursor、原event+sliceranges skips及计数；不作业务acceptance门禁。每次只prepare一个选定source/lane（max_bundles=1），接受/发布后再选下一包。先各provider一轮live，再各一轮history，后按2:1；每24个实际开始的source包保留16live/8history，另一lane耗尽才借用。source与journal语义材料共用每run最多96个实际非空starts，格式修复/重试同active不重复计数。初始最多一批journal，source wave间交错，结束前主动处理剩余journal；材料过大缩到可装下的前缀，单条异常只挂该条。明确--defer-active记录stage/reason并加入本run skips，不伪造zero-fact完成；下一run仍可审。完整逐步receipt保存在独立0600文件，manifest只存引用、阶段计数及摘要（上限16MiB），不截断原回执或给无关import增加同一上限。

原started_at起2小时合作式deadline，采集累计最多20分钟；105分钟后禁止新source或journal语义材料，余下15分钟只提交已开始结果、恢复export/文件及消费者。每子命令/文件/导出/consumer循环边界检查剩余时间；可完成已开始原子文件步骤，但不启动下一项，公共子进程timeout按剩余时间裁剪并等待退出，无后台writer或Promise.race脱离控制。

接受事实的每个精确fact revision×受影响date×canonical target独立journal_publication债务。ReviewResult可选journal_dispositions=patch/already_present/not_needed/defer，旧无字段结果照常接受并留债。already_present须给足够evidence_text并匹配冻结且仍当前的baseline，不自动重复既有人工正文；keep保留已有refs，更正/撤回覆盖old/new dates与历史目标，失效修订可有明确not_needed退休证明。journal-prepare与journal-resolve只处理已接受facts、current baseline与精确work；不创建第二ReviewResult、新facts、source marks或outbox。原操作最多一个自动replacement；supersession或explicit terminal使旧intent永不重放。

历史supplement排队返回pending+真实queued_work_ids。月输出只确认本次冻结、实际rendered的精确journal IDs，持同一Wiki lock调用completeJournalDisplay原子闭债并退休旧操作；derived intent refs含displayed、summary represented及correction的完整union，排序精确refs摘要进入稳定operation ID，兼容旧稀疏refs intent且不改旧记录。原归档context仅冻结且完整实际展示的IDs可关闭。

journal-inventory按Store测量的实际接受UTC半开窗口分页，模型created_at/业务日期/文件mtime不作接受时间证据；旧接受时间未知明确返回unknown并保留单独筛选。journal-recover可用协调者核验的显式result_ids（每批1–100）补债，包含业务日期早于窗口的历史手工补账。状态分execution/capture/review/facts/export/files/consumers/journal债，不用一个success代替完整发布。运行时now传Store、Publisher、archive与全部consumer/writer，语义cutoff保持冻结；合成测试固定有效asOf。部署、真实验收、Wiki规则和保持原23:30/model/effort的正式自动化更新只由协调者进行。

## 14. 2026-10-07 已批准的跨阶段修复合同

本节优先于第13节的旧调度细节。日更默认按事件时间选择，物理采集lane只决定live/history范围；显式旧range/period调用不指定selection_basis时保持capture_lane兼容，replay不变。CLI `--selection-basis event_time|capture_lane`使选择明确。准备返回ready/more/exhausted/unavailable、冻结scope的opaque continuation、扫描统计和精确延期单位；只有exhausted允许日轮耗尽来源。每调用最多5页×320候选或5秒，超大单位局部延期，空扫描页不消耗语义starts。已给出的未接受材料及其未读切片不得推进游标。当前精确禁读IDs在所有续页/context/replay/saved/active路径的正文访问前生效。

共享存储错误统一分类：ENOSPC/EDQUOT/SQLite为全局；EIO/EROFS只有本机data_dir/Wiki写入操作才全局，来源读取失败保持局部。非法输入、未提交执行失败和已提交恢复失败分开，后者保留完整error.receipt及原accepted身份，不能要求改写已接受语义。

`daily-round --finish --reason REASON`不准备新材料，保留原started_at/cutoff/counts/active身份；未审单位精确延期，已接受输入幂等恢复，剩余时间内恢复发布和独立消费者。响应明确terminal、semantic_deadline、task_deadline及next_action。先做不读正文的到期/finish元数据分支，再检查active禁读。初始最多1批journal，每完成4个source包检查journal一次且最多安排1批；90分钟后优先journal。source+journal共96starts，105分钟不新开语义，120分钟收尾；旧manifest增量兼容，不能重置时钟。终态partial不等于完整覆盖。

现有每月3日任务增加monthly-round有界语义阶段：先上一完整月，后最老pending旧月，每月1包轮转，冻结原cutoff/snapshot/offset；共2小时/105分钟/96starts。状态显式月语义欠账、月份、最老、原因和续页。没有daily月摘要新阶段。archive仍独立且最多1个eligible月，保当前月和上月。恢复优先currentbatch及pending工作，历史核对每次至多64readyexport和64appliedintent并持久轮转；已applied项到期不改称pending。仅协调者安装prompt和正式文件，模型/effort/schedule不变，检测heartbeat保持PAUSED。

冻结月事实已读完仍不等于冻结工作全部闭合。精确snapshot进度同时返回未完成的原work/archive-context计数，缺失ID保留欠账；不得把后到工作加入旧snapshot。原工作超出单包32项时，用显式work_only包继续同snapshot/cutoff，fact_offset=total，保原任务时钟与starts。该包只含实际返回的未完成原工作ID元数据，不重新读取facts、人工页或来源正文；已有完整月结论与精确版本refs/readmarks保持，只闭合本包明确完成的ID，不累加重复摘要。第一次无facts但无既有完整月结论仍是普通语义准备。旧已收尾run不能重开时钟，未闭合冻结债务留下一独立run恢复。


## 15. October 11 approved missed-review and journal repair

The October11 contract in docs/interfaces.md adds actual-byte bounded inspection, staged finite preparation, real frontier fairness, exact primary-user-unit dispositions and explicit user-confirmed journal changes. Existing accepted records and their retries remain immutable. Old unaccepted daily material is re-prepared with the new capability. Summary reading and random continuation IDs never prove full reading or progress. Semantic existing-body/summary replacement and known conflicting append remain awaiting user confirmation; facts/export continue independently. Exact stored replay never recaptures adapters. Original daily quotas and clock deadlines remain authoritative. Unknown source/startup/WeChat coverage stays partial; implementation/synthetic evidence does not certify a scheduled run.


## 2026-10-11 通用 E197 规则同步授权

用户已明确授权窄范围查看及同步通用 Wiki lint 的 E197 `archive_target` 规则、独立机械验证模块、必要导入/调用接线及合成测试，使普通日记可采用 `none` 或经完整身份/日期/分类校验的有效 v2 归档目标。允许协调者执行精确旧年度归档目标到 `none` 的单字段元数据迁移，保持正文、摘要、`updated` 及其他字节不变。该授权不开放旧文风模块或旧 Bookkeeping、Analytics、rollover 业务代码、测试、diff、patch、事故或恢复实现。生产操作、正式 Git 暂存和提交仍由协调者独占。


## 16. October 13 approved span, assessment and compatibility repair

This section is the current contract for new preparation; October11 accepted records retain immutable retries. New daily material has completion_policy:primary_spans_v1. Every admitted primary text role uses original-source UTF8 EventRef spans; ChunkReview retains supplied transient IDs. Candidates consume only referenced bytes and exact residual subspans use explicit dispositions without overlap. Independent facts may commit while clarification/journal evidence remains partial. Existing reviewed_spans are reused, with no new permanent proof graph.

Journal assessment uses exact complete Markdown paragraphs/list items and full summary/body separately, comparing subject/action/time/result/negation with consistent/conflicting/unknown/not_applicable and relation new/clarification/correction/unknown. Insufficient/unknown/correction evidence retains debt without revoking valid facts. Cooperative chat confirmation stores minimal response source/content and does not authenticate a human. Automated tasks/source records cannot self-authorize journal-decide; privacy add/remove/value changes require confirmation and status remains mechanical. Final complete reread follows awaited guards; no CAS promise.

W public lint is sole full v2 authority, with report_contract_version1/capability and strict complete diagnostics/counts bounded8MiB. Harmless top-level extensions allowed; old weak B validator/E197 bypass retired. Pending lint always reruns and downstream cache binds contract, commands and input. Timing reader derives its own import.meta implementation root, preserves canonical OS temporary clone restrictions and works from relocated paths/different cwd. Existing128KiB/16KiB/96starts/105/120minute budgets and original automation model/effort remain unchanged.

Current conservative add/correction boundary: when bundle.existing_facts is empty, target_refs is empty and every correction journal decision explicitly says defer, an add may retain the newly evidenced assertion while its journal debt remains deferred. If any existing FactRef is supplied, add with a correction declaration stays pending until exact replace/retract or explicit source/candidate deferral; no same-topic equality is guessed from content. fact_commit:committed only reports transaction acceptance: inspect actual committed_fact_count, candidate debt and exact source/journal states separately.
