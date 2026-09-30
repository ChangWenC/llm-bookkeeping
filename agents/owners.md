# 模块归属与接手

先读 [架构与接手顺序](../docs/architecture.md)、[公共接口](../docs/interfaces.md) 和 [runbook](../docs/runbook.md)。以当前主线合同为准，不再依赖初期固定 commit。

| Owner | 负责范围 |
| --- | --- |
| Integration | contracts/config/CLI/runtime、consumer聚合、package/lock、文档与integration tests |
| A | adapters、来源解析及对应测试 |
| B | store/SQLite schema、review、Analytics领域/消费者/history/health及对应测试 |
| C | publish、archive/monthly/evidence/index及对应测试 |
| M | migration、旧数据读取转换及对应测试；只使用Store写入端口 |
| Coordinator | 串行接口合并、生产Wiki/config/automation、切换与真实验收 |

先固定合同与最小合成贯通，再按独占路径并行；跨模块接口和依赖串行合入后接线。发布/消费者复用 [共享Writer](../docs/publisher-interface.md)，归档恢复见 [消费者接口](../docs/archive-monthly-index-interface.md)，镜像见 [evidence](../docs/evidence-interface.md)，迁移见 [migration](../docs/migration-api.md)。

`npm run check` 是严格类型检查与全量合成测试入口。代码完成、合成通过、真实通过分别记录；开发agent不操作生产，也不把旧实现/测试当行为依据。
