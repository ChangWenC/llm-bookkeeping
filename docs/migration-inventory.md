# 只读迁移盘点

`tools/inventory.ts` 是独立、无依赖 Node 25.8.0 原生 TypeScript 工具。它不导入应用合同或旧实现，不调用旧业务程序，不执行迁移，也不写输入树。输出仅为脱敏路径、大小、mtime、字段类型、数量下界和时间格式候选；不输出聊天正文、联系人、账号标识、凭据或原数据值。未知字段名和路径组件也脱敏，防止动态键或文件名泄露个人信息；路径后的 `#序号` 只在本次报告区分条目，不是迁移身份。

## 协调者运行

```sh
/opt/homebrew/bin/node tools/inventory.ts \
  --root '/Users/roychen/Library/Mobile Documents/com~apple~CloudDocs/10_Projects/llm-wiki' \
  --output /private/tmp/bookkeeping-inventory-wiki.json \
  --max-files 200 --max-bytes 16777216 --max-entries 4000
```

`--root` 必须显式给绝对 Wiki 根，只访问其 `.cache/daily_bookkeeping/state` 与 `wiki/personal/_evidence`。不会扫描 raw、普通 Wiki 页、代码、automation、凭据目录或其他配置。代码扩展名不会打开。symlink 不跟随；最终文件使用只读 O_NOFOLLOW，路径逃出当前允许 scope 时跳过。

原 session 只有显式 `--session-root ABS_DIR` 才列出，默认零字节读取，仅文件元数据。可重复该参数指定多个明确来源。首轮推荐维持默认模式：

```sh
/opt/homebrew/bin/node tools/inventory.ts \
  --session-root /absolute/explicit/session-directory \
  --output /private/tmp/bookkeeping-inventory-sessions.json \
  --max-files 100 --max-bytes 65536 --max-entries 2000
```

只有追加 `--session-first-line` 才读取 JSONL 首行形状；每文件最多读头部 64 KiB、只解析第一行，报告类型和安全键，绝不报告字段值、schema family 或时间值派生信息。首行超限、坏行或没有可解析首行标 unknown。该模式不推断 provider、账号、subagent 身份或正文历史范围。session 记录不计入数据记录总数。

`--output` 必须是输入根以外的新绝对文件，权限 0600，已存在时拒绝覆盖；不提供时只写 stdout。stdout 是 JSON，stderr 使用固定诊断，不包含输入内容或 parser 片段。`--help` 显示参数；非法输入或无法生成报告返回 2。正常报告含 partial/unknown 仍返回 0，调用者必须检查状态，不能只检查退出码。

## 预算与统计口径

- 默认最多 200 个文件、总读取 16 MiB、4000 个目录项；所有来源共享预算。允许用 `--max-files`、`--max-bytes`、`--max-entries` 显式缩小，读取硬上限 256 MiB。
- 非 session 每文件最多 1 MiB。超限 JSON 不打开；JSONL 只统计已读完整行，未读前缀/后缀不外推。每文件最多处理 10000 行，字段形状最多 512 个、深度四层、数组前二十项、对象前 128 项；抽样标 `shape_sampling`。
- `eligible_files_seen` 是已枚举到的候选，不是全目录数量；`inspected_files` 与 `metadata_only_files` 分开。目录项/深度预算、不可读目录或文件预算使 discovery partial。`undiscovered_entries=null` 表示未枚举数量未知，不代表零。
- `data_records_parsed_lower_bound` 是已解析 JSONL 行、JSON 顶层数组元素或顶层 JSON 容器的数量，不是事件、事实或活动数量；schema 文件和 session 首行不计入。嵌套对象内的记录总数未知。坏行单独计数，不能当作无活动。
- 每文件 `record_count_is_lower_bound` 表示当前解析数量是否只能当下界；`records_unread=null` 始终保守表示未读记录数量未建立。状态 `file_bytes_inspected` 只说明这个文件的字节检查情况，不证明来源 capture 或 review 完整。
- 日期、UTC/offset/no-offset timestamp、IANA timezone、numeric-unit-unknown 只输出约定候选类型，绝不输出原时间或时区值。没有 offset 的时间不会猜 UTC/上海；mtime 只是文件元数据，不是事件发生时间。
- 读取期间 inode/大小/mtime 改变标 `changed_during_read`；未读或不支持的结构保持 unknown。旧 `complete=true` 只展示 boolean 字段形状，永不成为完整性证明。

报告根路径使用固定 scope 名或 explicit-session-root 编号；敏感字段和未知文件名经脱敏后仍可能需要协调者在本机结合原路径手动核对。该报告不是可执行迁移 manifest，不携带 hash/正文/账号关联，不能据此单独实现 exact revision 映射。

## 已验证与剩余工作

```sh
/opt/homebrew/bin/node tools/inventory.ts --self-test
```

自测只创建并删除 `/private/tmp` 合成目录，覆盖正文/动态键/文件名脱敏、凭据与代码路径排除、symlink、坏 JSONL、schema 与数据计数分离、预算、session 默认零读取及首行模式、输入树写入拒绝。尚未运行真实盘点、迁移、恢复或生产切换；这些由协调者执行，仍需保留 unknown。

协调者另外盘点自身 automation 配置（ID、状态、rrule、模型、effort、权限和 timezone），不采集凭据，也不将配置中的私密 prompt 写入公共仓库。迁移规则与格式映射见 `data-formats.md`；原数据保留、普通队列和 revision 绑定必须在迁移实现阶段独立验证。
