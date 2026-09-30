# wechat-use v1.18.16 只读 PoC 上游核实

记录日期：2026-09-30。任务依据：新 Bookkeeping SPEC §1、§8、§10；只使用公开上游和本机无私人数据的 help/signature 输出。没有读取旧 Bookkeeping 代码、聊天、联系人、账号配置、凭据或生产数据库；没有安装到用户目录、启动微信/daemon、发送、登录、激活、修改主微信、重签或关闭保护。当前微信采集验收状态：**unavailable，未实测真实覆盖**。

## 已实测

- GitHub release API：latest 为 `v1.18.16`，发布于 `2026-09-29T13:29:23Z`，target commit `4f01035e9323096e35b84e2b9b03bcf6a477f4b8`。公开 release 可下载，不需激活。
- 下载并解包 `wechat-v1.18.16-darwin-arm64.tar.gz`；SHA-256 `dfddaa84c390a1817db75ffb6233994f4bdca62699d0c730fac90a26277b370a` 与 GitHub资产digest和发行SHA256SUMS一致。包内全部列出的14项文件散列通过。
- 二进制是 Mach-O arm64；本机 macOS `26.5.2 (25F84)`。包内 `wechat --version` 返回 `wechat-use 1.18.16`，exit 0。
- `--help`，`history/sessions/contacts/doctor/setup/auth/new-messages/accounts/accounts list/members/init/clone --help` 均 exit 0。执行时设 `WECHAT_USE_NO_UPDATE_CHECK=1`，只运行 help/version。
- history help：`--since` 包含起点、`--until` 排除终点；支持epoch秒；默认limit100、order desc、JSON输出可用。**没有 offset/page/cursor/after-ID 参数**。sessions默认20、contacts默认50，同样没有分页参数。提高limit能否无上限、超页行为和同秒排序都未实测。
- **必须传 `--no-transcribe`**：history默认尝试语音转写；不传 `--auto-fetch-images`。brief默认100字符截断，不能作采集输入；使用JSON，不设置会丢ID/原始字段的 `--fields`。
- setup help实际支持 `--skip-verify`（准备读取/权限、跳过测试消息）；`setup --json`声明只检查，不请求权限。均只核验help，没有执行。

## 签名：初次失败已定位到受限执行环境

同一份未修改的CLI在沙箱内 `codesign --verify --strict --verbose=2` exit 1，报invalid signature，`codesign -dv` Authority unavailable。通过正规只读沙箱外审批重做 `codesign --verify --strict --verbose=4` **exit 0**：valid on disk / satisfies its Designated Requirement。沙箱外display显示 `Developer ID Application: LI GUO (6ZPXG4KVVS)`、Apple证书链、签名时间2026-09-29、Identifier `ai.wechatskill.wechat`。

因此不能把沙箱内错误解释成上游包损坏或当前平台不兼容；签名有效性已经确认。`spctl --assess --type execute` 对裸CLI exit 3，原文为code valid but does not seem to be an app；这不是签名损坏结论，也没有据此关闭保护。设置app Gatekeeper/公证和完整安装未测试。官方安装器检测Developer ID后保留签名，不需要手工重签CLI。

## 公开文档说明／推断（尚非真实微信实测）

固定资料来自上述commit的README、LICENSE、docs/install.md、docs/CHANGELOG.md、SKILL.md；runtime版本与SKILL元数据不一致，以实际binary为准。

- 许可是 Non-Commercial Learning License v1.0：限本人账号个人学习研究及非商业自动化，第三方分发需作者书面许可。现行许可明确不提供收费tier或商业授权，README称永久免费。auth help仍含tier/剩余天数等历史字段，不能据此推断收费。没有购买行为。
- 激活申请：Roy本人先关注 https://t.me/wechatuse，再私聊 https://t.me/WechatCliBot `/start` →「申请激活码」→个人用途说明，文档称审核1–24小时。Agent不能代发。
- 官方安装器绑定独立 `~/Applications/WeChat-4.1.9-wechat-use.app`，bundle ID `com.tencent.xinWeChat419WechatUse`；已有支持的4.1.9可复制，否则从腾讯固定DMG下载并验证。副本独立登录和数据库，**不能假设它含主微信历史**。公开推荐build为268596/268602。
- `history --json` 文档形状为 `{meta, rows}`；meta有order、窗口解析epoch、stale/shard状态。`meta.status=ok/windowed`不是完整范围证明。来源time应取create_time epoch；created_at是当前本机offset的展示字段，不能代替历史journal时区。
- 消息字段包括local_id/server_id（文档int）、chat_id/username、real_sender_id string、sender_wxid、create_time、message_content/display_text、message_kind、is_mentioned。必须在JSON输入首次解析时保留64位数字，禁止先经过JS JSON.parse number。实际ID输出格式待测试。
- 文档称群sender_wxid为发送者；私聊双方sender_wxid都可能null。real_sender_id被描述为per-chat编号，又称通过FileHelper校准可跨chat识别本人，存在待验证的范围假设；不能硬编码2、不能将null当本人。
- SSE的fromSelf文档只代表通过工具POST/send产生的消息，不能当全部本人历史消息标志；本项目仅使用history/sessions/contacts，成员身份另列人工验收项。
- `new-messages` help只有limit/reset，公开文档明确调用推进 `~/.wx-rs/cursor.json`，reset回到now。clone有独立状态目录。**禁止把new-messages纳入Bookkeeping采集**，避免隐式游标先于本机事务推进。history是否完全不改cursor仍需未来本机受控对比。
- 官方当前install脚本支持 `WECHAT_USE_VERSION=v1.18.16`、`WECHAT_USE_NO_TEST_MESSAGE=1`、`WECHAT_SETUP_DEFER=1`、`WECHAT_USE_INSTALL_SKILL=no`。前两项关闭安装自测，第三项延后setup；安装仍会建立副本/用户工具文件，不是本轮已完成的动作。官方setup应通过 `wechat-use setup --skip-verify` 进入，不能直接使用默认发送验证流程。

## 给协调者／Roy的具体下一步

1. Roy本人按上面Telegram流程申请免费激活码；不把code写入repo或聊天证据。
2. 协调者接手官方固定版本安装：现已保存固定commit的安装器 `public-source/leeguooooo-wechat-use-4f01035/install.sh`，应显式设置上述四个安装选项；本轮没有执行，也没有复制或重签主微信。官方脚本会改用户工具目录/独立副本并含自身quarantine处理，不以本报告作为绕过macOS保护的授权。
3. 安装后由Roy执行 `wechat-use setup --skip-verify`，粘贴激活码、仅登录工具专用4.1.9、按macOS实际提示完成系统身份确认和工具授权；不要点发送验证。设置GUI独立打开时是否保留skip配置尚未证明，保持CLI带flag路径。
4. 只读执行固定account/bundle的history/sessions/contacts；由主Agent本机保管raw证据，不向subagent发送私人正文。根据 test-plan.md 对照主微信人工检查范围和方向。doctor通过仍不算真实覆盖通过。
5. 副本历史不足时，以显式manifest导入补齐；无法枚举的高密度窗口、未知self、迟到/截断应标partial/unknown，不无限缩窗或宣称零活动。

## 证据与公开URL

本机证据：`evidence/release-v1.18.16.json`、`release-latest.json`、`SHA256SUMS`、`help-command-results.json`及对应stdout/stderr、`signature-results.json`、`artifact-sha256.json`。下载包仅在probe目录，尚未正式安装。

- https://github.com/leeguooooo/wechat-use/releases/tag/v1.18.16
- https://api.github.com/repos/leeguooooo/wechat-use/releases/tags/v1.18.16
- https://github.com/leeguooooo/wechat-use/blob/4f01035e9323096e35b84e2b9b03bcf6a477f4b8/LICENSE
- https://github.com/leeguooooo/wechat-use/blob/4f01035e9323096e35b84e2b9b03bcf6a477f4b8/install.sh
- https://github.com/leeguooooo/wechat-use/blob/4f01035e9323096e35b84e2b9b03bcf6a477f4b8/docs/install.md
- https://github.com/leeguooooo/wechat-use/blob/4f01035e9323096e35b84e2b9b03bcf6a477f4b8/SKILL.md

Compatibility scope: `pinned_chats` is merged even when `discover_sessions:false`; `ignored_chats` and service holders (including OpenIM) still filter it. No implicit ignored list is guessed. Optional `self_aliases` / `mention_aliases` require both `identity_verified:true` and `aliases_verified:true`; NFKC/trim/case normalization applies. Self display aliases only establish self when no native sender ID exists. Native wxid/per-chat numeric mappings remain authoritative even when a display name matches an alias. Explicit native `is_mentioned:false` is authoritative. Alias mentions require a bounded `@alias` token, avoiding substring matches. Import manifests support the same explicit verified fields.
