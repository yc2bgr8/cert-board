import { z } from 'zod';

const sourceId = z.string().regex(/^D\d{3}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
export const t1DocumentsSchema = z
  .array(
    z.object({
      id: sourceId,
      name: z
        .string()
        .transform((value) => value.normalize('NFC'))
        .pipe(z.string().min(1).max(255)),
      path: z
        .string()
        .transform((value) => value.normalize('NFC'))
        .pipe(z.string().min(1).max(2000)),
      source_type: z.string(),
      parent: sourceId.nullable(),
      sha256,
      bytes: z.number().int().nonnegative(),
      ext: z.string().min(1).max(20),
      duplicate_of: sourceId.nullable(),
      pages: z.number().int().positive(),
      chars: z.number().int().nonnegative(),
      status: z.string(),
    }),
  )
  .min(1)
  .max(5000);
export const t1PageSchema = z.object({
  doc: sourceId,
  page: z.number().int().positive(),
  method: z.enum(['docx', 'text', 'ocr']),
  text: z.string().min(1).max(1_000_000),
  ocr_score: z.number().min(0).max(1).optional(),
  ocr_lines: z.number().int().nonnegative().optional(),
});
