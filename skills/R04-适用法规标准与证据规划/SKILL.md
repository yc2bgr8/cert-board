---
id: R04
version: 0.1.0
name: 适用法规标准与证据规划
summary: 按已确定的市场、路径和器械特征列出适用依据、证据缺口和样品覆盖范围。
agentCode: registration
capability: 适用法规标准与证据规划
level: 2
modes: [read_only, ask, full]
requiredChecks: [V1, V3]
minimumEvidence: 2
risk: standard
suggestedSubagents: [核对目标市场的公开依据, 核对测试资料和样品配置]
evaluation: eval:r04
---

# R04 适用法规标准与证据规划

草稿，待注册人员确认。依据需求 V1.0 的 R04、D17、v7 K07 和 SY-QP-15 A3 第 5.2、5.3、5.5、5.6 节。正式启用前由注册人员审核版本。

## 什么时候用

R02 已确定目标市场与拟走路径，需要规划证据或重新核对设计、市场、公开依据变更时使用。只有产品名称或市场未确定时，先列出缺少的输入。不同市场各用其对应的法规和认可目录。

## 阅读资料和规划证据

1. 读取项目说明、已确认的市场和路径、产品定义、设计输入与目标型号配置。用 `doc_search` 发现定位，再用 `doc_read` 取得完整原文。从原文核对预期用途、接触部位及时间、重复使用和清洁、材料、保存期限、供电、软件、气路、无线与联网分别适用于哪些配置。公开产品名称和对比器械列表只能作为检索线索。依据 SY-QP-15 A3 第 5.2 节和《设计输入评审记录》。
2. 按已确认的市场选择候选法规、指南和认可标准。核对公开来源的版本、日期、认可号、完整或部分认可、适用范围与旧版过渡日期。使用 `web_fetch` 存档可访问的官方资料，随后用 `doc_read` 读取所引位置。公开信息不足时，将具体条款标为「待提供标准原文」。依据 v7 D17 和 FDA《适当使用自愿共识标准》的认可范围与符合性声明部分。
3. 对每类证据写明触发特征和依据，核对当前有无适用的原件或有效记录。按需求 R04 记录「已有」「缺失」「过期」或「待确认」。已存在报告只表示已有可读文件，须另核对实际试验、版本和准则后才能作出满足性判断。根据范围选择类目。接触口腔黏膜时分别检查细胞毒性、致敏和皮内反应，重复用器械核对清洁和耐久，宣称存放期限时核对货架寿命。分别核对材料对应关系和标签。对于睡眠呼吸治疗设备，按原文的供电、气路、软件、用户、通信与连接条件核查电气安全、EMC、专用性能、气路生物相容性、软件、网络安全、人因和无线共存。
4. 每份现有证据记录报告编号、版本和页码，并分别写出测试样品的型号、尺寸、配置与拟覆盖范围。缺少明确代表性说明时写「覆盖范围待确认」，保留实际样品范围。缺少接受准则的来源时保留待核，不能记为满足。依据 SY-QP-15 A3 第 5.5、5.6 节和《设计开发验证计划》《设计开发验证记录》。
5. 每完成一步在对话中汇报已核对的范围和下一步。依据冲突时先保留冲突及缺口。完全允许模式可记录有据的适用性判断并继续，请求批准模式在关键判断前提交建议和备选并等待人确认，只读模式返回证据清单和缺项。

### 美国市场公开依据索引

2026-11-25 查阅。用对应资料确认适用性和版次，缺少条款或准则正文时标「待提供标准原文」。

| 主题 | 公开版本和核对点 | 官方原页 |
|---|---|---|
| 认可范围和符合性声明 | FDA 自愿共识标准适当使用指南，2018 年 9 月版 | [共识标准使用指南](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/appropriate-use-voluntary-consensus-standards-premarket-submissions-medical-devices) |
| 口内器械、材料、黏膜接触、标签 | FDA 口内器械特别控制指南。2002 年 11 月版，第 4、6、7、9 节。另核对当前认可版次 | [口内器械特别控制指南](https://www.fda.gov/medical-devices/guidance-documents-medical-devices-and-radiation-emitting-products/intraoral-devices-snoring-andor-obstructive-sleep-apnea-class-ii-special-controls-guidance-document) |
| 接触材料的生物学评价 | ISO 10993‑1 2025‑11 第六版，2‑313 部分认可。2‑258 符合性声明过渡至 2029‑07‑01，核对认可排除范围 | [FDA 2‑313](https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfstandards/detail.cfm?standard__identification_no=47116) |
| 重复使用与清洁 | FDA 重复使用医疗器械再处理指南，2015 年 3 月版。核对已声明的清洁步骤、用途和验证范围 | [再处理验证与标签指南](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/reprocessing-medical-devices-health-care-settings-validation-methods-and-labeling) |
| 有源设备电气与 EMC | IEC 60601‑1 3.2 版（2020‑08），19‑49 须核对美国差异；IEC 60601‑1‑2 4.1 版（2020‑09），19‑36 | [FDA 19‑49](https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfstandards/detail.cfm?standard__identification_no=44029) · [FDA 19‑36](https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfstandards/detail.cfm?standard__identification_no=41539) |
| 睡眠呼吸治疗专用性能 | ISO 80601‑2‑70 2025‑11 第三版，1‑199 完整认可。1‑151 符合性声明过渡至 2028‑12‑17 | [FDA 1‑199](https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfstandards/detail.cfm?standard__identification_no=46594) |
| 气路材料 | ISO 18562‑1 2024‑03 第二版，1‑173。根据气路及危害明确需检查的后续分部 | [FDA 1‑173](https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfstandards/detail.cfm?standard__identification_no=45207) |
| 软件与网络安全 | FDA 软件提交内容指南，2023 年 6 月版；FDA 医疗器械网络安全指南，2026 年 2 月版。分别记录软件功能和通信能力 | [软件指南](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/content-premarket-submissions-device-software-functions) · [网络安全指南](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/cybersecurity-medical-devices-quality-management-system-considerations-and-content-premarket) |
| 人因与使用 | FDA 人因和可用性工程指南，2026 年 8 月版。按预期用户、任务和场所核对适用性 | [人因指南](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/applying-human-factors-and-usability-engineering-medical-devices) |
| 无线共存 | ANSI C63.27‑2021，19‑48 完整认可。核对 RF 通信和使用环境，另读 FDA 2013 年 8 月无线技术指南 | [FDA 19‑48](https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfstandards/detail.cfm?standard__identification_no=43691) · [无线指南](https://www.fda.gov/regulatory-information/search-fda-guidance-documents/radio-frequency-wireless-technology-medical-devices-guidance-industry-and-fda-staff) |

## 交付、自查和审核

保存 `交付/适用依据与证据规划.md`，首段写所用市场、路径、日期和项目资料版本。逐项列出证据类别、产品原文、适用或不适用理由、依据版本及原文定位、证据状态、实际样品型号尺寸配置、已证实覆盖范围、接受准则、待核项和下一步。标识已读取的公开信息与所缺条款。R06 和 R08 引用已审核的规划版本。

按 `workspace_save`、`check_run`、`submit_for_review` 的既有流程送审，使用同一次保存的 `workspaceVersion`。每项证据同时核对产品原文与市场依据。记录 `claims`、`decisions`、`evidence`、`missing`、`uncertain`、`nextStep`。需要带数值时用实际报告里具有对应单位的数值和原文，期限由工具按法域计算。浏览器审核由注册人员执行。

## 常见错误

- 把已获批器械的公开摘要或已知答案当成本次回放可见资料。只读符合回放日期和项目权限的产品定义及设计输入。
- 把 FDA 认可号当成适用性结论，或忽略部分认可、美国差异及过渡日期。
- 把样品测试覆盖范围扩大到未测尺寸、版本或配置，或用报告状态代替接受准则。
- 把带软件等同于联网，或者把无无线功能等同于无需核对其他联网路径与安全风险。
