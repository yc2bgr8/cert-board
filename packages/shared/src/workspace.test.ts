import { describe, expect, it } from 'vitest';
import {
  conversationCreateSchema,
  workspaceFileListOptionsSchema,
  workspaceFileListSchema,
  workspaceReadFileSchema,
  workspaceReadOptionsSchema,
  workspaceRecordSchema,
  workspaceRebaseSchema,
  workspaceRestoreSchema,
  workspaceVersionListOptionsSchema,
  workspaceVersionRecordSchema,
  workspaceWriteFileSchema,
} from './workspace.js';

const id = '10000000-0000-4000-8000-000000000001';
const instant = '2026-11-17T15:00:00Z';

describe('工作区输入输出边界', () => {
  it('重基必须确认工作副本和当前版本，逐路径确认有界且不能强制覆盖', () => {
    const input = { expectedDraftVersion: 2, expectedCurrentVersionId: id };
    expect(workspaceRebaseSchema.parse(input).resolutions).toEqual([]);
    expect(workspaceRebaseSchema.safeParse({ ...input, force: true }).success).toBe(false);
    expect(workspaceRebaseSchema.safeParse({ expectedCurrentVersionId: id }).success).toBe(false);
    const resolution = {
      path: '草稿/e\u0301.md',
      expectedCurrentSha256: 'a'.repeat(64),
      expectedDraftSha256: null,
    };
    expect(
      workspaceRebaseSchema.parse({ ...input, resolutions: [resolution] }).resolutions[0]?.path,
    ).toBe('草稿/é.md');
    expect(
      workspaceRebaseSchema.safeParse({
        ...input,
        resolutions: [resolution, { ...resolution, path: '草稿/é.md' }],
      }).success,
    ).toBe(false);
    expect(
      workspaceRebaseSchema.safeParse({
        ...input,
        resolutions: Array.from({ length: 101 }, (_value, index) => ({
          ...resolution,
          path: `草稿/${index}.md`,
        })),
      }).success,
    ).toBe(false);
  });
  it('工作副本写入必须声明期望哈希，不能自报所属用户或降低数据级别', () => {
    const input = { path: '草稿/e\u0301.md', content: '  原文\r\n😀\n', expectedSha256: null };
    expect(workspaceWriteFileSchema.parse(input)).toEqual({ ...input, path: '草稿/é.md' });
    expect(workspaceWriteFileSchema.safeParse({ path: '草稿/a.md', content: '内容' }).success).toBe(
      false,
    );
    expect(workspaceWriteFileSchema.safeParse({ ...input, dataLevel: 'public' }).success).toBe(
      false,
    );
    expect(workspaceWriteFileSchema.safeParse({ ...input, ownerUserId: id }).success).toBe(false);
    expect(
      workspaceWriteFileSchema.safeParse({ ...input, expectedSha256: 'incorrect' }).success,
    ).toBe(false);
  });

  it('文本内容拒绝损坏Unicode与空字符，安全路径规范由统一模式执行', () => {
    for (const content of ['\ud800', '\udfff', 'x\0y']) {
      expect(
        workspaceWriteFileSchema.safeParse({ path: '草稿/a.md', content, expectedSha256: null })
          .success,
      ).toBe(false);
    }
    for (const path of ['../outside.md', 'C:/outside.md', '/outside.md', '草稿//a.md']) {
      expect(
        workspaceWriteFileSchema.safeParse({ path, content: '正文', expectedSha256: null }).success,
      ).toBe(false);
    }
  });

  it('初始化事务中没有当前版本的工作区不能作为公开读取结果返回', () => {
    const record = {
      id,
      projectId: id,
      currentVersionId: id,
      dataLevel: 'internal',
      version: 1,
      createdAt: instant,
      updatedAt: instant,
    };
    expect(workspaceRecordSchema.safeParse(record).success).toBe(true);
    expect(workspaceRecordSchema.safeParse({ ...record, currentVersionId: null }).success).toBe(
      false,
    );
    expect(workspaceRecordSchema.safeParse({ ...record, dataLevel: 'public' }).success).toBe(false);
  });

  it('版本必须有合法作者归属，恢复指向版本而不接受覆盖指令', () => {
    const record = {
      id,
      workspaceId: id,
      projectId: id,
      number: 1,
      parentVersionId: null,
      authorUserId: null,
      authorType: 'system',
      summary: '开发种子',
      dataLevel: 'internal',
      createdAt: instant,
    };
    expect(workspaceVersionRecordSchema.safeParse(record).success).toBe(true);
    expect(workspaceVersionRecordSchema.safeParse({ ...record, authorType: 'ai' }).success).toBe(
      false,
    );
    expect(
      workspaceVersionRecordSchema.safeParse({ ...record, authorType: 'ai', authorUserId: id })
        .success,
    ).toBe(true);
    expect(
      workspaceRestoreSchema.safeParse({ targetVersionId: id, summary: '作为新版本恢复' }).success,
    ).toBe(true);
    expect(
      workspaceRestoreSchema.safeParse({ targetVersionId: id, summary: '覆盖', overwrite: true })
        .success,
    ).toBe(false);
  });

  it('项目外对话不能关联目标，也不能通过创建输入指定等级或其他用户', () => {
    expect(
      conversationCreateSchema.safeParse({ projectId: null, title: '项目外对话' }).success,
    ).toBe(true);
    expect(
      conversationCreateSchema.safeParse({ projectId: null, goalId: id, title: '项目外对话' })
        .success,
    ).toBe(false);
    expect(
      conversationCreateSchema.safeParse({ projectId: id, title: '对话', userId: id }).success,
    ).toBe(false);
    expect(
      conversationCreateSchema.safeParse({ projectId: id, title: '对话', maxDataLevel: 'public' })
        .success,
    ).toBe(false);
  });

  it('读取上限与UTF16游标一致，返回文本不含被切断的Unicode字符', () => {
    const record = {
      path: '草稿/图文.md',
      sha256: 'a'.repeat(64),
      byteSize: 24000,
      dataLevel: 'internal',
      mediaType: 'text/markdown',
      workspaceId: id,
      versionId: id,
      draftId: null,
      text: '😀'.repeat(6000),
      offset: 0,
      totalCharacters: 12000,
      truncated: false,
      nextOffset: null,
    };
    expect(workspaceReadFileSchema.safeParse(record).success).toBe(true);
    expect(workspaceReadFileSchema.safeParse({ ...record, text: '😀'.repeat(6001) }).success).toBe(
      false,
    );
    expect(workspaceReadFileSchema.safeParse({ ...record, text: '\ud800' }).success).toBe(false);
    expect(
      workspaceReadFileSchema.safeParse({ ...record, truncated: true, nextOffset: 0 }).success,
    ).toBe(false);
    expect(workspaceReadOptionsSchema.parse({})).toEqual({ offset: 0, limit: 8000 });
    expect(workspaceReadOptionsSchema.safeParse({ limit: 12001 }).success).toBe(false);
  });

  it('版本及文件列表有上限，截断必须给出下一页位置', () => {
    expect(workspaceVersionListOptionsSchema.parse({})).toEqual({ afterNumber: 0, limit: 20 });
    expect(workspaceVersionListOptionsSchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(workspaceFileListOptionsSchema.parse({})).toEqual({ limit: 50 });
    expect(workspaceFileListOptionsSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(
      workspaceFileListSchema.safeParse({ items: [], hasMore: true, nextCursor: null }).success,
    ).toBe(false);
  });
});
