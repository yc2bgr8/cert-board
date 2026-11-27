import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  defaultPermissionMode,
  type PermissionMode,
  type ProjectRecord,
  type TaskCatalogEntry,
} from '@cert-board/shared';
import { api, ApiError, errorMessage } from './api.js';
import { useBrowserCommand } from './ApprovalCard.js';
import './project-tasks.css';

const permissions: Record<PermissionMode, string> = {
  ask: '请求批准',
  full: '完全允许',
  read_only: '只读',
};

const status: Record<TaskCatalogEntry['availability'], string> = {
  ready: '可开始',
  draft: '开发草稿',
  pending: '当前无可用技能',
  other_project: '请在对应项目使用',
  system: '系统功能',
};

export function ProjectTasks({
  project,
  userId,
  onStart,
  onSkillSettings,
}: {
  project: ProjectRecord;
  userId: string;
  onStart(id: string): void;
  onSkillSettings(): void;
}) {
  const [mode, setMode] = useState<PermissionMode>(defaultPermissionMode);
  const [category, setCategory] = useState('project');
  const [search, setSearch] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [scope, setScope] = useState('');
  const command = useBrowserCommand();
  const catalog = useQuery({
    queryKey: ['live', 'task-catalog', userId, project.id, mode],
    queryFn: ({ signal }) => api.taskCatalog(project.id, mode, signal),
    retry: false,
  });
  const selected = catalog.data?.entries.find((item) => item.code === code);
  const available = selected?.availability === 'ready' || selected?.availability === 'draft';
  const inactive = project.status === 'closed' || project.status === 'cancelled';
  const query = search.trim().toLocaleLowerCase();
  const entries =
    catalog.data?.entries.filter((item) => {
      const correctCategory =
        category === 'project'
          ? item.availability !== 'other_project' && item.availability !== 'system'
          : category === 'all' || item.code.startsWith(category);
      return (
        correctCategory &&
        `${item.code} ${item.title} ${item.description}`.toLocaleLowerCase().includes(query)
      );
    }) ?? [];

  async function start() {
    if (!selected?.skillVersion || !available || inactive || catalog.isFetching) return;
    const task = {
      code: selected.code,
      skillVersion: selected.skillVersion,
      ...(scope.trim() && { scope: scope.trim() }),
    };
    await command.run(
      [project.id, mode, task],
      async (requestKey) => {
        const result = await api.createConversation(
          { requestKey, permissionMode: mode, task },
          project.id,
        );
        onStart(result.conversation.id);
        return result;
      },
      (failure) => {
        if (failure instanceof ApiError && failure.status === 409) void catalog.refetch();
      },
    );
  }

  return (
    <section className="live-workspace-page live-task-page" aria-label="项目任务">
      <header>
        <h2>选择要交办的任务</h2>
        <p className="live-muted">{project.name}</p>
      </header>
      <div className="live-task-controls">
        <label>
          任务范围
          <select
            value={category}
            disabled={command.busy}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="project">当前项目</option>
            <option value="all">全部能力</option>
            <option value="R">注册</option>
            <option value="M">维护</option>
            <option value="S">支持与系统</option>
          </select>
        </label>
        <label>
          搜索任务
          <input
            type="search"
            value={search}
            disabled={command.busy}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="例如：申报一致性、体系审核"
          />
        </label>
      </div>
      {catalog.isPending && (
        <p role="status" className="live-muted">
          正在读取任务和技能版本…
        </p>
      )}
      {catalog.isError && (
        <div role="alert" className="live-error">
          {errorMessage(catalog.error)}{' '}
          <button type="button" className="live-secondary" onClick={() => void catalog.refetch()}>
            重试
          </button>
        </div>
      )}
      {catalog.isSuccess && entries.length === 0 && (
        <p className="live-muted">没有符合条件的任务。</p>
      )}
      <div className="live-task-layout">
        <div className="live-task-list">
          {entries.map((item) => (
            <button
              className="live-task-card"
              type="button"
              key={item.code}
              disabled={command.busy}
              aria-pressed={item.code === code}
              onClick={() => {
                setCode(item.code);
                if (item.code !== code) setScope('');
              }}
            >
              <span className="live-task-card-heading">
                <strong>{item.title}</strong>
                <span className="live-task-status" data-availability={item.availability}>
                  {status[item.availability]}
                </span>
              </span>
              <span>{item.description}</span>
            </button>
          ))}
        </div>
        {code && (
          <section className="live-page-card live-task-detail" aria-label="任务确认">
            {selected ? (
              <>
                <h3>{selected.title}</h3>
                <dl>
                  <dt>预计交付</dt>
                  <dd>{selected.deliverable}</dd>
                  {selected.skillVersion && (
                    <>
                      <dt>技能版本</dt>
                      <dd>
                        {selected.code} · {selected.skillVersion}
                      </dd>
                    </>
                  )}
                </dl>
                {selected.availability === 'system' ? (
                  <button className="live-secondary" type="button" onClick={onSkillSettings}>
                    打开设置
                  </button>
                ) : selected.availability === 'other_project' ? (
                  <p className="live-muted">
                    切换到{selected.code.startsWith('R') ? '注册项目' : '维护事项'}
                    后可以查看这项任务的可用状态。
                  </p>
                ) : (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void start();
                    }}
                  >
                    <label>
                      工作范围（可选）
                      <textarea
                        value={scope}
                        maxLength={2000}
                        rows={3}
                        disabled={command.busy}
                        onChange={(event) => setScope(event.target.value)}
                        placeholder="例如：只核对软件版本，保留每处原文位置"
                      />
                    </label>
                    <label>
                      本次权限
                      <select
                        value={mode}
                        disabled={command.busy}
                        onChange={(event) => setMode(event.target.value as PermissionMode)}
                      >
                        {Object.entries(permissions).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {inactive && <p role="status">项目已关闭或取消。</p>}
                    {!available && <p role="status">当前权限下没有可加载的技能版本。</p>}
                    {selected.availability === 'draft' && (
                      <p className="live-muted">此版本用于开发验证，输出供审核。</p>
                    )}
                    {available && !inactive && (
                      <p className="live-muted">
                        {mode === 'read_only'
                          ? '在项目对话中返回核对结果、依据和待确认项。'
                          : '建立工作目标并启动 Agent。完成后在项目对话中提交审核。'}
                      </p>
                    )}
                    {command.error && (
                      <p className="live-error" role="alert">
                        {command.error}
                      </p>
                    )}
                    <button
                      type="submit"
                      className="live-primary"
                      disabled={!available || inactive || command.busy || catalog.isFetching}
                    >
                      {command.busy ? '正在启动…' : '开始任务'}
                    </button>
                  </form>
                )}
              </>
            ) : (
              <p role="status">正在核对当前权限可用的技能…</p>
            )}
          </section>
        )}
      </div>
    </section>
  );
}
