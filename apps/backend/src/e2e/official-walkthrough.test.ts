import { expect, test } from 'vitest';
import { officialReviewConclusionMatches } from './official-walkthrough.js';

test('官方专项只接受结论首句的编号、差异和待确认状态', () => {
  const finding = '编号核对：材料 K170285，官方 K170825，差异 疑似笔误，状态 待确认';
  expect(officialReviewConclusionMatches(`${finding}。两处原文分别引用。`)).toBe(true);
  expect(officialReviewConclusionMatches(`已排除以下说法：${finding}。`)).toBe(false);
  expect(officialReviewConclusionMatches(`目前证据不足。${finding}。`)).toBe(false);
  expect(officialReviewConclusionMatches(finding.replace('待确认', '已核实'))).toBe(false);
});
