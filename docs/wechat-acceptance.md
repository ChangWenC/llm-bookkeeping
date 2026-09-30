# 微信只读验收计划（无私人数据准备阶段）

本轮仅准备计划，没有执行私人查询或发送。业务adapter待M0合同后由owner实现。仅真实来源通过才能声明微信完成；合成fixture通过只证明解析和coverage行为。

## 无私人数据的合成准备

构造JSON字节fixture：`server_id=9223372036854775807`和9007199254740993不得舍入；null/缺失ID待核对；同account/chat重复local_id只计一次，不同chat相同local_id保留；相同正文不同ID保留；同秒多条顺序用稳定物理位置；不猜时区。覆盖 `{meta,rows}`、裸数组误输入、重复页、错误JSON、被截断JSON、stale/shard状态、未知sender、同名联系人、超limit、空但不完整范围。

adapter候选调用只能history/sessions/contacts；history参数固定epoch since/until、JSON、no-transcribe，显式account/bundle；禁new-messages/reset/listen/export/send/audio setup/image抓取，禁自动扩大来源scope。fixture确保媒体未读取留下gap、公众号systemholder默认排除、群只本人参与/被提及及±20分钟上下文。覆盖不足允许partial+import，A日更继续。

## Roy登录后的真实检查（主Agent本机执行，raw不交给subagent）

| 项目 | 操作与判定 | 未通过处理 |
|---|---|---|
| 主副本范围 | Roy在主微信人工定位最早/中间/最近记录，与独立副本固定epoch窗口对照；逐chat登记可证明范围 | 不假设主历史已同步，missing范围转import |
| 身份 | 固定account wxid与bundle；在FileHelper、至少一个私聊及一个群，各选已知本人/对方文本；核对real_sender_id及sender_wxid，同名联系人按稳定chat ID区分 | self unknown，相关归属pending，不硬编码2 |
| 新收发 | Roy使用正常微信自行提供受控消息或利用已自然发生的明确双方记录；Agent只查history；确认本人手工发和对方收均可识别 | 不以bridge fromSelf冒充全部本人，unknown |
| 时间边界 | 已知epoch t，查[t,t+1)、[t-1,t)、相邻非重叠窗口；同秒多条均保留，固定cutoff重复查 | 边界/排序不能证明则partial |
| 超页与同秒 | limit L与L+1、扩大limit、正反order结果集合对照；高密度窗至少L+1条且含同秒；无法继续枚举即止 | 达limit只标cap可能命中，partial+import，无无限缩窗 |
| 重复/cursor | 同固定history查两次，比较字节/ID集合；只比较实际账户cursor存在性/mtime/内容摘要前后，不打印身份/凭据；不运行new-messages | 若cursor隐式变更，禁用直连采集并报告 |
| 离线重登录 | Roy仅退出/重登专用副本，离线期间自然消息恢复后再查旧cutoff+后续窗；主微信继续原样 | 缺失范围独立pending/import |
| 迟到/截断 | 对同窗后续重复查询、会话删除/本地裁剪后的历史范围变化记录，不删除已保存事件；64位ID保真比对原始字节 | 迟到需replay，截断不伪完整 |
| 媒体/成员 | 保持no-transcribe且不抓图，确认媒体gap；群member wxid与同名显示名分别核对（额外只读members须协调者纳入scope） | 缺少成员映射不猜本人 |
| 重复导入 | 真实raw保本机，固定manifest account/chat/owner/time来源/IANA zone/范围；同raw重复导入、live重叠对照 | 无法证明duplicate只标疑似，不误删真重复 |

验收证据每步只进入本机私有目录；repo保存无正文结果摘要（范围、数量、缺口、工具版本/命令形状、exit、标识摘要）。doctor不是覆盖检查。普通缺口用complete/partial/unavailable/unknown具体说明，不能把缺数据解释为无活动。
