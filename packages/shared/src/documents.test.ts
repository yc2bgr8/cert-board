import { describe, expect, it } from 'vitest';
import {
  documentCreateSchema,
  documentImportSchema,
  documentListOptionsSchema,
  documentListSchema,
  documentPageReadOptionsSchema,
  documentPageReadSchema,
  documentPageSourceSchema,
  documentSearchOptionsSchema,
  documentSearchResultSchema,
  documentVersionListOptionsSchema,
  documentVoidSchema,
} from './documents.js';

const id = '10000000-0000-4000-8000-000000000001';
const originalText = '  e\u0301 原文\r\n\t K170825  \n';

it('保留完整非BMP字符，拒绝不能无损存为UTF8的孤立代理码元', () => {
  const source = { pageNumber: 1, text: '甲😀𠀀乙', method: 'text', locatorKind: 'physical_page' };
  expect(documentPageSourceSchema.parse(source).text).toBe(source.text);
  expect(documentPageSourceSchema.safeParse({ ...source, text: '甲\ud800乙' }).success).toBe(false);
  expect(documentPageSourceSchema.safeParse({ ...source, text: '\udc00' }).success).toBe(false);
});
const metadata = {
  projectId: id,
  sourceKey: 'D035',
  name: 'e\u0301 文档.pdf',
  sourcePath: '资料/e\u0301 文档.pdf',
  dataLevel: 'internal',
  authorType: 'external',
};
const page = {
  pageNumber: 1,
  text: originalText,
  method: 'text',
  locatorKind: 'physical_page',
  ocrScore: null,
  isPlaceholder: false,
};
const input = { ...metadata, sourceSnapshot: 'a'.repeat(64), pages: [page] };

describe('资料与版本边界', () => {
  it('导入和建立资料必须显式选择数据级别，不能默认为公开或内部', () => {
    const missingLevel = {
      projectId: id,
      sourceKey: 'D035',
      name: '资料',
      sourcePath: '资料.pdf',
      authorType: 'external',
    };
    expect(documentCreateSchema.safeParse(missingLevel).success).toBe(false);
    expect(
      documentImportSchema.safeParse({
        ...missingLevel,
        sourceSnapshot: input.sourceSnapshot,
        pages: [page],
      }).success,
    ).toBe(false);
    expect(documentImportSchema.parse(input).dataLevel).toBe('internal');
    expect(documentImportSchema.parse({ ...input, dataLevel: 'confidential' }).dataLevel).toBe(
      'confidential',
    );
  });

  it('仅规范化名称和路径NFC，逐页原文的Unicode、空格和换行完全保留', () => {
    const parsed = documentImportSchema.parse(input);
    expect(parsed.name).toBe('é 文档.pdf');
    expect(parsed.sourcePath).toBe('资料/é 文档.pdf');
    expect(parsed.sourceKey).toBe('D035');
    expect(parsed.pages[0]?.text).toBe(originalText);
    expect(parsed.pages[0]?.text).not.toBe(originalText.normalize('NFC').trim());
    const canonicalName = 'é'.repeat(200);
    expect(
      documentCreateSchema.parse({ ...metadata, name: canonicalName.normalize('NFD') }).name,
    ).toBe(canonicalName);
  });

  it('计算后的内容哈希和大小不能由导入调用方伪造，保留元数据键不能覆盖', () => {
    expect(
      documentImportSchema.safeParse({ ...input, contentSha256: 'b'.repeat(64), byteSize: 42 })
        .success,
    ).toBe(false);
    expect(
      documentImportSchema.safeParse({
        ...input,
        sourceMetadata: { _certImport: { fingerprint: 'forged' } },
      }).success,
    ).toBe(false);
    expect(documentImportSchema.parse(input).originalSha256).toBeNull();
    expect(documentImportSchema.parse(input).sourceMetadata).toEqual({});
    expect(documentImportSchema.safeParse({ ...input, originalSha256: 'not-a-hash' }).success).toBe(
      false,
    );
  });

  it('拒绝重复页码、无效OCR分数与过长原文，但可保存占位页的真实状态', () => {
    expect(documentImportSchema.safeParse({ ...input, pages: [page, page] }).success).toBe(false);
    expect(documentImportSchema.safeParse({ ...input, pages: [] }).success).toBe(false);
    for (const ocrScore of [-0.1, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(documentPageSourceSchema.safeParse({ ...page, method: 'ocr', ocrScore }).success).toBe(
        false,
      );
    }
    expect(
      documentPageSourceSchema.safeParse({ ...page, text: 'x'.repeat(1_000_001) }).success,
    ).toBe(false);
    expect(
      documentPageSourceSchema.parse({ ...page, text: '', isPlaceholder: true }).isPlaceholder,
    ).toBe(true);
  });

  it('资料和版本列表最多50项，正文每次最多12000字符，检索最多30项', () => {
    expect(documentListOptionsSchema.parse({}).limit).toBe(50);
    expect(documentVersionListOptionsSchema.parse({})).toEqual({ afterVersion: 0, limit: 50 });
    expect(documentPageReadOptionsSchema.parse({})).toEqual({ offset: 0, limit: 8000 });
    expect(documentSearchOptionsSchema.parse({ query: ' K号 ' })).toEqual({
      query: 'K号',
      offset: 0,
      limit: 10,
    });
    expect(documentListOptionsSchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(documentVersionListOptionsSchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(documentPageReadOptionsSchema.safeParse({ limit: 12001 }).success).toBe(false);
    expect(documentPageReadOptionsSchema.safeParse({ offset: -1 }).success).toBe(false);
    expect(documentSearchOptionsSchema.safeParse({ query: 'x', limit: 31 }).success).toBe(false);
    expect(documentSearchOptionsSchema.safeParse({ query: 'x'.repeat(201) }).success).toBe(false);
    expect(
      documentListSchema.safeParse({ items: [], hasMore: true, nextCursor: null }).success,
    ).toBe(false);
    expect(
      documentSearchResultSchema.safeParse({ items: [], hasMore: true, nextOffset: null }).success,
    ).toBe(false);
  });

  it('读取结果包含来源、导入版本与定位方式；禁止占位正文和错误续读游标', () => {
    const result = {
      documentId: id,
      sourceKey: 'D035',
      name: '资料.doc',
      version: 1,
      page: 1,
      locatorKind: 'extraction_unit',
      dataLevel: 'internal',
      text: originalText,
      method: 'docx',
      ocrScore: null,
      isPlaceholder: false,
      warning: '提取单元，不代表原始文件物理页。',
      offset: 0,
      totalCharacters: 100,
      truncated: true,
      nextOffset: originalText.length,
      contentSha256: 'a'.repeat(64),
      originalSha256: null,
    };
    expect(documentPageReadSchema.parse(result).text).toBe(originalText);
    expect(documentPageReadSchema.safeParse({ ...result, isPlaceholder: true }).success).toBe(
      false,
    );
    expect(documentPageReadSchema.safeParse({ ...result, nextOffset: 0 }).success).toBe(false);
    expect(documentPageReadSchema.safeParse({ ...result, nextOffset: null }).success).toBe(false);
    expect(documentPageReadSchema.safeParse({ ...result, text: 'x'.repeat(12001) }).success).toBe(
      false,
    );
  });

  it('作废要求版本与非空原因，不允许把作废入口用于删除或清除作废状态', () => {
    expect(documentVoidSchema.parse({ expectedVersion: 1, reason: '  重复资料  ' })).toEqual({
      expectedVersion: 1,
      reason: '重复资料',
    });
    expect(documentVoidSchema.safeParse({ expectedVersion: 0, reason: '重复' }).success).toBe(
      false,
    );
    expect(documentVoidSchema.safeParse({ expectedVersion: 1, reason: ' ' }).success).toBe(false);
    expect(
      documentVoidSchema.safeParse({ expectedVersion: 1, reason: '重复', voided: false }).success,
    ).toBe(false);
    expect(
      documentVoidSchema.safeParse({ expectedVersion: 1, reason: '重复', delete: true }).success,
    ).toBe(false);
  });
});
