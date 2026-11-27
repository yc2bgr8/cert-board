import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  knowledgeDraftMaxBytes,
  type KnowledgeReviewCreateInput,
  type KnowledgeReviewDecisionInput,
} from '@cert-board/shared';
import { api, createRequestKey, errorMessage } from './api.js';

const kindNames = { rule_pack: '规则包', template: '模板' };
const statusNames = { pending: '待审阅', published: '已发布', rejected: '已退回' };
const utf8 = new TextEncoder();
const maxReleaseVersionBytes = '9999.9999.9999'.length;
const fitsWithReleaseVersion = (draft: string) =>
  utf8.encode(draft).length + maxReleaseVersionBytes <= knowledgeDraftMaxBytes;
const categories = {
  classification: '分类',
  pathway: '申报路径',
  evidence: '证据',
  filing: '申报',
  maintenance: '维护',
  change: '变更',
};

function retryKey(attempts: Map<string, string>, fingerprint: string) {
  const prior = attempts.get(fingerprint);
  if (prior) return prior;
  const key = createRequestKey();
  const oldest = attempts.keys().next().value;
  if (attempts.size >= 24 && oldest !== undefined) attempts.delete(oldest);
  attempts.set(fingerprint, key);
  return key;
}

export function KnowledgeReviews({
  userId,
  management,
  focusId = null,
}: {
  userId: string;
  management: boolean;
  focusId?: string | null;
}) {
  const [open, setOpen] = useState(Boolean(focusId));
  const [page, setPage] = useState<(string | null)[]>([null]);
  const [selection, setSelection] = useState(focusId ?? '');
  const [kind, setKind] = useState<KnowledgeReviewCreateInput['kind']>('rule_pack');
  const [formOpen, setFormOpen] = useState(false);
  const [yaml, setYaml] = useState('');
  const [copySource, setCopySource] = useState<{
    id: string;
    title: string;
    version: string;
  } | null>(null);
  const [copyVersion, setCopyVersion] = useState('');
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState('');
  const stageAttempts = useRef(new Map<string, string>());
  const decisionAttempts = useRef(new Map<string, string>());
  const card = useRef<HTMLElement>(null);
  const client = useQueryClient();
  const listKey = ['live', 'knowledge-reviews', userId];
  const after = page.at(-1) ?? null;
  const list = useQuery({
    queryKey: [...listKey, 'page', after],
    queryFn: ({ signal }) => api.knowledgeReviews(after, signal),
    enabled: open,
    retry: false,
  });
  const pageItems = list.data?.items ?? [];
  const selectedId = selection || pageItems[0]?.id;
  const detail = useQuery({
    queryKey: [...listKey, 'detail', selectedId],
    queryFn: ({ signal }) => api.knowledgeReview(selectedId!, signal),
    enabled: open && Boolean(selectedId),
    retry: false,
  });
  const stage = useMutation({
    mutationFn: ({ input }: { input: KnowledgeReviewCreateInput; fingerprint: string }) =>
      api.stageKnowledgeReview(input),
    onSuccess: async (created, { fingerprint }) => {
      stageAttempts.current.delete(fingerprint);
      setYaml('');
      setCopySource(null);
      setCopyVersion('');
      setReason('');
      setPage([null]);
      setSelection(created.id);
      setFormOpen(false);
      setNotice('草稿已提交审阅。');
      await client.invalidateQueries({ queryKey: listKey });
    },
  });
  const decide = useMutation({
    mutationFn: ({
      id,
      command,
    }: {
      id: string;
      command: KnowledgeReviewDecisionInput;
      fingerprint: string;
    }) => api.decideKnowledgeReview(id, command),
    onSuccess: (_result, { fingerprint }) => {
      decisionAttempts.current.delete(fingerprint);
      setReason('');
    },
    onSettled: () => client.invalidateQueries({ queryKey: listKey }),
  });
  const selected = detail.data;
  const options =
    selected && !pageItems.some(({ id }) => id === selected.id)
      ? [selected, ...pageItems]
      : pageItems;
  const readyFocus = focusId !== null && selected?.id === focusId;
  useEffect(() => {
    if (!readyFocus) return;
    card.current?.scrollIntoView?.({ block: 'start' });
    card.current?.focus({ preventScroll: true });
  }, [readyFocus]);
  const busy = stage.isPending || decide.isPending;
  const draftTooLarge = utf8.encode(yaml).length > knowledgeDraftMaxBytes;
  const draftIncomplete = copySource ? !copyVersion.trim() : !yaml.trim() || draftTooLarge;
  const next = list.data?.nextAfterId;
  const move = (newPage: (string | null)[]) => {
    setPage(newPage);
    setSelection('');
    setReason('');
    setNotice('');
    decide.reset();
  };
  function submitDecision(action: 'publish' | 'reject') {
    if (!selected) return;
    setNotice('');
    const fingerprint = JSON.stringify([
      selected.id,
      selected.contentSha256,
      action,
      action === 'reject' ? reason.trim() : '',
    ]);
    const identity = {
      contentSha256: selected.contentSha256,
      requestKey: retryKey(decisionAttempts.current, fingerprint),
    };
    decide.mutate({
      id: selected.id,
      command: action === 'reject' ? { action, reason, ...identity } : { action, ...identity },
      fingerprint,
    });
  }

  return (
    <section id="knowledge-reviews" aria-label="规则包与模板" className="live-page-card">
      <header className="live-page-card-head">
        <h2>规则包与模板</h2>
        <button
          type="button"
          className="live-text-button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? '收起审核列表' : '查看审核列表'}
        </button>
      </header>
      {open && (
        <div className="live-page-message">
          {list.isPending && <p role="status">正在读取知识审核卡…</p>}
          {(list.isError || detail.isError) && (
            <p role="alert" className="live-error">
              {errorMessage(list.error ?? detail.error)}
            </p>
          )}
          {list.data && !selectedId && <p>暂无规则包或模板审核卡。</p>}
          {(selectedId || page.length > 1 || next) && (
            <div className="live-skill-selectors">
              {selectedId && (
                <label>
                  审核卡{' '}
                  <select
                    value={selectedId}
                    disabled={busy}
                    onChange={(event) => {
                      setSelection(event.currentTarget.value);
                      setReason('');
                      setNotice('');
                      decide.reset();
                    }}
                  >
                    {!options.some(({ id }) => id === selectedId) && (
                      <option value={selectedId}>已选审核卡</option>
                    )}
                    {options.map((item) => (
                      <option key={item.id} value={item.id}>
                        {kindNames[item.kind]} · {item.title} {item.version} ·{' '}
                        {statusNames[item.status]}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {page.length > 1 && (
                <button
                  className="live-text-button"
                  type="button"
                  disabled={busy}
                  onClick={() => move(page.slice(0, -1))}
                >
                  上一页
                </button>
              )}
              {next && (
                <button
                  className="live-text-button"
                  type="button"
                  disabled={busy}
                  onClick={() => move([...page, next])}
                >
                  下一页
                </button>
              )}
            </div>
          )}
          {selectedId && detail.isPending && <p role="status">正在读取审核内容…</p>}
          {selected && (
            <article
              ref={card}
              tabIndex={-1}
              aria-label="知识审核卡"
              className="live-skill-review-card"
            >
              <h3>
                {selected.title} {selected.version}
              </h3>
              <p>
                {selected.code} · {statusNames[selected.status]}
              </p>
              <p>密级 · {selected.draft.content.dataLevel === 'confidential' ? '保密' : '内部'}</p>
              {selected.draft.kind === 'rule_pack' && (
                <p>法域 · {selected.draft.content.jurisdiction}</p>
              )}
              {selected.draft.kind === 'template' ? (
                <>
                  <pre className="live-skill-review-text">{selected.draft.content.body}</pre>
                  <p>来源 · {selected.draft.content.source}</p>
                </>
              ) : (
                <ul className="live-knowledge-rules">
                  {selected.draft.content.rules.map((rule) => (
                    <li key={rule.id}>
                      <strong>{rule.statement}</strong>
                      <p>
                        {rule.id} · {rule.status === 'confirmed' ? '已核对' : '待核对'}
                      </p>
                      <p>类别 · {rule.category ? categories[rule.category] : '未分类'}</p>
                      <pre className="live-skill-review-text">
                        {JSON.stringify(
                          { source: rule.source, parameters: rule.parameters, units: rule.units },
                          null,
                          2,
                        )}
                      </pre>
                    </li>
                  ))}
                </ul>
              )}
              {management && selected.status === 'published' && (
                <button
                  className="live-text-button"
                  type="button"
                  disabled={busy || Boolean(yaml.trim()) || copySource !== null}
                  onClick={() => {
                    setKind(selected.kind);
                    const copy = { ...selected.draft.content, version: '' };
                    const formatted = JSON.stringify(copy, null, 2);
                    const editable = fitsWithReleaseVersion(formatted)
                      ? formatted
                      : JSON.stringify(copy);
                    if (fitsWithReleaseVersion(editable)) {
                      setYaml(editable);
                      setNotice('已复制此版本。填写新的版本号后提交审阅。');
                    } else {
                      setCopySource({
                        id: selected.id,
                        title: selected.title,
                        version: selected.version,
                      });
                      setNotice('');
                    }
                    setFormOpen(true);
                  }}
                >
                  以此版起草
                </button>
              )}
              {selected.reason && <p>退回原因 · {selected.reason}</p>}
              {selected.status === 'pending' && (
                <div className="live-skill-selectors">
                  <button
                    className="live-primary"
                    type="button"
                    disabled={busy}
                    onClick={() => submitDecision('publish')}
                  >
                    通过并发布
                  </button>
                  <label>
                    退回原因{' '}
                    <input
                      maxLength={600}
                      value={reason}
                      disabled={busy}
                      onChange={(event) => setReason(event.currentTarget.value)}
                    />
                  </label>
                  <button
                    className="live-secondary"
                    type="button"
                    disabled={busy || !reason.trim()}
                    onClick={() => submitDecision('reject')}
                  >
                    退回
                  </button>
                </div>
              )}
              {decide.isError && (
                <p role="alert" className="live-error">
                  {errorMessage(decide.error)}
                </p>
              )}
            </article>
          )}
          {management && (
            <details
              className="live-skill-review-card"
              open={formOpen}
              onToggle={(event) => setFormOpen(event.currentTarget.open)}
            >
              <summary>登记草稿</summary>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (draftIncomplete) return;
                  setNotice('');
                  const draft = copySource
                    ? { kind, sourceReviewId: copySource.id, version: copyVersion.trim() }
                    : { kind, yaml };
                  const fingerprint = JSON.stringify(draft);
                  stage.mutate({
                    input: { ...draft, requestKey: retryKey(stageAttempts.current, fingerprint) },
                    fingerprint,
                  });
                }}
              >
                {copySource ? (
                  <>
                    <p>
                      从「{copySource.title} {copySource.version}」复制原有内容。
                    </p>
                    <div className="live-skill-selectors">
                      <label>
                        新版本号{' '}
                        <input
                          required
                          maxLength={maxReleaseVersionBytes}
                          value={copyVersion}
                          disabled={busy}
                          onChange={(event) => setCopyVersion(event.currentTarget.value)}
                        />
                      </label>
                      <button
                        className="live-text-button"
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setCopySource(null);
                          setCopyVersion('');
                        }}
                      >
                        取消复制
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="live-skill-selectors">
                      <label>
                        类型{' '}
                        <select
                          value={kind}
                          disabled={busy}
                          onChange={(event) =>
                            setKind(
                              event.currentTarget.value === 'template' ? 'template' : 'rule_pack',
                            )
                          }
                        >
                          <option value="rule_pack">规则包</option>
                          <option value="template">模板</option>
                        </select>
                      </label>
                    </div>
                    <label className="live-knowledge-yaml">
                      草稿 YAML
                      <textarea
                        required
                        rows={8}
                        maxLength={knowledgeDraftMaxBytes}
                        value={yaml}
                        disabled={busy}
                        aria-invalid={draftTooLarge}
                        onChange={(event) => setYaml(event.currentTarget.value)}
                      />
                    </label>
                    {draftTooLarge && (
                      <p role="alert" className="live-error">
                        草稿超过 {knowledgeDraftMaxBytes.toLocaleString('en-US')} 个 UTF-8
                        字节。请压缩格式或缩短正文。
                      </p>
                    )}
                  </>
                )}
                <button className="live-secondary" type="submit" disabled={busy || draftIncomplete}>
                  提交审阅
                </button>
              </form>
              {stage.isError && (
                <p role="alert" className="live-error">
                  {errorMessage(stage.error)}
                </p>
              )}
            </details>
          )}
          {notice && <p role="status">{notice}</p>}
        </div>
      )}
    </section>
  );
}
