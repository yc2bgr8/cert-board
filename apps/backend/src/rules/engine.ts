import { diffLines } from 'diff';
import type { RuleId } from '@cert-board/shared';
import { compareIdentifiers } from '../checks/identifiers.js';
import { AppError } from '../api/errors.js';

export type { RuleId } from '@cert-board/shared';

export const ruleDefinitions = {
  R0: { version: '1.0.0', category: '同名 PDF', output: '不同版本及变化行数', maxLineEdits: 2000 },
  R1: {
    version: '1.0.0',
    category: '含申报编号的资料',
    output: '近似编号及出现次数',
    maxDistinct: 256,
    maxEdits: 2,
  },
  R2: { version: '1.0.0', category: '申请表、封面及联系人字段', output: '申请人或联系人差异' },
  R3: {
    version: '1.0.0',
    category: '使用说明、验证报告及试验条件',
    output: '带单位的参数差异',
    temperatureContext: 60,
  },
  R4: { version: '1.0.0', category: '产品描述与材料评价', output: '型号配置差异' },
  R5: {
    version: '1.0.0',
    category: 'eSTAR 正文及同包附件',
    output: '未匹配的引用项',
    nameMatchRatio: 0.6,
  },
  R6: { version: '1.0.0', category: '实验室报告', output: '结论栏待解释', minimumRows: 3 },
  R7: { version: '1.0.0', category: '生物学评价与使用说明', output: '时长术语待人工判断' },
} as const satisfies Record<
  RuleId,
  { version: string; category: string; output: string } & Record<string, string | number>
>;

export interface RuleDocument {
  key: string;
  name: string;
  pages: { page: number; text: string }[];
  duplicate?: boolean;
  isEstar?: boolean;
  attachmentOf?: string;
  attachmentNames?: string[];
  referencesText?: string;
}

type Reference = { key: string; page: number; xfa?: true };
type CountedValue = { value: string; count?: number };
export interface RuleFinding {
  ruleId: RuleId;
  version: string;
  title: string;
  status: 'candidate' | 'notice' | 'human_review';
  values: CountedValue[];
  references: Reference[];
  detailsTruncated: boolean;
}

type Occurrence = { page: number; text: string; key: string };
type ValueMap = Map<string, Reference[]>;
const reportCode = /R[TS]-W\d{2}-\d{4}-[A-Z]{3}/u;
const stem = (name: string) =>
  name
    .normalize('NFC')
    .replace(/\.[^.]+$/u, '')
    .trim();
const lower = (value: string) => value.normalize('NFC').toLowerCase();

function add<T>(map: Map<string, T[]>, key: string, value: T) {
  let list = map.get(key);
  if (!list) {
    list = [];
    map.set(key, list);
  }
  list.push(value);
}

function track(groups: Map<string, ValueMap>, group: string, value: string, page: Occurrence) {
  let values = groups.get(group);
  if (!values) {
    values = new Map();
    groups.set(group, values);
  }
  add(values, value, { key: page.key, page: page.page });
}

function report(
  ruleId: RuleId,
  title: string,
  values: CountedValue[],
  refs: Reference[],
  status: RuleFinding['status'] = 'candidate',
): RuleFinding {
  const unique = new Map(refs.map((ref) => [`${ref.key}:${ref.page}`, ref]));
  return {
    ruleId,
    version: ruleDefinitions[ruleId].version,
    title: title.slice(0, 320),
    status,
    values: values.slice(0, 16).map((entry) => ({
      ...entry,
      value: entry.value.slice(0, 255),
    })),
    references: [...unique.values()].slice(0, 16),
    detailsTruncated:
      values.length > 16 || unique.size > 16 || values.some(({ value }) => value.length > 255),
  };
}

const counted = (values: ValueMap) =>
  [...values].map(([value, refs]) => ({ value, count: refs.length }));
const firstRefs = (values: ValueMap) =>
  [...values.values()].flatMap((pages) => {
    const perDocument = new Map<string, Reference>();
    for (const reference of pages)
      if (!perDocument.has(reference.key)) perDocument.set(reference.key, reference);
    return [...perDocument.values()].slice(0, 3);
  });
const crossesDocuments = (values: ValueMap) =>
  new Set([...values.values()].flatMap((references) => references.map(({ key }) => key))).size > 1;

const normalizedPage = (text: string) =>
  text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
const normalizedLines = (doc: RuleDocument) =>
  doc.pages
    .map(({ text }) => normalizedPage(text))
    .filter(Boolean)
    .join('\n');

function sameNames(documents: RuleDocument[]) {
  const groups = new Map<string, RuleDocument[]>();
  for (const doc of documents) {
    if (doc.isEstar || !doc.pages.some(({ text }) => text.trim()) || !/\.pdf$/iu.test(doc.name))
      continue;
    const name = doc.name.match(reportCode)?.[0] ?? lower(stem(doc.name)).replace(/\s+/gu, ' ');
    add(groups, name, doc);
  }
  const findings: RuleFinding[] = [];
  for (const [first, ...otherVersions] of groups.values()) {
    if (!first || !otherVersions.length) continue;
    const before = normalizedLines(first);
    if (!before) continue;
    const changes: CountedValue[] = [];
    const references: Reference[] = [];
    let exceeded = false;
    for (const [position, second] of otherVersions.entries()) {
      const after = normalizedLines(second);
      if (!after || before === after) continue;
      const difference = diffLines(before, after, {
        maxEditLength: ruleDefinitions.R0.maxLineEdits,
      });
      const changed = difference?.reduce(
        (total, part) => total + (part.added || part.removed ? (part.count ?? 0) : 0),
        0,
      );
      if (changed === 0) continue;
      const firstChange = first.pages.findIndex(
        ({ text }, index) =>
          normalizedPage(text) !== normalizedPage(second.pages[index]?.text ?? ''),
      );
      const index = firstChange === -1 ? first.pages.length : firstChange;
      if (changed === undefined) exceeded = true;
      changes.push(
        changed === undefined
          ? { value: `第 ${position + 2} 份的变化行数超限，请读取返回位置。` }
          : { value: `第 ${position + 2} 份相对首份的变化行数`, count: changed },
      );
      references.push(
        ...[first, second].map((doc) => ({
          key: doc.key,
          page: (doc.pages[index] ?? doc.pages.at(-1))!.page,
        })),
      );
    }
    if (!changes.length) continue;
    const finding = report('R0', `同名文件两个版本内容不同：${first.name}`, changes, references);
    findings.push({ ...finding, detailsTruncated: finding.detailsTruncated || exceeded });
  }
  return findings;
}

function identifierVariants(pages: Occurrence[]) {
  const seen: ValueMap = new Map();
  for (const page of pages)
    for (const match of page.text.matchAll(/(?<![A-Z0-9])K\d{6}(?![A-Z0-9]|\.[A-Z0-9])/giu))
      add(seen, match[0].toUpperCase(), { key: page.key, page: page.page });
  const keys = [...seen.keys()].sort();
  if (keys.length > ruleDefinitions.R1.maxDistinct)
    throw new AppError(
      422,
      'RULES_IDENTIFIER_LIMIT',
      '近似编号超过检查上限，请选择与待核申报相关的资料版本。',
    );
  const output: RuleFinding[] = [];
  for (const [index, first] of keys.entries()) {
    const { candidates } = compareIdentifiers('k_number', first, keys.slice(index + 1));
    for (const { identifier, edits } of candidates) {
      if (edits > ruleDefinitions.R1.maxEdits) continue;
      const a = seen.get(first)!;
      const b = seen.get(identifier)!;
      output.push(
        report(
          'R1',
          `510(k)编号疑似笔误：${first} / ${identifier}`,
          [
            { value: first, count: a.length },
            { value: identifier, count: b.length },
          ],
          [...a.slice(0, 4), ...b.slice(0, 4)],
        ),
      );
    }
  }
  return output;
}

function contacts(pages: Occurrence[]) {
  const groups = new Map<string, ValueMap>();
  for (const page of pages) {
    for (const contact of page.text.matchAll(
      /(?:Submitter|Official contact person|Contact person)\s*[:：]\s*(?:Mr\.|Ms\.|Mrs\.|Dr\.)?\s*([^\r\n\t|]{1,120})/giu,
    )) {
      const name = contact[1]!
        .split(/\s+(?:Title|Phone|Fax|Email|Address|Applicant)\s*[:：]|[;（(]/iu, 1)[0]!
        .trim()
        .replace(/\s+/gu, ' ');
      if (name && /\p{L}/u.test(name)) track(groups, '申报联系人', name, page);
    }
    for (const applicant of page.text.matchAll(
      /^[ \t]*(?:Applicant|申请人)\s*[:：][ \t]+([^\r\n]{3,120})/gimu,
    )) {
      const name = applicant[1]!.trim();
      if (name) track(groups, '申请人', name, page);
    }
  }
  return [...groups].flatMap(([label, values]) =>
    values.size > 1 && crossesDocuments(values)
      ? [report('R2', `${label}在不同文件中不一致`, counted(values), firstRefs(values))]
      : [],
  );
}

const temperature =
  /([-−]?\d{1,3})\s*(?:°\s*C|℃)?\s*(?:-|—|–|~|～|to|至)\s*([-−]?\d{1,3})\s*(?:°\s*C|℃|degrees?\s+Celsius|\s*\n?\s*C\b)/giu;
const temperatureLabels = [
  ['冲洗水温', /rins|冲洗/iu],
  ['浸泡水温', /soak|cleanser|浸泡/iu],
  ['储存温度', /storage|store|贮存|储存/iu],
] as const;
const scaled = (value: string | undefined, factor: number) =>
  Number((Number(value) * factor).toFixed(4));
const namedParameters = [
  [
    '浸泡时间',
    /(?:soaking time|浸泡时间)\s*[:：]\s*(\d{1,6}(?:\.\d{1,4})?)\s*(minutes?|min|hours?|h|分钟|小时)(?![a-z])/giu,
    (match: RegExpMatchArray) =>
      `${scaled(match[1], /^(?:hours?|h|小时)$/iu.test(match[2]!) ? 60 : 1)} 分钟`,
  ],
  [
    '产品尺寸',
    /(?:product dimensions|产品尺寸)\s*[:：]\s*(\d{1,6}(?:\.\d{1,4})?)\s*[x×]\s*(\d{1,6}(?:\.\d{1,4})?)\s*(mm|cm)(?![a-z])/giu,
    (match: RegExpMatchArray) => {
      const scale = lower(match[3]!) === 'cm' ? 10 : 1;
      return `${scaled(match[1], scale)} × ${scaled(match[2], scale)} mm`;
    },
  ],
  [
    '使用期限',
    /(?:service life|使用期限)\s*[:：]\s*(\d{1,6})\s*(months?|years?|个月|年)(?![a-z])/giu,
    (match: RegExpMatchArray) =>
      `${scaled(match[1], /^(?:years?|年)$/iu.test(match[2]!) ? 12 : 1)} 个月`,
  ],
] as const;

function parameters(pages: Occurrence[]) {
  const groups = new Map<string, ValueMap>();
  for (const page of pages) {
    for (const match of page.text.matchAll(temperature)) {
      const context = page.text.slice(
        Math.max(0, match.index - ruleDefinitions.R3.temperatureContext),
        match.index,
      );
      const matched = temperatureLabels.find(([, pattern]) => pattern.test(context));
      if (matched) {
        const range = `${match[1]}-${match[2]}℃`.replace(/−/gu, '-');
        track(groups, matched[0], range, page);
      }
    }
    for (const [label, pattern, value] of namedParameters)
      for (const match of page.text.matchAll(pattern)) track(groups, label, value(match), page);
  }
  return [...groups].flatMap(([label, values]) =>
    values.size > 1 && crossesDocuments(values)
      ? [report('R3', `${label}在不同文件中取值不同`, counted(values), firstRefs(values))]
      : [],
  );
}

const modelToken = '[A-Z][A-Z0-9]{1,11}-[A-Z]{2}';
const colorToken = '(?:Blue|Purple|Transparent|White|Black|Pink|Green|Clear)';
const rowTokens = (prefix: string, token: string) =>
  new RegExp(`${prefix}\\s+((?:${token}\\s+){0,29}${token})\\b`, 'u');
const modelRow = rowTokens('Model', modelToken);
const upperRow = rowTokens('upper tray', colorToken);
const lowerRow = rowTokens('lower\\s*tray', colorToken);
function modelConfiguration(pages: Occurrence[]) {
  const groups = new Map<string, ValueMap>();
  for (const page of pages) {
    const models = modelRow.exec(page.text)?.[1]?.split(/\s+/u);
    const upper = upperRow.exec(page.text)?.[1]?.split(/\s+/u);
    const lowerColors = lowerRow.exec(page.text)?.[1]?.split(/\s+/u);
    if (models && upper?.length === models.length && lowerColors?.length === models.length) {
      for (const [index, model] of models.entries()) {
        track(groups, `${model} 上托颜色`, lower(upper[index]!), page);
        track(groups, `${model} 下托颜色`, lower(lowerColors[index]!), page);
      }
    }
    const segments = [...page.text.matchAll(new RegExp(`(${modelToken})\\s*\\n\\(L, S\\)`, 'gu'))];
    for (const [index, marker] of segments.entries()) {
      const segment = page.text.slice(marker.index + marker[0].length, segments[index + 1]?.index);
      const parts = [...segment.matchAll(/\b(Upper|Lower)\b/gu)];
      const fields = [
        ['颜色', /Color\s*Additive\s+(\w+)\s+masterbatch/gu],
        ['材料', /\bMaterial[ \t]*[:：][ \t]*([A-Za-z][A-Za-z0-9 ()-]{1,60})(?=$|\r?\n)/gmu],
      ] as const;
      for (const [field, pattern] of fields) {
        for (const match of segment.matchAll(pattern)) {
          const part = parts.findLast(({ index: offset }) => offset < match.index);
          if (part)
            track(
              groups,
              `${marker[1]} ${part[1] === 'Upper' ? '上托' : '下托'}${field}`,
              lower(match[1]!),
              page,
            );
        }
      }
    }
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .flatMap(([label, values]) =>
      values.size > 1 && [...values.keys()].some((value) => value !== 'transparent')
        ? [report('R4', `${label}说法不一致`, counted(values), firstRefs(values))]
        : [],
    );
}

const entities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
function decodedEntities(text: string) {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/giu, (raw, entity: string) => {
    if (!entity.startsWith('#')) return entities[entity] ?? raw;
    const hex = entity[1]?.toLowerCase() === 'x';
    const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
      ? String.fromCodePoint(code)
      : raw;
  });
}

const inlineMarkup = new Set(['b', 'em', 'i', 'span', 'strong', 'sub', 'sup', 'u']);
function xfaFieldText(raw: string) {
  return decodedEntities(raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, '$1'))
    .replace(/<!--[\s\S]*?-->/gu, '\n')
    .replace(/<\/?([A-Za-z][\w:.-]*)\b[^<>]*>/gu, (_markup, tag: string) =>
      inlineMarkup.has(tag.split(':').at(-1)!.toLowerCase()) ? '' : '\n',
    );
}

function attachmentReferences(documents: RuleDocument[]) {
  const findings: RuleFinding[] = [];
  for (const source of documents) {
    if (!source.isEstar || !source.referencesText) continue;
    const attached = (
      source.attachmentNames ??
      documents
        .filter((document) => document.attachmentOf === source.key)
        .map((document) => document.name)
    ).map(lower);
    const stems = attached.map(stem).filter(Boolean);
    const refs = new Set<string>();
    for (const match of xfaFieldText(source.referencesText).matchAll(
      /please[ \t]+see[ \t]*:?[ \t]*([^\r\n]+)/giu,
    )) {
      for (const part of match[1]!.split(/,|;|、|\band\b/giu)) {
        const name = part.replace(/^[ .:]+|[ .:]+$/gu, '');
        if (name.length >= 3 && name.length <= 80 && /[A-Za-z]/u.test(name)) refs.add(name);
      }
    }
    const missing = [...refs].sort().filter((reference) => {
      const value = lower(reference);
      if (stems.some((candidate) => value.includes(candidate))) return false;
      const words = value.match(/[a-z0-9]{3,}/gu) ?? [];
      return (
        words.length > 0 &&
        !attached.some(
          (attachment) =>
            words.filter((word) => attachment.includes(word)).length / words.length >=
            ruleDefinitions.R5.nameMatchRatio,
        )
      );
    });
    if (missing.length)
      findings.push(
        report(
          'R5',
          'eSTAR正文引用的文件未出现在eSTAR附件清单中',
          missing.map((value) => ({ value })),
          [{ key: source.key, page: source.pages[0]?.page ?? 1, xfa: true }],
        ),
      );
  }
  return findings;
}

function conclusionSlashes(pages: Occurrence[], names: Map<string, string>) {
  return pages.flatMap((page) => {
    if (!/Result\s+Conclusion/u.test(page.text)) return [];
    const rows = [...page.text.matchAll(/^\s*\d+\s+.+\s\/\s*$/gmu)];
    return rows.length >= ruleDefinitions.R6.minimumRows
      ? [
          report(
            'R6',
            `${names.get(page.key)} 结果汇总表结论栏为“/”`,
            [{ value: '结论栏写为 / 的行', count: rows.length }],
            [{ key: page.key, page: page.page }],
            'notice',
          ),
        ]
      : [];
  });
}

function duration(pages: Occurrence[]) {
  const contact: Reference[] = [],
    life: Reference[] = [];
  for (const { key, page, text } of pages) {
    const flattened = text.replace(/\n/gu, ' ');
    if (/>\s*24\s*h\s*to\s*30\s*days/iu.test(flattened)) contact.push({ key, page });
    if (
      /(?:use\s*life|service\s*life|usage\s*period|使用期限|使用寿命)[^.]{0,40}?\d+\s*[-–~—]\s*\d+\s*months/iu.test(
        flattened,
      )
    )
      life.push({ key, page });
  }
  return contact.length && life.length
    ? [
        report(
          'R7',
          '接触时长类别与使用期限同时出现，需要人解释累计接触评估',
          [
            { value: '接触时长类别', count: contact.length },
            { value: '使用期限', count: life.length },
          ],
          [...contact.slice(0, 3), ...life.slice(0, 3)],
          'human_review',
        ),
      ]
    : [];
}

export function runConsistencyRules(documents: RuleDocument[], selected: ReadonlySet<RuleId>) {
  const unique = documents.filter((doc) => !doc.duplicate);
  const pages = unique.flatMap((doc) => doc.pages.map((page) => ({ ...page, key: doc.key })));
  const names = new Map(unique.map((doc) => [doc.key, doc.name]));
  const checks: Record<RuleId, () => RuleFinding[]> = {
    R0: () => sameNames(unique),
    R1: () => identifierVariants(pages),
    R2: () => contacts(pages),
    R3: () => parameters(pages),
    R4: () => modelConfiguration(pages),
    R5: () => attachmentReferences(documents),
    R6: () => conclusionSlashes(pages, names),
    R7: () => duration(pages),
  };
  return [...selected].flatMap((id) => checks[id]());
}
