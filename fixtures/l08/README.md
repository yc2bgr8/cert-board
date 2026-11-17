# L08测试资料

数据级别：内部（2026-11-17项目负责人确认可用于开发、测试、OpenRouter和GitHub私有仓库）。
L08原始申报资料不在仓库中，见参考资料快照 `data/l08/510k/`，由环境变量 `CERT_DATA_DIR` 指向。

| 路径 | 内容 | 来源 |
|---|---|---|
| `t1_out/pages.jsonl` | 逐页文本、解析方式、识别置信度 | T1解析流水线 |
| `t1_out/documents.json` | 资料清单与分类 | T1解析流水线 |
| `t1_out/checks.json` | T1的检查结果 | T1解析流水线 |
| `t1_out/estar_datasets.xml` | eSTAR表单数据 | T1解析流水线 |
| `t1_out/report.md` | T1解析报告 | T1解析流水线 |
| `rv05/rv05_findings.json` | RV-05一致性规则在L08上的发现（规则层回归基线） | 验证RV-05 |
| `manifests/manifest.json` | 申报包文件清单 | L08项目复盘 |
| `manifests/embedded_manifest.json` | eSTAR内嵌附件清单 | L08项目复盘 |
| `manifests/version_comparison.json` | eSTAR附件与外层文件的版本比对 | L08项目复盘 |
