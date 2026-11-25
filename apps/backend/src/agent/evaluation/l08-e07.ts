import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { readT1Fixture } from '../../documents/t1-seed.js';

const xfa = new URL('../../../../../fixtures/l08/t1_out/estar_datasets.xml', import.meta.url);
const cleaningReport = 'Reprocessing Validation Test.pdf';
const unknownModel = 'L08-ZZ';
const catalogue = ['L08-BP', 'L08-PT', 'L08-BT', 'L08-TP', 'L08-TB', 'L08-PB'];
const shelfLife = { original: 'Shelf life: 2 years', injected: 'Shelf life: 3 years' };

const defectKinds = ['missing_cleaning_report', 'unknown_model', 'shelf_life_conflict'] as const;
export const e07AddressSchema = z.strictObject({
  documentKey: z.string().regex(/^D\d{3}$/u),
  location: z.union([z.number().int().positive(), z.literal('xfa_datasets')]),
});
const evidence = e07AddressSchema.extend({ quote: z.string().max(4000).refine((text) => !!text.trim()) });
const response = z.strictObject({
  findings: z.array(z.strictObject({
    kind: z.enum(defectKinds),
    evidence: z.array(evidence).min(1).max(6),
  })).max(defectKinds.length),
});

type Address = z.infer<typeof e07AddressSchema>;
export type E07Finding = z.infer<typeof response>['findings'][number];

function replaceOnce(text: string, before: string, after: string) {
  if (text.split(before).length !== 2) throw new Error('E07 植入位置与录制快照不符。');
  return text.replace(before, after);
}

export async function prepareL08E07() {
  const [fixture, references] = await Promise.all([readT1Fixture(), readFile(xfa, 'utf8')]);
  const report = fixture.documents.find(({ id }) => id === 'D023');
  const refStart = references.indexOf(cleaningReport);
  if (report?.name !== cleaningReport || report.parent !== 'D014' || refStart < 0)
    throw new Error('E07 清洁验证报告或 eSTAR 引用与录制快照不符。');
  if (fixture.pages.some(({ text }) => text.includes(unknownModel)) || references.includes(unknownModel))
    throw new Error('E07 的合成型号已存在于原资料。');
  const removedIds = new Set(fixture.documents.filter(({ id, sha256 }) =>
    id === report.id || sha256 === report.sha256,
  ).map(({ id }) => id));
  const documents = fixture.documents.filter(({ id }) => !removedIds.has(id)).map(({ id, name, parent }) => ({
    documentKey: id, name, attachmentOf: parent,
  }));
  if (documents.some(({ name }) => name === cleaningReport))
    throw new Error('E07 发现未确认的同名清洁验证报告。');

  const pages = fixture.pages.filter(({ doc }) => !removedIds.has(doc)).map(({ doc, page, text }) => ({
    documentKey: doc,
    location: page,
    text: doc === 'D015' && page === 2
      ? replaceOnce(text, 'L08-BP', unknownModel)
      : doc === 'D027' && page === 3
        ? replaceOnce(text, shelfLife.original, shelfLife.injected)
        : text,
  }));
  const attachmentReference = references.slice(Math.max(0, refStart - 120), refStart + cleaningReport.length + 120);
  const corpus = { sourceSnapshot: fixture.snapshot, documents, pages, attachmentReference };
  const modelPage = e07SourceText(corpus, { documentKey: 'D015', location: 2 });
  const cataloguePage = e07SourceText(corpus, { documentKey: 'D021', location: 1 });
  const changedShelfPage = e07SourceText(corpus, { documentKey: 'D027', location: 3 });
  const originalShelfPage = e07SourceText(corpus, { documentKey: 'D044', location: 3 });
  if (!modelPage?.includes(unknownModel) ||
      !catalogue.every((model) => cataloguePage?.includes(model)) ||
      !changedShelfPage?.includes(shelfLife.injected) || !originalShelfPage?.includes(shelfLife.original))
    throw new Error('E07 的植入页或对照页不完整。');

  return corpus;
}

type Corpus = {
  sourceSnapshot: string;
  documents: { documentKey: string; name: string; attachmentOf: string | null }[];
  pages: { documentKey: string; location: number; text: string }[];
  attachmentReference: string;
};

export function e07SourceText(corpus: Corpus, { documentKey, location }: Address) {
  if (documentKey === 'D014' && location === 'xfa_datasets') return corpus.attachmentReference;
  return corpus.pages.find((page) => page.documentKey === documentKey && page.location === location)?.text;
}

export function gradeL08E07(corpus: Corpus, candidate: unknown) {
  const parsed = response.safeParse(candidate);
  if (!parsed.success) return { status: 'invalid_response' as const };
  const reported = new Map(parsed.data.findings.map((finding) => [finding.kind, finding.evidence]));
  if (reported.size !== parsed.data.findings.length) return { status: 'invalid_response' as const };
  const invalidEvidence = parsed.data.findings.some(({ evidence: refs }) => refs.some((ref) =>
    !e07SourceText(corpus, ref)?.includes(ref.quote),
  ));
  if (invalidEvidence) return { status: 'invalid_evidence' as const };
  const supports = (kind: E07Finding['kind'], key: string, location: Address['location'], terms: string[]) =>
    reported.get(kind)?.some((ref) => ref.documentKey === key && ref.location === location &&
      terms.every((term) => ref.quote.includes(term)),
    ) === true;
  const scores = {
    missing_cleaning_report: !corpus.documents.some(({ name }) => name === cleaningReport) &&
      supports('missing_cleaning_report', 'D014', 'xfa_datasets', [cleaningReport]),
    unknown_model: supports('unknown_model', 'D015', 2, [unknownModel]) &&
      supports('unknown_model', 'D021', 1, catalogue),
    shelf_life_conflict: supports('shelf_life_conflict', 'D027', 3, [shelfLife.injected]) &&
      supports('shelf_life_conflict', 'D044', 3, [shelfLife.original]),
  };
  const missed = defectKinds.filter((kind) => !scores[kind]);
  return { status: 'scored' as const, passed: missed.length === 0, matched: defectKinds.length - missed.length, missed };
}
