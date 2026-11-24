import { readFile } from 'node:fs/promises';
import { isAlias, isNode, parseAllDocuments, visit } from 'yaml';
import type { Pool, PoolClient } from 'pg';
import {
  agentCodeSchema,
  agentDefinitionMetadataSchema,
  agentDefinitionSchema,
  skillLoadInputSchema,
  skillLoadResultSchema,
  type AgentCode,
  type AgentDefinition,
  type LoadedAgentSkill,
  type PermissionMode,
} from '@cert-board/shared';
import { parseReviewPolicy } from '../reviews/policy.js';
import { AppError } from '../api/errors.js';
import { readActiveSkill, registeredSkillIds } from '../skills/service.js';

const legacyHeading = '\n\n当前可加载的开发技能（正文须用skill_load取得）：\n';

const definitions = {
  registration: new URL('../../../../agents/registration/0.1.0.md', import.meta.url),
  maintenance: new URL('../../../../agents/maintenance/0.1.0.md', import.meta.url),
} as const;
const skillFiles = {
  R09: {
    agentCode: 'registration',
    file: new URL('../../../../skills/R09-一致性检查/SKILL.md', import.meta.url),
  },
  M02: {
    agentCode: 'maintenance',
    file: new URL('../../../../skills/M02-年度注册资料核查/SKILL.md', import.meta.url),
  },
} as const;
const unavailable = () =>
  new AppError(
    403,
    'AGENT_DEFINITION_UNAVAILABLE',
    '当前Agent定义仍为开发草稿或配置无效，请核对已审阅版本；不能用于生产运行。',
  );
const skillUnavailable = () =>
  new AppError(
    404,
    'SKILL_UNAVAILABLE',
    '当前Agent没有可加载的这个技能版本，请按系统提示中的技能索引选择；不要传文件路径。',
  );
export function permitsDraftAgentExecution(environment: string) {
  return process.env.NODE_ENV !== 'production' && ['development', 'test'].includes(environment);
}
function development(environment: string) {
  if (!permitsDraftAgentExecution(environment)) throw unavailable();
}
function frontmatter(source: string) {
  if (Buffer.byteLength(source, 'utf8') > 32000) throw unavailable();
  const found = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!found) throw unavailable();
  return { header: found[1]!, body: source.slice(found[0].length).trim() };
}
export function parseAgentDefinition(
  source: string,
  expectedCode: AgentCode,
  environment = process.env.NODE_ENV ?? 'production',
): AgentDefinition {
  try {
    development(environment);
    const parsed = frontmatter(source);
    if (!parsed.body) throw unavailable();
    const documents = parseAllDocuments(parsed.header, {
      version: '1.2',
      strict: true,
      uniqueKeys: true,
      stringKeys: true,
      prettyErrors: false,
      logLevel: 'silent',
      merge: false,
      resolveKnownTags: false,
    });
    const document = documents[0];
    if (documents.length !== 1 || !document || document.errors.length || document.warnings.length)
      throw unavailable();
    visit(document, (_key, node) => {
      if (isAlias(node) || (isNode(node) && (('anchor' in node && node.anchor) || node.tag)))
        throw unavailable();
    });
    const metadata = agentDefinitionMetadataSchema.parse(document.toJS({ maxAliasCount: 0 }));
    if (metadata.code !== expectedCode || metadata.version !== '0.1.0') throw unavailable();
    for (const entry of metadata.skills) {
      const spec = skillFiles[entry.id as keyof typeof skillFiles];
      if (!spec || spec.agentCode !== expectedCode || entry.version !== '0.1.0')
        throw unavailable();
    }
    return agentDefinitionSchema.parse({
      ...metadata,
      systemPrompt: `${parsed.body}${legacyHeading}${metadata.skills.map((skill) => `- ${skill.id}@${skill.version} ${skill.name}：${skill.summary}`).join('\n')}`,
    });
  } catch {
    throw unavailable();
  }
}
export async function loadAgentDefinition(
  codeInput: unknown,
  environment = process.env.NODE_ENV ?? 'production',
): Promise<AgentDefinition> {
  try {
    development(environment);
    const code = agentCodeSchema.parse(codeInput);
    return parseAgentDefinition(await readFile(definitions[code], 'utf8'), code, environment);
  } catch {
    throw unavailable();
  }
}
export async function loadAgentSkill(
  codeInput: unknown,
  input: unknown,
  environment = process.env.NODE_ENV ?? 'production',
): Promise<LoadedAgentSkill> {
  try {
    development(environment);
    const code = agentCodeSchema.parse(codeInput);
    const request = skillLoadInputSchema.parse(input);
    const definition = await loadAgentDefinition(code, environment);
    const entry = definition.skills.find(
      (skill) => skill.id === request.id && (!request.version || skill.version === request.version),
    );
    const spec = skillFiles[request.id as keyof typeof skillFiles];
    if (!entry || !spec || spec.agentCode !== code) throw skillUnavailable();
    const source = await readFile(spec.file, 'utf8');
    const policy = parseReviewPolicy(source, environment);
    if (policy.skill.id !== entry.id || policy.skill.version !== entry.version)
      throw skillUnavailable();
    return skillLoadResultSchema.parse({
      skill: { ...entry, agentCode: code },
      body: frontmatter(source).body,
      attachments: [],
      publication: 'draft',
      developmentOnly: true,
      reviewPolicy: policy,
    });
  } catch {
    throw skillUnavailable();
  }
}

export async function loadManagedAgentDefinition(
  pool: Pool,
  code: AgentCode,
  mode: PermissionMode,
) {
  const definition = await loadAgentDefinition(code);
  const managed = await registeredSkillIds(pool, code);
  if (!managed.length) return definition;
  let skills = [...definition.skills];
  for (const id of managed) {
    const selected = await readActiveSkill(pool, code, { id }, mode);
    if (selected === undefined) continue;
    skills = skills.filter((entry) => entry.id !== id);
    if (selected) {
      const { id: key, version, name, summary } = selected.skill;
      skills.push({ id: key, version, name, summary });
    }
  }
  const body = definition.systemPrompt.split(legacyHeading)[0]!;
  const index = skills
    .map(({ id, version, name, summary }) => `- ${id}@${version} ${name} ${summary}`)
    .join('\n');
  return {
    ...definition,
    skills,
    systemPrompt: `${body}\n\n当前可加载的技能。用 skill_load 读取正文。\n${index || '当前没有生效技能。'}`,
  };
}

export async function loadSelectedSkill(
  db: Pick<PoolClient, 'query'>,
  code: AgentCode,
  input: unknown,
  mode: PermissionMode,
) {
  const selected = await readActiveSkill(db, code, input, mode);
  if (selected === null) throw skillUnavailable();
  return selected ?? loadAgentSkill(code, input);
}
