import { z } from 'zod';
import { webArchiveInfoSchema } from './web.js';

const uuidSchema = z.string().uuid('资料或版本编号无效，请重新选择。');
const instantSchema = z.string().datetime({ offset: true });
export const sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, '内容哈希必须是 64 位小写十六进制值。');
export const documentDataLevelSchema = z.enum(['public', 'internal', 'confidential'], {
  error: '必须明确指定资料级别：公开、内部或保密。',
});
export const documentAuthorTypeSchema = z.enum(['ai', 'human', 'external']);
export const documentContentKindSchema = z.enum(['parsed_text', 'original']);
export const documentPageMethodSchema = z.enum(['text', 'ocr', 'docx']);
export const documentLocatorKindSchema = z.enum(['physical_page', 'extraction_unit']);
const wellFormedText = (value: string) => /^[^\uD800-\uDFFF]*$/u.test(value);

const normalizedNameSchema = z
  .string()
  .transform((value) => value.normalize('NFC'))
  .pipe(z.string().min(1).max(255))
  .refine(
    (value) => value.trim().length > 0 && !value.includes('\0'),
    '资料名称不能为空或包含空字符。',
  );
const normalizedPathSchema = z
  .string()
  .transform((value) => value.normalize('NFC'))
  .pipe(z.string().min(1).max(2048))
  .refine(
    (value) => value.trim().length > 0 && !value.includes('\0'),
    '来源路径不能为空或包含空字符。',
  );
const sourceKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, '资料来源编号格式无效。');
const positiveIntegerSchema = z.number().int().positive().safe();
const nonnegativeIntegerSchema = z.number().int().nonnegative().safe();
const sourceMetadataSchema = z
  .record(z.string().max(128), z.json())
  .refine(
    (value) => !Object.hasOwn(value, '_certImport'),
    '导入校验元数据由后端生成，不能自行填写。',
  )
  .refine((value) => JSON.stringify(value).length <= 64_000, '来源元数据过长，请只保留来源说明。');

export const documentPageSourceSchema = z
  .object({
    pageNumber: positiveIntegerSchema,
    // 原文不 trim、折叠空白或做 Unicode 规范化，引用检查必须取得原始逐页内容。
    text: z
      .string()
      .max(1_000_000, '单页文本超过上限，请拆分提取单元。')
      .refine(wellFormedText, '原文包含无效Unicode字符，请重新提取资料，不能替换后继续。'),
    method: documentPageMethodSchema,
    locatorKind: documentLocatorKindSchema,
    ocrScore: z.number().finite().min(0).max(1).nullable().default(null),
    isPlaceholder: z.boolean().default(false),
  })
  .strict();
export type DocumentPageSource = z.infer<typeof documentPageSourceSchema>;

export const documentCreateSchema = z
  .object({
    projectId: uuidSchema,
    sourceKey: sourceKeySchema,
    name: normalizedNameSchema,
    sourcePath: normalizedPathSchema,
    dataLevel: documentDataLevelSchema,
    authorType: documentAuthorTypeSchema,
  })
  .strict();
export type DocumentCreate = z.infer<typeof documentCreateSchema>;

export const documentImportSchema = documentCreateSchema
  .extend({
    sourceSnapshot: sha256Schema,
    originalSha256: sha256Schema.nullable().default(null),
    sourceMetadata: sourceMetadataSchema.default({}),
    pages: z
      .array(documentPageSourceSchema)
      .min(1, '导入快照至少需要一个逐页记录。')
      .max(5000, '单份资料最多导入 5000 页，请拆分导入。'),
  })
  .superRefine((input, context) => {
    const seen = new Set<number>();
    for (const [index, page] of input.pages.entries()) {
      if (seen.has(page.pageNumber))
        context.addIssue({
          code: 'custom',
          path: ['pages', index, 'pageNumber'],
          message: '同一导入版本中的页码不能重复。',
        });
      seen.add(page.pageNumber);
    }
  });
export type DocumentImport = z.infer<typeof documentImportSchema>;

export const documentRecordSchema = z
  .object({
    id: uuidSchema,
    projectId: uuidSchema,
    sourceKey: sourceKeySchema,
    name: normalizedNameSchema,
    sourcePath: normalizedPathSchema,
    ownerUserId: uuidSchema,
    dataLevel: documentDataLevelSchema,
    status: z.enum(['active', 'voided']),
    currentVersion: positiveIntegerSchema,
    version: positiveIntegerSchema,
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .strict();
export type DocumentRecord = z.infer<typeof documentRecordSchema>;

export const documentVersionRecordSchema = z
  .object({
    id: uuidSchema,
    documentId: uuidSchema,
    version: positiveIntegerSchema,
    sourceSnapshot: sha256Schema,
    contentSha256: sha256Schema,
    originalSha256: sha256Schema.nullable(),
    byteSize: nonnegativeIntegerSchema,
    contentKind: documentContentKindSchema,
    mediaType: z.string().min(1).max(255),
    authorType: documentAuthorTypeSchema,
    dataLevel: documentDataLevelSchema,
    importedBy: uuidSchema.nullable(),
    pageCount: nonnegativeIntegerSchema,
    createdAt: instantSchema,
  })
  .strict();
export type DocumentVersionRecord = z.infer<typeof documentVersionRecordSchema>;

export const documentParamsSchema = z.object({ id: uuidSchema }).strict();
export const documentPageParamsSchema = z
  .object({
    id: uuidSchema,
    version: z.coerce.number().int().positive().safe(),
    page: z.coerce.number().int().positive().safe(),
  })
  .strict();
export const documentListOptionsSchema = z
  .object({
    cursor: uuidSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(50),
  })
  .strict();
export const documentVersionListOptionsSchema = z
  .object({
    afterVersion: z.coerce.number().int().nonnegative().safe().default(0),
    limit: z.coerce.number().int().min(1).max(50).default(50),
  })
  .strict();
export const documentPageReadOptionsSchema = z
  .object({
    offset: z.coerce.number().int().nonnegative().safe().default(0),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(12000, '每次最多读取 12000 字符，请按 nextOffset 继续读取。')
      .default(8000),
  })
  .strict();
export type DocumentPageReadOptions = z.infer<typeof documentPageReadOptionsSchema>;
export const documentSearchOptionsSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1, '请提供检索词。')
      .max(200, '检索词最多 200 字符，请缩小检索范围。'),
    offset: z.coerce.number().int().nonnegative().safe().default(0),
    limit: z.coerce.number().int().min(1).max(30).default(10),
  })
  .strict();
export type DocumentSearchOptions = z.infer<typeof documentSearchOptionsSchema>;

export const documentListSchema = z
  .object({
    items: z.array(documentRecordSchema).max(50),
    hasMore: z.boolean(),
    nextCursor: uuidSchema.nullable(),
  })
  .strict()
  .refine(
    (value) => value.hasMore === (value.nextCursor !== null),
    '资料分页状态与继续读取位置不一致。',
  );
export const documentVersionListSchema = z
  .object({
    items: z.array(documentVersionRecordSchema).max(50),
    hasMore: z.boolean(),
    nextAfterVersion: positiveIntegerSchema.nullable(),
  })
  .strict()
  .refine(
    (value) => value.hasMore === (value.nextAfterVersion !== null),
    '版本分页状态与继续读取位置不一致。',
  );

export const documentPageReadSchema = z
  .object({
    documentId: uuidSchema,
    sourceKey: sourceKeySchema,
    name: normalizedNameSchema,
    version: positiveIntegerSchema,
    page: positiveIntegerSchema,
    locatorKind: documentLocatorKindSchema,
    dataLevel: documentDataLevelSchema,
    text: z.string().max(12000).refine(wellFormedText, '分页正文包含不完整字符，请重新读取。'),
    method: documentPageMethodSchema,
    ocrScore: z.number().finite().min(0).max(1).nullable(),
    isPlaceholder: z.literal(false, {
      error: '占位页不能作为资料原文返回，请提供已解析的有效页。',
    }),
    warning: z.string().max(2000).nullable(),
    offset: nonnegativeIntegerSchema,
    totalCharacters: nonnegativeIntegerSchema,
    truncated: z.boolean(),
    nextOffset: nonnegativeIntegerSchema.nullable(),
    contentSha256: sha256Schema,
    originalSha256: sha256Schema.nullable(),
    webArchive: webArchiveInfoSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.truncated
        ? value.nextOffset !== null &&
          value.nextOffset > value.offset &&
          value.nextOffset < value.totalCharacters
        : value.nextOffset === null,
    '资料文本分页状态不一致，请检查继续读取的位置。',
  );
export type DocumentPageRead = z.infer<typeof documentPageReadSchema>;

export const documentSearchItemSchema = z
  .object({
    documentId: uuidSchema,
    sourceKey: sourceKeySchema,
    name: normalizedNameSchema,
    version: positiveIntegerSchema,
    page: positiveIntegerSchema,
    locatorKind: documentLocatorKindSchema,
    dataLevel: documentDataLevelSchema,
    snippetOffset: nonnegativeIntegerSchema,
    snippet: z.string().max(300).refine(wellFormedText, '检索摘要包含不完整字符。'),
    method: documentPageMethodSchema,
    ocrScore: z.number().finite().min(0).max(1).nullable(),
  })
  .strict();
export type DocumentSearchItem = z.infer<typeof documentSearchItemSchema>;
export const documentSearchResultSchema = z
  .object({
    items: z.array(documentSearchItemSchema).max(30),
    hasMore: z.boolean(),
    nextOffset: nonnegativeIntegerSchema.nullable(),
  })
  .strict()
  .refine(
    (value) => value.hasMore === (value.nextOffset !== null),
    '检索分页状态与继续读取位置不一致。',
  );

export const documentVoidSchema = z
  .object({
    expectedVersion: positiveIntegerSchema,
    reason: z.string().trim().min(1, '请说明资料作废原因。').max(2000),
  })
  .strict();
