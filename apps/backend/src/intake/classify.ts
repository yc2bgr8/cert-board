import type { IntakeCategory } from '@cert-board/shared';

// 按团队清单的章节和 T1 文件名惯例建立草稿规则，等待注册人员确认。
const categories: Array<[IntakeCategory, RegExp]> = [
  ['summary', /510\s*\(?k\)?.{0,8}(summary|statement)|摘要|总结/iu],
  ['biocompatibility', /biocompat|10993|18562|生物相容/iu],
  ['shelf_life', /steril|shelf[ _-]?life|expiration|灭菌|货架|有效期/iu],
  ['electrical', /electrical|60601|\bemc\b|电气|电磁/iu],
  ['software_security', /software|cybersecurity|\bsbom\b|软件|网络安全/iu],
  ['human_factors', /human[ _-]?factor|usability|人因|可用性/iu],
  ['predicate', /predicate|equivalen|对比器械|实质等同/iu],
  ['indications', /indications?|intended[ _-]?use|3881|适应症|预期用途/iu],
  ['labeling', /label[ls]?\b|labeling|\bifu\b|instruction|标签|说明书/iu],
  ['device_description', /(product|device)[ _-]?description|器械描述|产品描述/iu],
  ['declarations', /declaration|truthful|user[ _-]?fee|attestation|声明|费用/iu],
  ['application', /estar|cover[ _-]?letter|applicant|授权|申请人/iu],
  ['performance', /performance|validation|verification|durability|test[ _-]?report|验证|测试/iu],
];

export function classifyIntakePath(path: string): {
  category: IntakeCategory;
  confidence: number | null;
} {
  const symbol = categories.find(([, pattern]) => pattern.test(path.split('!/').at(-1) ?? path));
  return symbol
    ? { category: symbol[0], confidence: 1 }
    : { category: 'review_needed', confidence: null };
}
