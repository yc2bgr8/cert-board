import { expect, test } from 'vitest';
import { revisionSections } from './walkthrough-report.js';

test('同级标题收尾，下级标题的正文留在所属走查小节', () => {
  const report = Buffer.from(
    [
      '# L08 核查',
      '## 核查范围',
      '本次读取同一申报资料的两页。',
      '## 已核实',
      '### 编号写法',
      '两页的写法不同。',
      '## 待核实',
      '### 正确编号',
      '等待核对申报原件。',
      '## 下一步',
      '这段属于其他小节。',
    ].join('\n'),
  );
  expect(Object.fromEntries(revisionSections(report))).toEqual({
    核查范围: '\n本次读取同一申报资料的两页。',
    已核实: '\n两页的写法不同。',
    待核实: '\n等待核对申报原件。',
  });
});

test('Markdown 围栏内的标题与正文都不能替代报告内容', () => {
  const report = Buffer.from(
    [
      '````md',
      '## 核查范围',
      '示例范围',
      '```',
      '## 已核实',
      '示例',
      '````',
      '## 待核实',
      '~~~md',
      '示例内容',
      '~~~',
    ].join('\n'),
  );
  expect(revisionSections(report).size).toBe(0);
});

test('嵌套的指定核查小节分别保留各自的正文', () => {
  const report = Buffer.from(
    [
      '# L08 核查',
      '## 核查范围',
      '申报资料两页。',
      '### 已核实',
      '两个编号写法不同。',
      '### 待核实',
      '原件仍待核对。',
    ].join('\n'),
  );
  expect(Object.fromEntries(revisionSections(report))).toEqual({
    核查范围: '\n申报资料两页。',
    已核实: '\n两个编号写法不同。',
    待核实: '\n原件仍待核对。',
  });
});
