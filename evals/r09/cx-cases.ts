// 合成 cx 用例移植自参考快照 sources/cert-line-assets/eval/cert-cases.ts 中的 cxCases。
export interface CxCase {
  id: string;
  source: string;
  text: string;
  expected: { model: string; pressure_range: string; software_version?: string };
}

const models = ['JB-C1', 'JB-C2', 'JB-A1', 'JB-T1', 'JB-C1S'];
const pressures = [
  ['4', '20'],
  ['4', '25'],
  ['3', '20'],
  ['5', '18'],
] as const;
const versions = ['V1.2.0', 'V1.3.1', 'V2.0.0', 'V1.0.5'];
const materials = ['医用级液体硅胶', '聚碳酸酯与医用硅胶', '热塑性弹性体（TPE）'];
const sources = ['器械描述', '说明书', '标签与包装', '性能测试报告摘要'];
const pick = <T>(values: readonly T[], index: number) => values[index % values.length]!;

export const cxCases: readonly CxCase[] = Array.from({ length: 20 }, (_, index) => {
  const model = pick(models, index);
  const [low, high] = pick(pressures, index);
  const pressure_range = `${low}–${high} cmH₂O`;
  const software = pick(versions, index + 1);
  const hasSoftware = index % 4 !== 1;
  const source = pick(sources, index);
  const lines = [
    source,
    `本文件适用于持续正压通气治疗设备，型号 ${model}。`,
    '预期用途：用于体重 30 kg 以上的成人阻塞性睡眠呼吸暂停患者的持续正压通气治疗。',
    `治疗压力范围 ${pressure_range}，步进 0.5 cmH₂O。`,
    ...(index % 3 === 0 ? ['注：上一代型号 JB-A0 的治疗压力范围为 4–18 cmH₂O，已停产。'] : []),
    '额定输入电压 100–240 V～，50/60 Hz。',
    ...(hasSoftware ? [`软件版本 ${software}。`] : []),
    `与患者接触的材料为${pick(materials, index)}。`,
  ];
  return {
    id: `cx-${String(index + 1).padStart(2, '0')}`,
    source: `${source}（合成示例）`,
    text: lines.join('\n'),
    expected: { model, pressure_range, ...(hasSoftware ? { software_version: software } : {}) },
  };
});
