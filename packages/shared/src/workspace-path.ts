import { z } from 'zod';

export const workspacePathSchema = z
  .string()
  .transform((value) => value.normalize('NFC'))
  .pipe(
    z
      .string()
      .min(1)
      .max(512)
      .refine((value) => {
        if (
          value.startsWith('/') ||
          value.includes('\\') ||
          value.includes(':') ||
          /[<>"|?*]/.test(value) ||
          !/^[^\uD800-\uDFFF]*$/u.test(value)
        )
          return false;
        if ([...value].some((char) => char.codePointAt(0)! < 32 || char.codePointAt(0) === 127))
          return false;
        return value
          .split('/')
          .every(
            (segment) =>
              segment !== '' &&
              segment !== '.' &&
              segment !== '..' &&
              !/[. ]$/.test(segment) &&
              !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(segment),
          );
      }, '工作区路径必须是规范的相对路径；不能包含绝对路径、上级目录或控制字符。'),
  );

export const workspaceConflictDetailsSchema = z
  .object({
    changedPaths: z.array(workspacePathSchema).max(20),
    truncated: z.boolean(),
  })
  .strict();
export type WorkspaceConflictDetails = z.infer<typeof workspaceConflictDetailsSchema>;
