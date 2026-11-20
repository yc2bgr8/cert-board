---
id: R01
version: 0.1.0-demo
name: 注册立项资料核对演示
summary: 核对立项草稿能否追溯到已登记的资料。
agentCode: registration
capability: 注册立项
level: 2
modes: [read_only, ask, full]
requiredChecks: [V1, V3]
minimumEvidence: 2
risk: standard
suggestedSubagents: []
evaluation: 注册立项合成回放
---

# 注册立项资料核对演示

草稿，待注册人员确认。仅使用合成资料试行。

先读项目说明，登记任务计划。核对器械名称、型号及预期用途的资料出处。在答复中列出缺失项和需要人确认的问题。已有依据逐字引用并标明版本页码。只有人确认后才使用该能力处理真实立项。
