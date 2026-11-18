import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterEach, beforeEach, expect, test } from 'vitest';
import type { StructuredSubmission, DataLevel } from '@cert-board/shared';
import { createIntegrationContext } from '../test-support/context.js';
import { readT1Fixture } from '../documents/t1-seed.js';
import { checkSubmission, refreshCheckDataLevel } from './service.js';

let context: Awaited<ReturnType<typeof createIntegrationContext>>;
let caller: { runId: string; userId: string };
let workspaceVersion: string;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

async function addSource(
  options: {
    db?: Pick<Pool, 'query'>;
    projectId?: string;
    ownerUserId?: string;
    documentId?: string;
    text?: string;
    page?: number;
    version?: number;
    method?: 'text' | 'docx' | 'ocr';
    placeholder?: boolean;
    dataLevel?: DataLevel;
  } = {},
) {
  const db = options.db ?? context.pool;
  const documentId = options.documentId ?? randomUUID();
  const version = options.version ?? 1,
    page = options.page ?? 1;
  const text = options.text ?? '示例编号 K123456，写法尚待注册人员确认。';
  if (!options.documentId)
    await db.query(
      'INSERT INTO document(id,project_id,source_key,name,source_path,owner_user_id) VALUES($1,$2,$3,$4,$5,$6)',
      [
        documentId,
        options.projectId ?? context.projectId,
        `TEST-${documentId}`,
        '检查测试资料',
        'test.txt',
        options.ownerUserId ?? caller.userId,
      ],
    );
  const versionId = (
    await db.query<{ id: string }>(
      `INSERT INTO document_version(document_id,version_no,source_snapshot,content_sha256,byte_size,media_type,content_kind,data_level,author_type)
     VALUES($1,$2,$3,$4,$5,'application/json','parsed_text',$6,'external') RETURNING id`,
      [
        documentId,
        version,
        digest(`${documentId}:${version}`),
        digest(text),
        Buffer.byteLength(text),
        options.dataLevel ?? 'internal',
      ],
    )
  ).rows[0]!.id;
  const method = options.method ?? 'text';
  await db.query(
    'INSERT INTO document_page(version_id,page_number,text,method,locator_kind,ocr_score,is_placeholder) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [
      versionId,
      page,
      text,
      method,
      method === 'docx' ? 'extraction_unit' : 'physical_page',
      method === 'ocr' ? 0.812 : null,
      options.placeholder ?? false,
    ],
  );
  return { documentId, version, page, quote: text };
}
function submission(citation: Awaited<ReturnType<typeof addSource>>): StructuredSubmission {
  return {
    skill: { id: 'R09', version: '0.1.0' },
    workspaceVersion,
    conclusion: '示例写法需核对，法规判断待确认。',
    claims: [
      {
        id: 'C1',
        object: '测试资料',
        field: '对比器械编号写法',
        value: 'K123456',
        unit: null,
        sources: [citation],
        status: 'checked',
      },
    ],
    evidence: [citation],
    decisions: [],
    missing: [],
    uncertain: ['编号真实性未回查'],
    nextStep: '请注册人员核对原件中的编号。',
  };
}
async function anotherProject() {
  return (
    await context.pool.query<{ id: string }>(
      `INSERT INTO cert_project(name,project_type,market,pathway,owner_user_id,reviewer_user_id) VALUES('隔离项目','registration','US','510k',$1,$2) RETURNING id`,
      [caller.userId, context.userId('MEMBER_B')],
    )
  ).rows[0]!.id;
}
beforeEach(async () => {
  context = await createIntegrationContext();
  const run = await context.run();
  caller = { runId: run.runId, userId: run.userId };
  const workspace = (
    await context.pool.query<{ id: string }>(
      'INSERT INTO workspace(project_id) VALUES($1) RETURNING id',
      [context.projectId],
    )
  ).rows[0]!.id;
  workspaceVersion = (
    await context.pool.query<{ id: string }>(
      "INSERT INTO workspace_version(workspace_id,project_id,number,author_type,summary,data_level) VALUES($1,$2,1,'system','检查fixture','internal') RETURNING id",
      [workspace, context.projectId],
    )
  ).rows[0]!.id;
  await context.pool.query('UPDATE workspace SET current_version_id=$1 WHERE id=$2', [
    workspaceVersion,
    workspace,
  ]);
});

test('仅出现在判断中的资料也逐字核对并加入定位，错误落在固定判断路径', async () => {
  const base = await addSource();
  const judgment = await addSource({ text: '判断依据：仍缺少原件，暂不选择正确编号。' });
  const data = submission(base);
  data.decisions = [
    {
      id: 'D1',
      subject: '差异处理',
      choice: '保留差异',
      alternatives: ['按笔误统一'],
      reason: '先核对原件。',
      sources: [judgment],
      risk: 'high',
    },
  ];
  const report = await checkSubmission(context.pool, caller, data);
  expect(report.passed).toBe(true);
  expect(report.citations.map((item) => item.documentId).sort()).toEqual(
    [base.documentId, judgment.documentId].sort(),
  );
  data.decisions[0]!.sources[0]!.quote = '判断依据：已有全部原件，确定正确编号。';
  const bad = await checkSubmission(context.pool, caller, data);
  expect(bad.checks[0]!.issues).toContainEqual({
    code: 'quote_mismatch',
    path: 'decisions[0].sources[0]',
  });
  expect(bad.passed).toBe(false);
});

test.each(['other_project', 'placeholder', 'voided'] as const)(
  '判断独有的%s来源不能绕过引用边界',
  async (kind) => {
    const base = await addSource();
    const extra = await addSource({
      ...(kind === 'other_project' ? { projectId: await anotherProject() } : {}),
      placeholder: kind === 'placeholder',
    });
    if (kind === 'voided')
      await context.pool.query(
        "UPDATE document SET voided=true,void_reason='测试作废' WHERE id=$1",
        [extra.documentId],
      );
    const data = submission(base);
    data.decisions = [
      {
        id: 'D1',
        subject: '处理',
        choice: '暂缓',
        alternatives: [],
        reason: '等待依据',
        sources: [extra],
        risk: 'low',
      },
    ];
    const report = await checkSubmission(context.pool, caller, data);
    expect(report.passed).toBe(false);
    expect(report.checks[0]!.issues).toContainEqual({
      code: kind === 'placeholder' ? 'placeholder_source' : 'source_unavailable',
      path: 'decisions[0].sources[0]',
    });
  },
);

test('判断独有来源升密或作废会进入最高级别及重放刷新校验', async () => {
  const base = await addSource();
  const extra = await addSource({ text: '判断采用的独有依据。' });
  const data = submission(base);
  data.decisions = [
    {
      id: 'D1',
      subject: '处理',
      choice: '暂缓',
      alternatives: [],
      reason: '等待核对',
      sources: [extra],
      risk: 'low',
    },
  ];
  const first = await checkSubmission(context.pool, caller, data);
  expect(first.dataLevel).toBe('internal');
  await addSource({
    documentId: extra.documentId,
    version: 2,
    text: '后续保密记录',
    dataLevel: 'confidential',
  });
  expect(await refreshCheckDataLevel(context.pool, caller, first.citations)).toBe('confidential');
  expect((await checkSubmission(context.pool, caller, data)).dataLevel).toBe('confidential');
  await context.pool.query("UPDATE document SET voided=true,void_reason='测试作废' WHERE id=$1", [
    extra.documentId,
  ]);
  await expect(refreshCheckDataLevel(context.pool, caller, first.citations)).rejects.toMatchObject({
    code: 'CHECK_SOURCE_UNAVAILABLE',
  });
});

test('新提交缺decisions或判断没有来源时V3失败，不能按旧存储格式通过', async () => {
  const base = submission(await addSource());
  const { decisions: _decisions, ...legacy } = base;
  for (const data of [
    legacy,
    {
      ...base,
      decisions: [
        {
          id: 'D1',
          subject: '处理',
          choice: '暂缓',
          alternatives: [],
          reason: '待核对',
          sources: [],
          risk: 'high',
        },
      ],
    },
  ]) {
    const result = await checkSubmission(context.pool, caller, data);
    expect(result.checks).toEqual([
      { code: 'V1', status: 'not_run', issues: [] },
      { code: 'V3', status: 'failed', issues: [{ code: 'schema_invalid', path: 'submission' }] },
    ]);
  }
});

test('最大合法问题组合完整返回80项，不截断或因报告上限而抛异常', async () => {
  const ref = await addSource();
  const data = submission(ref);
  data.claims = Array.from({ length: 20 }, (_, index) => ({
    id: `C${index}`,
    object: '资料',
    field: '数量',
    value: 3,
    unit: null,
    sources: [],
    status: 'unverified',
  }));
  data.evidence = Array.from({ length: 40 }, () => ({ ...ref, quote: '不存在的内容' }));
  const report = await checkSubmission(context.pool, caller, data);
  expect(report.passed).toBe(false);
  expect(report.checks[0]!.issues).toHaveLength(60);
  expect(report.checks[1]!.issues).toHaveLength(20);
  expect(report.notRun).toContain('V7');
});
afterEach(async () => {
  if (context) await context.close();
});

test('T1真实逐页摘录通过，一字改动拒绝，输出只有定位而无正文', async () => {
  const fixture = await readT1Fixture();
  const page = fixture.pages.find((item) => /K\d{6}/.test(item.text))!;
  expect(Boolean(page)).toBe(true);
  const ref = await addSource({ text: page.text, method: page.method, page: page.page });
  const match = /K\d{6}/.exec(page.text)!;
  const quote = page.text.slice(Math.max(0, match.index - 20), match.index + match[0].length + 20);
  const data = submission({ ...ref, quote });
  const report = await checkSubmission(context.pool, caller, data);
  expect(report.passed).toBe(true);
  expect(report.notRun).toEqual(['V2', 'V4', 'V5', 'V6', 'V7', 'V8']);
  expect(report.citations[0]?.locatorKind).toBe(
    page.method === 'docx' ? 'extraction_unit' : 'physical_page',
  );
  expect(Object.hasOwn(report.citations[0]!, 'quote')).toBe(false);
  expect(Object.hasOwn(report.citations[0]!, 'text')).toBe(false);
  data.claims[0]!.sources[0]!.quote = quote.replace(match[0], `${match[0].slice(0, -1)}X`);
  const changed = await checkSubmission(context.pool, caller, data);
  expect(changed.passed).toBe(false);
  expect(changed.checks[0]!.issues).toContainEqual({
    code: 'quote_mismatch',
    path: 'claims[0].sources[0]',
  });
});

test('只匹配指定不可变版本与单页，不借用当前版本或另一页', async () => {
  const old = await addSource({ text: '旧版编号 K123456' });
  await addSource({ documentId: old.documentId, version: 2, text: '新版编号 K654321' });
  expect((await checkSubmission(context.pool, caller, submission(old))).passed).toBe(true);
  const wrongVersion = await checkSubmission(
    context.pool,
    caller,
    submission({ ...old, version: 2 }),
  );
  expect(wrongVersion.checks[0]!.issues[0]?.code).toBe('quote_mismatch');
  const wrongPage = await checkSubmission(context.pool, caller, submission({ ...old, page: 2 }));
  expect(wrongPage.checks[0]!.issues[0]?.code).toBe('source_unavailable');
});

test('空白统一但大小写和Unicode正文不改，DOCX返回提取单元', async () => {
  const ref = await addSource({ text: 'Alpha\r\n\tBeta café K123456', method: 'docx' });
  const valid = await checkSubmission(
    context.pool,
    caller,
    submission({ ...ref, quote: 'Alpha Beta café' }),
  );
  expect(valid.passed).toBe(true);
  expect(valid.citations[0]?.locatorKind).toBe('extraction_unit');
  for (const quote of ['alpha Beta café', 'Alpha Beta cafe\u0301']) {
    const report = await checkSubmission(context.pool, caller, submission({ ...ref, quote }));
    expect(report.passed).toBe(false);
    expect(report.checks[0]!.issues[0]?.code).toBe('quote_mismatch');
  }
});

test.each(['placeholder', 'voided'] as const)('%s资料不能作为引用', async (kind) => {
  const ref = await addSource({ placeholder: kind === 'placeholder', method: 'ocr' });
  if (kind === 'voided')
    await context.pool.query("UPDATE document SET voided=true,void_reason='测试作废' WHERE id=$1", [
      ref.documentId,
    ]);
  const report = await checkSubmission(context.pool, caller, submission(ref));
  expect(report.passed).toBe(false);
  expect(report.citations).toHaveLength(0);
  expect(report.checks[0]!.issues[0]?.code).toBe(
    kind === 'placeholder' ? 'placeholder_source' : 'source_unavailable',
  );
});

test('草稿引用与未知来源字段使V3失败，错误不回显字段名或内容', async () => {
  const ref = await addSource();
  const input = submission(ref);
  const malformed = {
    ...input,
    claims: [
      {
        ...input.claims[0],
        sources: [{ workspacePath: '交付/草稿.md', PRIVATE_INPUT: 'PRIVATE_BODY' }],
      },
    ],
  };
  const report = await checkSubmission(context.pool, caller, malformed);
  expect(report.passed).toBe(false);
  expect(report.checks).toEqual([
    { code: 'V1', status: 'not_run', issues: [] },
    { code: 'V3', status: 'failed', issues: [{ code: 'schema_invalid', path: 'submission' }] },
  ]);
  expect(JSON.stringify(report).includes('PRIVATE_')).toBe(false);
});

test('即使用户全局有权限也不允许引用其他项目的资料', async () => {
  const ref = await addSource({ projectId: await anotherProject() });
  const report = await checkSubmission(context.pool, caller, submission(ref));
  expect(report.passed).toBe(false);
  expect(report.citations).toHaveLength(0);
  expect(report.checks[0]!.issues[0]?.code).toBe('source_unavailable');
});

test('运行用户不可冒用，禁用或结束后旧检查上下文拒绝', async () => {
  const data = submission(await addSource());
  await expect(
    checkSubmission(context.pool, { ...caller, userId: context.userId('MEMBER_B') }, data),
  ).rejects.toMatchObject({ code: 'CHECK_CONTEXT_UNAVAILABLE' });
  await context.pool.query("UPDATE app_user SET status='disabled' WHERE id=$1", [caller.userId]);
  await expect(checkSubmission(context.pool, caller, data)).rejects.toMatchObject({
    code: 'CHECK_CONTEXT_UNAVAILABLE',
  });
  await context.pool.query("UPDATE app_user SET status='active' WHERE id=$1", [caller.userId]);
  await context.pool.query("UPDATE run SET status='completed' WHERE id=$1", [caller.runId]);
  await expect(checkSubmission(context.pool, caller, data)).rejects.toMatchObject({
    code: 'CHECK_CONTEXT_UNAVAILABLE',
  });
});

test('活动成员可核对本项目其他成员提供的资料，资料负责人不再限制读取', async () => {
  const ref = await addSource({ ownerUserId: context.userId('MEMBER_B') });
  const report = await checkSubmission(context.pool, caller, submission(ref));
  expect(report.passed).toBe(true);
  expect(report.citations[0]?.documentId).toBe(ref.documentId);
});

test('引用旧页也继承所有历史版本最高级别，重放刷新不降级且拒已作废来源', async () => {
  const ref = await addSource({ method: 'ocr' });
  const first = await checkSubmission(context.pool, caller, submission(ref));
  expect(first.dataLevel).toBe('internal');
  expect(first.citations[0]?.ocrScore).toBe(0.812);
  await addSource({ documentId: ref.documentId, version: 2, dataLevel: 'confidential' });
  expect(await refreshCheckDataLevel(context.pool, caller, first.citations)).toBe('confidential');
  expect((await checkSubmission(context.pool, caller, submission(ref))).dataLevel).toBe(
    'confidential',
  );
  await context.pool.query("UPDATE document SET voided=true,void_reason='测试作废' WHERE id=$1", [
    ref.documentId,
  ]);
  await expect(refreshCheckDataLevel(context.pool, caller, first.citations)).rejects.toMatchObject({
    code: 'CHECK_SOURCE_UNAVAILABLE',
  });
});

test('数值或非空单位明确unsupported_quantity，V7保持未运行', async () => {
  const ref = await addSource();
  for (const quantity of [
    { value: 5, unit: null },
    { value: '5', unit: 'mm' },
  ]) {
    const data = submission(ref);
    Object.assign(data.claims[0]!, quantity);
    const report = await checkSubmission(context.pool, caller, data);
    expect(report.passed).toBe(false);
    expect(report.notRun).toContain('V7');
    expect(report.checks[1]!.issues).toContainEqual({
      code: 'unsupported_quantity',
      path: 'claims[0]',
    });
  }
});

test('没有来源或evidence不能让空检查冒充通过', async () => {
  const data = submission(await addSource());
  data.claims[0]!.sources = [];
  data.evidence = [];
  const report = await checkSubmission(context.pool, caller, data);
  expect(report.passed).toBe(false);
  expect(report.checks[0]!.issues).toContainEqual({
    code: 'missing_evidence',
    path: 'claims[0].sources',
  });
  expect(report.checks[0]!.issues).toContainEqual({ code: 'missing_evidence', path: 'evidence' });
});

test('不存在或跨项目工作区版本不能通过结构关联校验', async () => {
  const data = submission(await addSource());
  const projectId = await anotherProject();
  const workspaceId = (
    await context.pool.query<{ id: string }>(
      'INSERT INTO workspace(project_id) VALUES($1) RETURNING id',
      [projectId],
    )
  ).rows[0]!.id;
  const foreignVersion = (
    await context.pool.query<{ id: string }>(
      "INSERT INTO workspace_version(workspace_id,project_id,number,author_type,summary,data_level) VALUES($1,$2,1,'system','隔离版本','internal') RETURNING id",
      [workspaceId, projectId],
    )
  ).rows[0]!.id;
  for (const version of [randomUUID(), foreignVersion]) {
    data.workspaceVersion = version;
    const report = await checkSubmission(context.pool, caller, data);
    expect(report.passed).toBe(false);
    expect(report.checks[1]!.issues).toContainEqual({
      code: 'workspace_version_unavailable',
      path: 'workspaceVersion',
    });
  }
});

test('尚未推进当前指针的工作区版本不可检查，发布后当前及历史版本均可用', async () => {
  const data = submission(await addSource());
  const workspace = (
    await context.pool.query<{ id: string }>('SELECT id FROM workspace WHERE project_id=$1', [
      context.projectId,
    ])
  ).rows[0]!.id;
  const futureVersion = (
    await context.pool.query<{ id: string }>(
      "INSERT INTO workspace_version(workspace_id,project_id,number,parent_version_id,author_type,summary,data_level) VALUES($1,$2,2,$3,'system','待发布版本','internal') RETURNING id",
      [workspace, context.projectId, workspaceVersion],
    )
  ).rows[0]!.id;
  const future = { ...data, workspaceVersion: futureVersion };
  const report = await checkSubmission(context.pool, caller, future);
  expect(report.passed).toBe(false);
  expect(report.checks[0]!.status).toBe('not_run');
  expect(report.checks[1]!.issues).toContainEqual({
    code: 'workspace_version_unavailable',
    path: 'workspaceVersion',
  });
  await context.pool.query('UPDATE workspace SET current_version_id=$1 WHERE id=$2', [
    futureVersion,
    workspace,
  ]);
  expect((await checkSubmission(context.pool, caller, future)).passed).toBe(true);
  expect((await checkSubmission(context.pool, caller, data)).passed).toBe(true);
});

test('直接复用调用方事务，未提交资料可检查而回滚后不可见', async () => {
  const tx = await context.pool.connect();
  let data: StructuredSubmission | undefined;
  try {
    await tx.query('BEGIN');
    data = submission(await addSource({ db: tx }));
    expect((await checkSubmission(tx, caller, data)).passed).toBe(true);
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
  expect((await checkSubmission(context.pool, caller, data)).passed).toBe(false);
});

test('合法输入的最多80条问题完整返回且不超过工具输出上限', async () => {
  const ref = await addSource();
  const data = submission(ref);
  const first = data.claims[0]!;
  data.claims = Array.from({ length: 20 }, (_, index) => ({
    ...first,
    id: `C${index + 1}`,
    value: 1,
    sources: [],
  }));
  data.evidence = Array.from({ length: 40 }, () => ({ ...ref, quote: '这段文字未在资料出现' }));
  const report = await checkSubmission(context.pool, caller, data);
  expect(report.passed).toBe(false);
  expect(report.checks.reduce((count, check) => count + check.issues.length, 0)).toBe(80);
  expect(JSON.stringify(report).length).toBeLessThanOrEqual(32000);
});
