import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { isAlias, isNode, parseAllDocuments, visit } from 'yaml';
import { knowledgeDraftMaxBytes, rulePackSeedSchema, type RulePackSeed } from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import type { ToolExecutionContext } from '../tools/registry.js';

export function parseKnowledgeSeedYaml(text: string, label = '规则包') {
  if (Buffer.byteLength(text, 'utf8') > knowledgeDraftMaxBytes)
    throw new Error(`${label}超过 ${knowledgeDraftMaxBytes} 字节。`);
  const [draft, extra] = parseAllDocuments(text, {
    version: '1.2',
    strict: true,
    uniqueKeys: true,
    stringKeys: true,
    prettyErrors: false,
    logLevel: 'silent',
    merge: false,
    resolveKnownTags: false,
  });
  if (!draft || extra || draft.errors.length || draft.warnings.length)
    throw new Error(`${label}需要一份合法 YAML 对象。`);
  visit(draft, (_key, node) => {
    if (isAlias(node) || (isNode(node) && (('anchor' in node && node.anchor) || node.tag)))
      throw new Error(`${label} YAML 不支持别名、锚点和标签。`);
  });
  return draft.toJS({ maxAliasCount: 0 }) as unknown;
}

export function parseRulePackSeed(text: string) {
  const parsed = rulePackSeedSchema.safeParse(parseKnowledgeSeedYaml(text));
  if (!parsed.success) throw new Error('规则包字段、版本或出处无效，请核对 YAML。');
  return parsed.data;
}

export async function seedDevelopmentRulePack(pool: Pool, environment: string, file?: string) {
  const seed = await readFile(
    file ?? new URL('../../../../knowledge/us-fda-m02.yaml', import.meta.url),
    'utf8',
  );
  return publishDevelopmentRulePack(pool, parseRulePackSeed(seed), environment);
}

export async function publishDevelopmentRulePack(
  pool: Pool,
  input: RulePackSeed,
  environment: string,
) {
  if (environment !== 'development' && environment !== 'test')
    throw new AppError(
      403,
      'RULE_PACK_SEED_DEVELOPMENT_ONLY',
      '种子发布仅用于开发验收，正式版本须由注册人员审阅。',
    );
  const data = rulePackSeedSchema.parse(input);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(
      'INSERT INTO rule_pack(code,jurisdiction) VALUES($1,$2) ON CONFLICT(code) DO NOTHING',
      [data.code, data.jurisdiction],
    );
    const {
      rows: [pack],
    } = await db.query<{ id: string; jurisdiction: string }>(
      'SELECT id,jurisdiction FROM rule_pack WHERE code=$1 FOR UPDATE',
      [data.code],
    );
    if (!pack || pack.jurisdiction !== data.jurisdiction)
      throw new AppError(
        409,
        'RULE_PACK_SCOPE_CHANGED',
        '这个规则包已登记在不同市场，请核对包编号。',
      );
    const encoded = JSON.stringify(data);
    const {
      rows: [saved],
    } = await db.query<{ id: string }>(
      `INSERT INTO rule_pack_version(pack_id,version,content,publication) VALUES($1,$2,$3::jsonb,'development')
         ON CONFLICT(pack_id,version) DO NOTHING RETURNING id`,
      [pack.id, data.version, encoded],
    );
    if (saved) {
      await db.query(
        `INSERT INTO audit_log(actor_kind,action,target_type,target_id,after_hash) VALUES('system','knowledge.development_published','rule_pack_version',$1,$2)`,
        [saved.id, createHash('sha256').update(encoded).digest('hex')],
      );
    }
    const {
      rows: [verified],
    } = await db.query<{ id: string; unchanged: boolean }>(
      `SELECT id, content=$3::jsonb AND publication='development' AS unchanged FROM rule_pack_version WHERE pack_id=$1 AND version=$2`,
      [pack.id, data.version, encoded],
    );
    if (!verified?.unchanged)
      throw new AppError(
        409,
        'RULE_PACK_VERSION_IMMUTABLE',
        '版本已有固定内容。修改规则后请提升版本号。',
      );
    await db.query('COMMIT');
    return { versionId: verified.id, created: Boolean(saved) };
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

export async function readRulePack(ctx: ToolExecutionContext, code: string, environment: string) {
  const allowDevelopment = environment === 'development' || environment === 'test';
  await ctx.tx.query(
    `INSERT INTO run_rule_pack(run_id,pack_id,version_id)
       SELECT $1, p.id, v.id FROM rule_pack p JOIN rule_pack_version v ON v.pack_id=p.id
        WHERE p.code=$2 AND ((v.publication='published' AND v.review_id IS NOT NULL)
          OR ($3::boolean AND v.publication='development'))
        ORDER BY (v.publication='published') DESC, split_part(v.version,'.',1)::int DESC,
          split_part(v.version,'.',2)::int DESC, split_part(v.version,'.',3)::int DESC,v.id
        LIMIT 1 ON CONFLICT(run_id,pack_id) DO NOTHING`,
    [ctx.runId, code, allowDevelopment],
  );
  const {
    rows: [row],
  } = await ctx.tx.query<{
    id: string;
    publication: 'development' | 'published';
    review_id: string | null;
    content: unknown;
  }>(
    `SELECT v.id,v.publication,v.review_id,v.content FROM run_rule_pack used JOIN rule_pack p ON p.id=used.pack_id
       JOIN rule_pack_version v ON v.id=used.version_id AND v.pack_id=p.id
       WHERE used.run_id=$1 AND p.code=$2 AND (v.publication='published'
         OR ($3::boolean AND v.publication='development'))`,
    [ctx.runId, code, allowDevelopment],
  );
  if (row?.publication === 'published' && !row.review_id) throw reviewRequired();
  const pack = row
    ? { ...rulePackSeedSchema.parse(row.content), versionId: row.id, publication: row.publication }
    : null;
  return {
    data: { kind: 'rule_pack' as const, pack },
    dataLevel: pack?.dataLevel ?? 'internal',
  };
}

const reviewRequired = () =>
  new AppError(
    422,
    'RULE_PACK_REVIEW_REQUIRED',
    '本次运行固定的历史规则版本缺少审阅。请开启一次新运行，读取已审阅版本。',
  );

export async function refreshRulePackLevel(
  ctx: ToolExecutionContext,
  pack: (RulePackSeed & { versionId: string; publication: 'development' | 'published' }) | null,
  environment: string,
) {
  if (!pack) return 'internal';
  if (pack.publication === 'development') {
    if (!['test', 'development'].includes(environment))
      throw new AppError(403, 'RULE_PACK_DEVELOPMENT_ONLY', '当前环境只可读取正式发布的规则包。');
  } else {
    const approved = await ctx.tx.query(
      "SELECT 1 FROM rule_pack_version WHERE id=$1 AND publication='published' AND review_id IS NOT NULL",
      [pack.versionId],
    );
    if (!approved.rowCount) throw reviewRequired();
  }
  return pack.dataLevel ?? 'internal';
}
