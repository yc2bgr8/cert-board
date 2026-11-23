import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SkillActionInput } from '@cert-board/shared';
import { api, createRequestKey, errorMessage } from './api.js';
import { SkillRollbackPanel } from './SkillRollbackPanel.js';

const permissionLabels = { read_only: '只读', ask: '请求批准', full: '完全允许' };

export function SkillVersions({
  userId,
  rollbackFocus = null,
}: {
  userId: string;
  rollbackFocus?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [skillId, setSkillId] = useState('');
  const [versionId, setVersionId] = useState('');
  const client = useQueryClient();
  const listKey = ['live', 'skill-versions', userId];
  const list = useQuery({
    queryKey: listKey,
    queryFn: ({ signal }) => api.skills(signal),
    enabled: open,
    retry: false,
  });
  const selectedSkill = list.data?.items.find((item) => item.id === skillId) ?? list.data?.items[0];
  const selectedVersion =
    selectedSkill?.versions.find(({ id }) => id === versionId) ??
    selectedSkill?.versions.find(({ id }) => id === selectedSkill.activeVersionId) ??
    selectedSkill?.versions[0];
  const version = useQuery({
    queryKey: [...listKey, selectedSkill?.id, selectedVersion?.id],
    queryFn: ({ signal }) => api.skillVersion(selectedSkill!.id, selectedVersion!.id, signal),
    enabled: open && Boolean(selectedVersion),
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: ({ id, command }: { id: string; command: SkillActionInput }) =>
      api.skillDecision(id, command),
    onSettled: async () => {
      await client.invalidateQueries({ queryKey: listKey });
    },
  });
  const selected = version.data;
  const active = selected?.id === selectedSkill?.activeVersionId;
  const previous = selected?.id === selectedSkill?.previousVersionId;
  const action: SkillActionInput['action'] = active ? 'disable' : previous ? 'rollback' : 'publish';
  return (
    <section id="skill-versions" aria-label="技能版本管理" className="live-page-card">
      <header className="live-page-card-head">
        <h2>技能版本</h2>
        <button
          type="button"
          className="live-text-button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? '收起技能版本' : '查看技能版本'}
        </button>
      </header>
      {open && list.isPending && (
        <p role="status" className="live-page-message">
          正在读取技能版本…
        </p>
      )}
      {open && list.isError && (
        <p role="alert" className="live-page-message live-error">
          {errorMessage(list.error)}
        </p>
      )}
      {open && list.data && !selectedSkill && (
        <p className="live-page-message">暂时没有已登记的技能草稿。</p>
      )}
      {open && selectedSkill && (
        <div className="live-page-message">
          <div className="live-skill-selectors">
            <label>
              技能{' '}
              <select
                value={selectedSkill.id}
                onChange={(event) => {
                  setSkillId(event.currentTarget.value);
                  setVersionId('');
                  mutation.reset();
                }}
              >
                {list.data?.items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.id} {item.agentCode === 'registration' ? '注册 Agent' : '维护 Agent'}
                  </option>
                ))}
              </select>
            </label>
            <label>
              技能版本{' '}
              <select
                value={selectedVersion?.id ?? ''}
                onChange={(event) => {
                  setVersionId(event.currentTarget.value);
                  mutation.reset();
                }}
              >
                {selectedSkill.versions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.metadata.version}{' '}
                    {item.id === selectedSkill.activeVersionId
                      ? '生效'
                      : item.id === selectedSkill.previousVersionId
                        ? '上一版'
                        : item.published
                          ? '已审阅'
                          : '草稿'}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {version.isError && (
            <p role="alert" className="live-error">
              {errorMessage(version.error)}
            </p>
          )}
          {selected && (
            <article aria-label="技能审核卡" className="live-skill-review-card">
              <h3>
                {selected.metadata.name} {selected.metadata.version}
              </h3>
              <p>{selected.metadata.summary}</p>
              <p>
                适用模式为{selected.metadata.modes.map((mode) => permissionLabels[mode]).join('、')}
                。送审风险为{selected.metadata.risk === 'high' ? '高风险' : '标准'}。
              </p>
              <p>
                必须通过 {selected.metadata.requiredChecks.join('、')}。每条陈述至少需要{' '}
                {selected.metadata.minimumEvidence} 条依据。
              </p>
              <pre className="live-skill-review-text">{selected.body}</pre>
              <button
                type="button"
                className="live-secondary"
                disabled={mutation.isPending}
                onClick={() => {
                  mutation.mutate({
                    id: selectedSkill.id,
                    command: {
                      action,
                      expectedRevision: selectedSkill.revision,
                      requestKey: createRequestKey(),
                      versionId: selected.id,
                      contentSha256: selected.contentSha256,
                    },
                  });
                }}
              >
                {active
                  ? '停用当前版本'
                  : previous
                    ? '退回上一版'
                    : selected.published
                      ? '启用所选版本'
                      : '批准并发布'}
              </button>
              {mutation.isSuccess && <p role="status">技能版本状态已更新。</p>}
              {mutation.isError && (
                <p role="alert" className="live-error">
                  {errorMessage(mutation.error)}
                </p>
              )}
            </article>
          )}
        </div>
      )}
      <SkillRollbackPanel userId={userId} focusId={rollbackFocus} />
    </section>
  );
}
