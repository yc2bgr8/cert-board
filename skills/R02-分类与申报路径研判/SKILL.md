---
id: R02
version: 0.1.0
name: 分类与申报路径研判
summary: 依据用途、技术和目标市场回查官方分类与候选路径，列候选记录及差异后送审。
agentCode: registration
capability: 分类与申报路径研判
level: 2
modes: [read_only, ask, full]
requiredChecks: [V1, V3]
minimumEvidence: 2
risk: standard
evaluation: eval:r01-r02
---

# R02 分类与申报路径研判

草稿，待注册人员确认。依据需求 V1.0 的 R02、D22、v7 K03、SY-QP-15 A3 第 5.2 节和《设计输入评审记录》。重大路径由管理层决定并由注册人员记录。

## 什么时候用

项目已确认目标市场，或注册人员明确询问器械类别、产品代码、申报路径或对比候选时。先用 `cert_context`、`doc_search`、`doc_read` 取得产品用途、适用人群、使用环境、主要技术特征、既有许可与拟变更范围。缺少足以影响分类的输入时列待核项，限定结论适用范围。

## 回查与比较

1. 美国项目先查 FDA 产品分类记录中的产品代码、法规号、类别、510(k) 豁免状态及限制。再按用途和技术特征查同类官方 510(k) 记录和摘要。回查每个代码和 K 号，保留官方定位、决定日期、候选适用和明显差异。官方回查无结果的编号剔出候选，保留为待核线索。依据 FDA 产品代码指南及 510(k) 介绍。[FDA 产品代码指南](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/medical-device-classification-product-codes-guidance-industry-and-fda-staff) · [FDA 510(k)](https://www.fda.gov/medical-devices/premarket-submissions-selecting-and-preparing-correct-submission/premarket-notification-510k)
2. 使用 `official_lookup` 取得已有规则允许的官方数据，用 `identifier_check` 对编号和资料原文复核；通过 `web_fetch` 保存已授权的公开来源，再用 `doc_read` 引用。以用途匹配、技术差异和所需证据比较候选。公开同类摘要中采用的标准可作为 R04 检索线索，适用性和版本须另核对。对比候选及路径需有独立的说明和出处。依据 FDA 510(k) 内容及对比器械相关字段。[FDA 510(k) 内容](https://www.fda.gov/medical-devices/premarket-notification-510k/content-510k)
3. 按真实项目条件分别比较 Traditional、Special 和 Abbreviated 510(k)。已有合法上市记录、拟变更对象和方法是否适合在对应路径下评估要分别核对。未找到合法合适的对比器械且拟适用低至中风险分类方式时，把 De Novo 留为带依据的候选。以现行官方指南复核资格和限制，保留缺少的材料供注册人员决定。[FDA 申报路径入口](https://www.fda.gov/medical-devices/device-advice-comprehensive-regulatory-assistance/how-study-and-market-your-device) · [FDA De Novo](https://www.fda.gov/medical-devices/premarket-submissions-selecting-and-preparing-correct-submission/de-novo-classification-request)
4. 加拿大项目按本国现行分类规则复核器械风险类别和 MDL，另按主体角色、进口或分销活动和豁免核查 MDEL。断定牌照适用性前先确认制造商、进口商、分销商的真实角色。工具访问受限时保留官方来源待核。其他市场仅使用已生效的对应规则包。[加拿大卫生部器械进口要求](https://www.canada.ca/en/health-canada/services/drugs-health-products/compliance-enforcement/importation-exportation/regulatory-importing-medical-devices.html)
5. 每完成一步汇报已找到的官方记录和剩余缺口。分类、路径或候选差异不明确时保留备选。请求批准模式在关键判断前说明建议、理由和出处，待人确认后继续；完全允许模式记录有依据的判断并提交最终审核。

## 交付和审核

在工作副本保存 `交付/分类与申报路径研判.md`。分别列产品事实、适用市场、分类候选、路径备选、逐个核验的对比器械及差异、建议与缺口。记录候选编号的官方链接和读取时点。仅把回放时点已经可得的来源用于结论。

用已保存的同一 `workspaceVersion` 运行 `check_run`，通过后送人审核。报告中的事实、判断及引用原文实际经过 `doc_read`。法定期限用 `deadline_calc`，未知事项保留待核。监管提交、缴费和签署由人处理。
