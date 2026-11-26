// 来自 dc_idp/packages/shared/src 的认证评测类型、来源和引用纯函数，限定在回归用例中使用。

export const CHECK_FIELDS = [
  'model',
  'intended_use',
  'pressure_range',
  'rated_voltage',
  'software_version',
  'patient_population',
  'materials',
  'labeling_claims',
] as const;
export type CheckField = (typeof CHECK_FIELDS)[number];

export const OFFICIAL_HOSTS = [
  'www.federalregister.gov',
  'federalregister.gov',
  'www.fda.gov',
  'fda.gov',
  'api.fda.gov',
  'www.accessdata.fda.gov',
  'accessdata.fda.gov',
  'www.canada.ca',
  'canada.ca',
  'health-products.canada.ca',
] as const;

/** 不依赖 URL 全局（shared 不带 DOM / Node 类型）：只接受 https、无用户信息、主机名在白名单内 */
export function isOfficialUrl(url: string): boolean {
  const m = /^https:\/\/([a-z0-9.-]+)(?::(\d{1,5}))?(?:[/?#]|$)/i.exec(url.trim());
  if (!m || /\s/.test(url.trim())) return false;
  if (m[2] && m[2] !== '443') return false;
  return (OFFICIAL_HOSTS as readonly string[]).includes(m[1]!.toLowerCase());
}

export interface ClassificationRow {
  productCode: string;
  deviceName: string;
  deviceClass: string;
  regulationNumber: string;
  panel: string;
  /** 官方记录链接 */
  url: string;
}

export interface PredicateRow {
  kNumber: string;
  deviceName: string;
  applicant: string;
  decisionDate: string | null;
  productCode: string;
  decision: string;
  /** 官方 510(k) 数据库记录 */
  url: string;
  /** 摘要 PDF（官方） */
  summaryUrl: string;
  /** 摘要已下载并入检索库 */
  indexed?: boolean;
}

/** 510(k) 摘要 PDF 的官方地址：K 后两位年份决定目录（K19xxxx → pdf19；2002 年以前没有统一目录，返回 ''） */
export function summaryUrlOf(kNumber: string): string {
  const k = kNumber.toUpperCase();
  if (!/^K\d{6}$/.test(k)) return '';
  const yy = Number(k.slice(1, 3));
  if (yy < 2 || yy > 60) return '';
  return `https://www.accessdata.fda.gov/cdrh_docs/pdf${yy}/${k}.pdf`;
}

export function pmnUrlOf(kNumber: string): string {
  return `https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfpmn/pmn.cfm?ID=${encodeURIComponent(kNumber.toUpperCase())}`;
}

export function classificationUrlOf(productCode: string): string {
  return `https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfPCD/classification.cfm?id=${encodeURIComponent(productCode)}`;
}

/** 引用校验用：折叠空白后比较（PDF 抽出的文字常有换行、多空格） */
export function normalizeQuote(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** quote 是否逐字出现在 text 中（空白折叠后），且长度足够（至少 8 个字符，防止只引一两个词） */
export function quoteFound(text: string, quote: string): boolean {
  const q = normalizeQuote(quote);
  return q.length >= 8 && normalizeQuote(text).includes(q);
}

export type Validation<T> = { ok: true; value: T; notes?: string[] } | { ok: false; reason: string };

export type EvalTouchpoint = 'cx' | 'dx' | 'dr' | 'rg' | 'pd' | 'rp';

export interface EvalCase {
  id: string;
  touchpoint: EvalTouchpoint;
  title: string;
  vars: Record<string, string>;
  ctx: {
    text?: string;
    cx?: Record<string, string>;
    deficiencies?: string[];
    passages?: { text: string }[];
    relevant?: number;
    modelCodes?: string[];
    impact?: string[];
    classification?: ClassificationRow[];
    results?: PredicateRow[];
    productCode?: string;
    facts?: string;
    model?: string;
  };
  expect: { keywords?: string[]; none?: boolean; conclusion?: string };
}
