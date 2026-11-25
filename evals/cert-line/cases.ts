// 来源：参考资料快照 sources/cert-line-assets/eval/cert-cases.ts，保留 120 个原示例与期望。
/**
 * 认证线 AI 评测集（PR-71）：③ 申报字段抽取 cx、④ 发补拆项 dx 与应答底稿 dr、① 法规更新摘要 rg、② 同类产品初判 pd、
 * ⑥ 合规报告描述段 rp，各 20 个用例。全部为示例或公开风格的数据（型号、编号为虚构的示例值，不含公司资料、不含人名）。
 * 云端只放这些用例；本地上线后用内网完整评测集（L-1、L-2 标注）按同样结构再跑一遍（PR-72）。
 */
import type { ClassificationRow, PredicateRow } from './contracts.js';
import { classificationUrlOf, pmnUrlOf, summaryUrlOf } from './contracts.js';
import type { EvalCase } from './contracts.js';

const pick = <T>(arr: readonly T[], i: number) => arr[i % arr.length]!;

// ---------------------------------------------------------------------------
// ③ cx 申报字段抽取：器械描述、说明书、标签片段；部分用例带上一代型号的干扰句
// ---------------------------------------------------------------------------

const MODELS = ['JB-C1', 'JB-C2', 'JB-A1', 'JB-T1', 'JB-C1S'];
const PRESSURES = [
  ['4', '20'],
  ['4', '25'],
  ['3', '20'],
  ['5', '18'],
];
const VERSIONS = ['V1.2.0', 'V1.3.1', 'V2.0.0', 'V1.0.5'];
const MATERIALS = ['医用级液体硅胶', '聚碳酸酯与医用硅胶', '热塑性弹性体（TPE）'];
const SOURCES = ['器械描述', '说明书', '标签与包装', '性能测试报告摘要'];

function cxCases(): EvalCase[] {
  const out: EvalCase[] = [];
  for (let i = 0; i < 20; i++) {
    const model = pick(MODELS, i);
    const [lo, hi] = pick(PRESSURES, i);
    const ver = pick(VERSIONS, i + 1);
    const mat = pick(MATERIALS, i);
    const lines = [
      `${pick(SOURCES, i)}`,
      `本文件适用于持续正压通气治疗设备，型号 ${model}。`,
      `预期用途：用于体重 30 kg 以上的成人阻塞性睡眠呼吸暂停患者的持续正压通气治疗。`,
      `治疗压力范围 ${lo}–${hi} cmH₂O，步进 0.5 cmH₂O。`,
      `额定输入电压 100–240 V～，50/60 Hz。`,
      `软件版本 ${ver}。`,
      `与患者接触的材料为${mat}。`,
    ];
    const expected: Record<string, string> = {
      model,
      pressure_range: `${lo}–${hi} cmH₂O`,
      software_version: ver,
    };
    // 每 3 个用例加一句上一代型号的干扰信息
    if (i % 3 === 0) lines.splice(4, 0, `注：上一代型号 JB-A0 的治疗压力范围为 4–18 cmH₂O，已停产。`);
    // 每 4 个用例去掉软件版本（不应编造）
    if (i % 4 === 1) {
      lines.splice(
        lines.findIndex((l) => l.startsWith('软件版本')),
        1,
      );
      delete expected.software_version;
    }
    const text = lines.join('\n');
    out.push({
      id: `cx-${String(i + 1).padStart(2, '0')}`,
      touchpoint: 'cx',
      title: `${pick(SOURCES, i)} · ${model}${i % 3 === 0 ? ' · 含干扰句' : ''}${i % 4 === 1 ? ' · 无软件版本' : ''}`,
      vars: { source: `${pick(SOURCES, i)}（示例）`, text },
      ctx: { text, cx: expected },
      expect: {},
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// ④ dx 发补拆项：FDA AI Request 风格的示例缺陷信，2–5 个问题
// ---------------------------------------------------------------------------

const DEFICIENCY_POOL: { text: string; key: string }[] = [
  {
    text: 'Please provide the complete cytotoxicity, sensitization and irritation test reports per ISO 10993 for all patient-contacting materials.',
    key: 'cytotoxicity, sensitization and irritation',
  },
  {
    text: 'The software documentation does not include an unresolved anomalies list. Please provide the list with an assessment of the impact of each anomaly on safety and effectiveness.',
    key: 'unresolved anomalies list',
  },
  {
    text: 'Your labeling does not specify the maximum duration of use. Please revise the Instructions for Use to state the maximum wear time.',
    key: 'maximum duration of use',
  },
  {
    text: 'Please provide a cybersecurity risk assessment, including a software bill of materials (SBOM) and a plan for monitoring and addressing postmarket vulnerabilities.',
    key: 'software bill of materials (SBOM)',
  },
  {
    text: 'The pressure accuracy testing was performed at only one ambient condition. Please provide testing across the full range of operating temperatures and altitudes stated in your labeling.',
    key: 'full range of operating temperatures and altitudes',
  },
  {
    text: 'Please clarify whether the predicate device and the subject device have the same intended use, and explain any differences in the indications for use statements.',
    key: 'same intended use',
  },
  {
    text: 'The electrical safety test report references IEC 60601-1:2005 only. Please provide evidence of conformance with the currently recognized edition including Amendment 2.',
    key: 'including Amendment 2',
  },
  {
    text: 'Please provide human factors validation data demonstrating that intended users can correctly assemble the humidifier chamber without use errors that could result in harm.',
    key: 'human factors validation data',
  },
];

function dxCases(): EvalCase[] {
  const out: EvalCase[] = [];
  for (let i = 0; i < 20; i++) {
    const n = 2 + (i % 4);
    const picked = Array.from({ length: n }, (_, k) => pick(DEFICIENCY_POOL, i + k * 3));
    const lines = picked.map((d, k) => `Deficiency ${k + 1}. ${d.text}`);
    const letter = [
      `Subject: K24${String(1000 + i).padStart(4, '0')} — Additional Information Request (example)`,
      'Dear Sir or Madam: We have reviewed your premarket notification and require the following information.',
      ...lines,
      'Please submit your response within 180 calendar days. This letter is an example for evaluation only.',
    ].join('\n');
    out.push({
      id: `dx-${String(i + 1).padStart(2, '0')}`,
      touchpoint: 'dx',
      title: `示例缺陷信 · ${n} 个问题`,
      vars: { letter },
      ctx: { text: letter, deficiencies: lines },
      expect: { keywords: picked.map((d) => d.key) },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// ④ dr 应答底稿：一个问题 + 3 段检索结果（1 段相关、2 段干扰）
// ---------------------------------------------------------------------------

const DR_TOPICS: { q: string; good: string; bad: string[] }[] = [
  {
    q: 'Please provide cytotoxicity test results per ISO 10993-5 for the mask cushion.',
    good: 'The mask cushion made of medical-grade liquid silicone was tested per ISO 10993-5; the test article showed no cytotoxic potential (grade 0) in report BC-2023-017.',
    bad: [
      'Electrical safety testing per IEC 60601-1 was completed by the test laboratory with no failures.',
      'The device packaging was validated per ISTA 2A for distribution.',
    ],
  },
  {
    q: 'Please provide the unresolved anomalies list for the device software.',
    good: 'At release V1.3.0 there were 4 unresolved anomalies, none of which affect therapy pressure delivery; each was assessed in the anomaly list SW-AL-013 with a risk rationale.',
    bad: [
      'The humidifier chamber is dishwasher safe up to 65 °C.',
      'Biocompatibility of the tubing was addressed by material equivalence to the predicate.',
    ],
  },
  {
    q: 'Please state the maximum wear time in the Instructions for Use.',
    good: 'Section 5.2 of the revised IFU states that the oral appliance may be worn up to 10 hours per night, consistent with the wear-time study WT-2024-02.',
    bad: [
      'The cybersecurity risk assessment identified 12 threats with mitigations.',
      'Pressure accuracy was verified at 3 altitudes.',
    ],
  },
  {
    q: 'Please provide pressure accuracy testing across the full operating temperature range.',
    good: 'Pressure accuracy was verified at 5 °C, 23 °C and 35 °C; all measurements were within ±0.5 cmH₂O of the set pressure (report PA-2024-08).',
    bad: [
      'The device label includes the UDI in human- and machine-readable form.',
      'The predicate device K201234 has the same intended use.',
    ],
  },
  {
    q: 'Please provide a software bill of materials.',
    good: 'An SBOM listing 37 third-party components with version and support status was provided as attachment CS-SBOM-03, generated from the release build.',
    bad: [
      'The device was tested for EMC per IEC 60601-1-2 edition 4.1.',
      'The humidifier heater plate supplier was changed in 2023.',
    ],
  },
];

function drCases(): EvalCase[] {
  const out: EvalCase[] = [];
  for (let i = 0; i < 20; i++) {
    const t = pick(DR_TOPICS, i);
    const pos = i % 3; // 相关段落的位置
    const passages = [...t.bad];
    passages.splice(pos, 0, t.good);
    out.push({
      id: `dr-${String(i + 1).padStart(2, '0')}`,
      touchpoint: 'dr',
      title: `应答底稿 · 相关段落在第 ${pos + 1} 段`,
      vars: {
        question: t.q,
        passages: passages.map((p, k) => `[${k + 1}]（历史应答示例 ${k + 1}）\n${p}`).join('\n\n'),
      },
      ctx: { passages: passages.map((p) => ({ text: p })), relevant: pos + 1 },
      expect: {},
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// ① rg 法规更新摘要：联邦公报 / FDA 公告风格，示例公司型号
// ---------------------------------------------------------------------------

const COMPANY_MODELS = [
  ['持续正压通气设备', 'JB-C1'],
  ['持续正压通气设备', 'JB-C2'],
  ['抗鼾口腔矫治器', 'SG-01'],
  ['睡眠监测 App', 'JB-APP'],
] as const;

const RG_UPDATES: { title: string; abstract: string; models: string[] }[] = [
  {
    title:
      'Cybersecurity in Medical Devices: Quality System Considerations and Content of Premarket Submissions; Guidance (example)',
    abstract:
      'FDA is announcing the availability of a final guidance on cybersecurity for devices with software or network connectivity.',
    models: ['JB-C1', 'JB-C2', 'JB-APP'],
  },
  {
    title:
      'Medical Devices; Anesthesiology Devices; Classification of the Positive Airway Pressure Device Accessory (example)',
    abstract:
      'FDA is classifying a positive airway pressure (CPAP) accessory into class II with special controls.',
    models: ['JB-C1', 'JB-C2'],
  },
  {
    title:
      'Medical Devices; Dental Devices; Intraoral Devices for Snoring and/or Obstructive Sleep Apnea; Special Controls (example)',
    abstract:
      'FDA is amending special controls for intraoral devices intended to reduce snoring and mild to moderate obstructive sleep apnea.',
    models: ['SG-01'],
  },
  {
    title:
      'Medical Devices; Ophthalmic Devices; Classification of the Intraocular Pressure Monitor (example)',
    abstract: 'FDA is classifying an intraocular pressure monitor into class II.',
    models: [],
  },
  {
    title: 'Recognized Consensus Standards: Biocompatibility ISO 10993-1 Recognition Modification (example)',
    abstract:
      'FDA is modifying its recognition of ISO 10993-1 for biological evaluation of patient-contacting devices.',
    models: ['JB-C1', 'JB-C2', 'SG-01'],
  },
  {
    title: 'Orthopedic Devices; Reclassification of Bone Growth Stimulators (example)',
    abstract: 'FDA is reclassifying non-invasive bone growth stimulators.',
    models: [],
  },
  {
    title: 'Mobile Medical Applications; Policy for Device Software Functions (example)',
    abstract:
      'FDA is announcing an updated guidance describing device software functions on mobile platforms, including apps that analyze sleep data.',
    models: ['JB-APP'],
  },
  {
    title: 'Radiological Health; Mammography Quality Standards; Amendments (example)',
    abstract: 'FDA is amending mammography quality standards.',
    models: [],
  },
  {
    title:
      'Electronic Submission Template for Medical Device 510(k) Submissions (eSTAR) Version Update (example)',
    abstract:
      'FDA announces a new eSTAR template version required for 510(k) submissions after the transition date.',
    models: ['JB-C1', 'JB-C2', 'SG-01', 'JB-APP'],
  },
  {
    title: 'Dental Devices; Dental Amalgam Labeling Recommendations (example)',
    abstract: 'FDA recommends labeling changes for dental amalgam devices.',
    models: [],
  },
];

function rgCases(): EvalCase[] {
  const out: EvalCase[] = [];
  for (let i = 0; i < 20; i++) {
    const u = pick(RG_UPDATES, i);
    out.push({
      id: `rg-${String(i + 1).padStart(2, '0')}`,
      touchpoint: 'rg',
      title: `${u.models.length ? '相关' : '不相关'} · ${u.title.slice(0, 40)}`,
      vars: {
        source: i % 2 ? 'FDA 医疗器械动态（RSS）' : '联邦公报（FDA · 器械）',
        title: u.title,
        url: `https://www.federalregister.gov/documents/2026/11/${String((i % 28) + 1).padStart(2, '0')}/example-${i + 1}`,
        abstract: u.abstract,
        models: COMPANY_MODELS.map(([n, c]) => `${n} ${c}`).join('\n'),
      },
      ctx: { modelCodes: COMPANY_MODELS.map(([, c]) => c), impact: u.models },
      expect: { none: !u.models.length },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// ② pd 同类产品与路径初判：openFDA 风格的分类与 510(k) 结果（K 号为示例值）
// ---------------------------------------------------------------------------

const PD_PRODUCTS: {
  code: string;
  name: string;
  cls: string;
  reg: string;
  panel: string;
  devices: string[];
}[] = [
  {
    code: 'LRK',
    name: 'Device, Anti-Snoring',
    cls: '2',
    reg: '872.5570',
    panel: 'Dental',
    devices: ['Oral Appliance', 'Mandibular Advancement Device'],
  },
  {
    code: 'BZD',
    name: 'Ventilator, Non-Continuous (Respirator)',
    cls: '2',
    reg: '868.5905',
    panel: 'Anesthesiology',
    devices: ['CPAP System', 'Auto CPAP'],
  },
  {
    code: 'MNR',
    name: 'Ventilatory Effort Recorder',
    cls: '2',
    reg: '868.2375',
    panel: 'Anesthesiology',
    devices: ['Home Sleep Test', 'Sleep Recorder'],
  },
  {
    code: 'OLV',
    name: 'Electroencephalograph Sleep Software',
    cls: '2',
    reg: '882.1400',
    panel: 'Neurology',
    devices: ['Sleep Staging Software', 'Sleep App'],
  },
  {
    code: 'BTT',
    name: 'Humidifier, Respiratory Gas (Direct Patient Interface)',
    cls: '2',
    reg: '868.5450',
    panel: 'Anesthesiology',
    devices: ['Heated Humidifier', 'Humidifier Chamber'],
  },
];

function pdCases(): EvalCase[] {
  const out: EvalCase[] = [];
  for (let i = 0; i < 20; i++) {
    const p = pick(PD_PRODUCTS, i);
    const other = pick(PD_PRODUCTS, i + 1);
    const classification: ClassificationRow[] = [p, ...(i % 2 ? [other] : [])].map((x) => ({
      productCode: x.code,
      deviceName: x.name,
      deviceClass: x.cls,
      regulationNumber: x.reg,
      panel: x.panel,
      url: classificationUrlOf(x.code),
    }));
    const results: PredicateRow[] = Array.from({ length: 4 }, (_, k) => {
      const k510 = `K2${4 - (k % 3)}${String(3000 + i * 7 + k).padStart(4, '0')}`;
      return {
        kNumber: k510,
        deviceName: `${pick(p.devices, k)} (example ${k + 1})`,
        applicant: `Example Maker ${String.fromCharCode(65 + k)}`,
        decisionDate: `20${24 - (k % 3)}-0${(k % 9) + 1}-15`,
        productCode: p.code,
        decision: 'Substantially Equivalent (SESE)',
        url: pmnUrlOf(k510),
        summaryUrl: summaryUrlOf(k510),
      };
    });
    out.push({
      id: `pd-${String(i + 1).padStart(2, '0')}`,
      touchpoint: 'pd',
      title: `产品代码 ${p.code}${i % 2 ? ' · 含相邻分类' : ''}`,
      vars: {
        query: i % 2 ? `关键词 ${pick(p.devices, i).toLowerCase()}` : `产品代码 ${p.code}`,
        classification: classification
          .map(
            (c) =>
              `${c.productCode} | ${c.deviceName} | Class ${c.deviceClass} | 21 CFR ${c.regulationNumber}`,
          )
          .join('\n'),
        results: results
          .map(
            (r) => `${r.kNumber} | ${r.deviceName} | ${r.applicant} | ${r.decisionDate} | ${r.productCode}`,
          )
          .join('\n'),
      },
      ctx: { classification, results, productCode: p.code },
      expect: {},
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// ⑥ rp 合规报告描述段：主表事实（示例），段落中的编号、数字必须来自事实
// ---------------------------------------------------------------------------

function rpCases(): EvalCase[] {
  const out: EvalCase[] = [];
  const statuses = ['已列名（K241234）', '已上市（MDL 123456）', '申请中', '未申请'];
  for (let i = 0; i < 20; i++) {
    const model = pick(['JB-C1', 'JB-C2', 'SG-01', 'JB-T1'], i);
    const us = pick(statuses, i);
    const ca = pick(statuses, i + 1);
    const fields = [
      ['产品', model.startsWith('SG') ? '抗鼾口腔矫治器' : '持续正压通气设备'],
      ['型号', model],
      ['美国上市状态', us],
      ['加拿大上市状态', ca],
      ['UDI-DI', i % 3 ? `0690000000${String(1000 + i)}` : ''],
      ['MDSAP 证书', i % 2 ? 'MDSAP-2025-001（有效期至 2028-03-30）' : ''],
    ].filter(([, v]) => v);
    const facts = fields.map(([k, v]) => `${k}：${v}`).join('\n');
    out.push({
      id: `rp-${String(i + 1).padStart(2, '0')}`,
      touchpoint: 'rp',
      title: `合规报告 · ${model} · 美国${us.slice(0, 3)} / 加拿大${ca.slice(0, 3)}`,
      vars: { title: `合规报告 · ${model}`, facts },
      ctx: { facts: fields.map(([, v]) => v).join(' '), model },
      expect: {},
    });
  }
  return out;
}

export function certEvalCases(): EvalCase[] {
  return [...cxCases(), ...dxCases(), ...drCases(), ...rgCases(), ...pdCases(), ...rpCases()];
}
