---
skill:
  id: M02
  version: 0.1.0
publication: draft
developmentOnly: true
requiredChecks:
  - V1
  - V3
minimumEvidence: 2
risk: standard
cardType: finalize
---

# M02 年度注册资料核查

草稿，待注册人员确认。所属Agent：maintenance。仅用于开发环境中对已有资料的核对，不是已发布的实时官方核查或年度注册办理能力。

## 什么时候用

在维护事项中核对已导入的企业注册记录、年费付款凭据和美国代理人协议，整理缺口与待确认事项。没有官方数据工具时不查询FDA，也不推断当前有效状态；缺少适用年度、付款信息或协议签署页时提问，不补写事实。

## 工作方法

先读项目说明，用 plan_update 列出步骤。用 doc_search 按资料名称或正文词查找三类资料，再逐页 doc_read。每完成一类，说明已读来源、仍缺什么及下一步。文件名或摘要只能定位，引用以逐页正文为准。DOCX 定位是提取单元。依据 AGENTS.md 的工作方法、SY-QP-15 A3 第 5.7 节的归档和 DMR 规则，以及 FDA《How to Register and List》的缴费和注册记录区分。

分别记录内部归档状态及适用年度、付款凭据、美国代理人协议的有效期和联系人。只记录资料明确给出的事实。需要确认的官方状态、期限和付款情况列入待核实事项。依据 FDA《When to Register and List》《How to Register and List》及项目的实际文件。

金额等数量保留来源和单位。缺少适用的期限程序、数值检查回执或官方记录时，清楚写出该项待核实。依据 AGENTS.md 的事实与期限规则、核验工具说明以及项目的实际记录。

将有依据的过程判断记录到 decisions。遇到缺少而无法推导的关键事实时用 ask_user 集中提问。写提醒或排内部消息时遵循浏览器批准和已登记的工具限制。需要发邮件时生成草稿及提案。依据需求 V1.0 的权限模式和最终结果审核规则、v6 第 1.5 节及 v7 D03。

## 交付和检查

有足够资料时，在工作副本形成核查记录，写出三类资料的来源和限制、已发生的实际改动、缺口、建议与风险。保存为新版本后运行 check_run，提交审核。提交字段为 skill、workspaceVersion、conclusion、claims、decisions、evidence、missing、uncertain、nextStep。至少两条不同完整引文，判断来源也须经过本对话 doc_read。V1 和 V3 必须通过，未执行的检查如实标明。依据 AGENTS.md 的工作区与审核规则及提交审核工具说明。

资料不够时用ask_user集中提问，保留已有事实并停止相应写入。审核通过不等于年度注册、缴费或协议签署已办结。本开发切片不得发送任何真实消息或操作监管门户。
