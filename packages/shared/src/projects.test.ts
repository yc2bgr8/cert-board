import { expect, test } from 'vitest';
import { projectCreateSchema, projectPatchSchema, projectListOptionsSchema } from './projects.js';

const project = {
  name: '示例项目',
  projectType: 'registration',
  market: 'US',
  pathway: '510(k) — 待确认',
  reviewerUserId: '6dd33b19-c64f-4bc7-a1db-055a397465cb',
};

test('未知日期保持为空，不生成虚构期限', () => {
  expect(projectCreateSchema.parse(project).targetAt).toBeNull();
  expect(projectCreateSchema.safeParse({ ...project, targetAt: '2026-11-18' }).success).toBe(false);
  expect(projectCreateSchema.safeParse({ ...project, jurisdictionTz: 'Not/A_Zone' }).success).toBe(
    false,
  );
});

test('普通更新不能改写负责人、状态、预算或绕过版本边界', () => {
  for (const extra of [
    { ownerUserId: project.reviewerUserId },
    { status: 'approved' },
    { budgetUsd: 100 },
    { developmentSeedKey: 'seed' },
  ]) {
    expect(projectPatchSchema.safeParse({ name: '正常名称', ...extra }).success).toBe(false);
  }
  expect(projectPatchSchema.safeParse({}).success).toBe(false);
  expect(projectListOptionsSchema.safeParse({ limit: 1000 }).success).toBe(false);
});
