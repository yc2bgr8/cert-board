import { useEffect, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DataLevel, IntakeCategory } from '@cert-board/shared';
import { api, ApiError, currentSessionGeneration, errorMessage } from './api.js';
import { packageIntakeFolder } from './intake-folder.js';

const statusLabels = {
  queued: '等待导入',
  running: '正在展开',
  parsing: '正在解析',
  complete: '导入完成',
  failed: '导入失败',
};
const categoryLabels: Record<IntakeCategory, string> = {
  application: '申请与联系人',
  device_description: '器械描述',
  indications: '预期用途及适应症',
  predicate: '实质等同比较',
  labeling: '标签与说明书',
  shelf_life: '灭菌与有效期',
  biocompatibility: '生物相容性',
  software_security: '软件与网络安全',
  electrical: '电气安全与 EMC',
  performance: '性能测试',
  human_factors: '人因',
  summary: '510(k) 摘要',
  declarations: '声明与费用',
  review_needed: '待确认',
};

export function ProjectIntake({ projectId, userId }: { projectId: string; userId: string }) {
  const client = useQueryClient();
  const [level, setLevel] = useState<DataLevel>('internal');
  const [selection, setSelection] = useState<{ file: File } | { folder: File[] }>();
  const [selectedJob, setSelectedJob] = useState<string>();
  const historyKey = ['live', 'intake-history', userId, projectId];
  const history = useInfiniteQuery({
    queryKey: historyKey,
    queryFn: ({ pageParam, signal }) => api.intakeHistory(projectId, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
  });
  const jobs = history.data?.pages.flatMap((page) => page.items) ?? [];
  const jobId = selectedJob ?? jobs[0]?.id;
  const upload = useMutation({
    mutationFn: async ({
      input,
      generation,
    }: {
      input: NonNullable<typeof selection>;
      generation: number;
    }) => {
      const file = 'file' in input ? input.file : await packageIntakeFolder(input.folder);
      if (generation !== currentSessionGeneration())
        throw new ApiError(
          409,
          'INTAKE_SESSION_CHANGED',
          '登录会话已变更，请重新选择资料后再上传。',
        );
      return api.startIntake(projectId, file, level);
    },
    onSuccess(result) {
      setSelectedJob(result.id);
      setSelection(undefined);
      void client.invalidateQueries({ queryKey: historyKey });
    },
  });
  const report = useQuery({
    queryKey: ['live', 'intake', userId, projectId, jobId],
    queryFn: ({ signal }) => api.intakeReport(jobId!, signal),
    enabled: Boolean(jobId),
    refetchInterval: (query) =>
      query.state.data?.status === 'complete' || query.state.data?.status === 'failed'
        ? false
        : 2_000,
    retry: false,
  });
  const edit = useMutation({
    mutationFn: ({ id, path, category }: { id: string; path: string; category: IntakeCategory }) =>
      api.editIntakeCategory(id, path, category),
    onSuccess: (updated) =>
      client.setQueryData(['live', 'intake', userId, projectId, updated.id], updated),
  });
  const retry = useMutation({
    mutationFn: api.retryIntake,
    onSuccess: (result) =>
      client.invalidateQueries({ queryKey: ['live', 'intake', userId, projectId, result.id] }),
  });
  const status = report.data?.status;
  useEffect(() => {
    if (status === 'complete')
      void client.invalidateQueries({ queryKey: ['live', 'project-documents', userId, projectId] });
  }, [client, projectId, status, userId]);
  return (
    <section className="live-page-card" aria-label="整包导入">
      <header className="live-page-card-head">
        <h2>整包导入</h2>
        {status && (
          <span className="live-notice-chip" role="status">
            {statusLabels[status]}
          </span>
        )}
      </header>
      <form
        className="live-page-message live-intake-actions"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          const file = event.dataTransfer.files[0];
          if (file && event.dataTransfer.files.length === 1 && /\.zip$/iu.test(file.name))
            setSelection({ file });
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (selection)
            upload.mutate({ input: selection, generation: currentSessionGeneration() });
        }}
      >
        <label>
          <span>选择 ZIP 资料包</span>
          <input
            type="file"
            accept=".zip,application/zip"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) setSelection({ file });
            }}
          />
        </label>
        <label>
          <span>选择资料目录</span>
          <input
            type="file"
            multiple
            ref={(input) => {
              input?.setAttribute('webkitdirectory', '');
            }}
            onChange={(event) => {
              const folder = Array.from(event.currentTarget.files ?? []);
              if (folder.length) setSelection({ folder });
            }}
          />
        </label>
        <label>
          <span>资料级别</span>
          <select value={level} onChange={(event) => setLevel(event.target.value as DataLevel)}>
            <option value="internal">内部</option>
            <option value="confidential">保密</option>
            <option value="public">公开</option>
          </select>
        </label>
        <button type="submit" className="live-secondary" disabled={!selection || upload.isPending}>
          {upload.isPending ? '正在上传…' : '导入资料包'}
        </button>
      </form>
      {!!jobs.length && (
        <p className="live-page-message">
          <label>
            导入历史{' '}
            <select
              value={jobId ?? ''}
              onChange={(event) => setSelectedJob(event.currentTarget.value)}
            >
              {jobId && !jobs.some((job) => job.id === jobId) && (
                <option value={jobId}>刚提交的资料包</option>
              )}
              {jobs.map((job) => (
                <option key={job.id} value={job.id}>
                  {job.name}
                </option>
              ))}
            </select>
          </label>
        </p>
      )}
      {history.hasNextPage && (
        <button
          type="button"
          className="live-secondary"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          加载更早报告
        </button>
      )}
      {(upload.error || report.error || edit.error || history.error || retry.error) && (
        <p className="live-error live-page-message" role="alert">
          {errorMessage(upload.error ?? report.error ?? edit.error ?? history.error ?? retry.error)}
        </p>
      )}
      {report.data && (
        <div className="live-page-message live-intake-report">
          <p>{report.data.name}</p>
          {report.data.errorCode && <p className="live-error">导入错误 {report.data.errorCode}</p>}
          {report.data.canRetry && (
            <button
              type="button"
              className="live-secondary"
              disabled={retry.isPending}
              onClick={() => retry.mutate(jobId!)}
            >
              重试导入
            </button>
          )}
          <dl>
            <div>
              <dt>包内文件</dt>
              <dd>{report.data.totals.outerFiles}</dd>
            </div>
            <div>
              <dt>eSTAR 子资料</dt>
              <dd>{report.data.totals.embeddedFiles}</dd>
            </div>
            <div>
              <dt>内容去重</dt>
              <dd>{report.data.totals.duplicates}</dd>
            </div>
            <div>
              <dt>已解析</dt>
              <dd>{report.data.totals.ready}</dd>
            </div>
            <div>
              <dt>解析失败</dt>
              <dd>{report.data.totals.failed}</dd>
            </div>
          </dl>
          {!!report.data.items.length && (
            <details>
              <summary>查看分类及资料路径</summary>
              <p>
                {report.data.categories
                  .map((row) => `${categoryLabels[row.category]} ${row.count}`)
                  .join('、')}
              </p>
              <ul>
                {report.data.items.map((item) => (
                  <li key={item.path}>
                    {item.path}{' '}
                    <select
                      value={item.category}
                      disabled={edit.isPending}
                      aria-label={`分类 ${item.path}`}
                      onChange={(event) =>
                        edit.mutate({
                          id: jobId!,
                          path: item.path,
                          category: event.currentTarget.value as IntakeCategory,
                        })
                      }
                    >
                      {Object.entries(categoryLabels).map(([category, label]) => (
                        <option key={category} value={category}>
                          {label}
                        </option>
                      ))}
                    </select>
                    {item.duplicate && ' · 重复内容'}
                    {item.errorCode && ` · ${item.errorCode}`}
                    {item.sourceNames.length > 1 && (
                      <small> · 附件名 {item.sourceNames.join('、')}</small>
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
