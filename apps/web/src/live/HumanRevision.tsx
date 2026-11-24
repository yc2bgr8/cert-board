import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { humanRevisionMaxBytes, type HumanRevisionInput } from '@cert-board/shared';
import { useBrowserCommand } from './ApprovalCard.js';
import { api, isStaleError } from './api.js';

export function HumanRevision({
  workspaceId,
  reviewId,
  projectId,
  sourceVersionId,
  expectedCurrentVersionId,
  current,
  paths,
}: {
  workspaceId: string;
  reviewId: string;
  projectId: string;
  sourceVersionId: string;
  expectedCurrentVersionId: string;
  current: boolean;
  paths: string[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [selection, setSelection] = useState('');
  const [file, setFile] = useState<File>();
  const [level, setLevel] = useState<HumanRevisionInput['dataLevel']>('internal');
  const [fileError, setFileError] = useState('');
  const [reading, setReading] = useState(false);
  const [pages, setPages] = useState<(string | null)[]>([null]);
  const command = useBrowserCommand();
  const client = useQueryClient();
  const key = ['live', 'human-revisions', workspaceId, reviewId];
  const cursor = pages.at(-1) ?? null;
  const history = useQuery({
    queryKey: [...key, cursor],
    queryFn: ({ signal }) => api.humanRevisions(workspaceId, reviewId, cursor, signal),
    enabled: expanded,
    retry: false,
  });
  const nextPage = history.data?.nextCursor;
  const path = paths.includes(selection) ? selection : paths[0];
  const refreshWorkspace = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ['live', 'workspace', projectId] }),
      client.invalidateQueries({ queryKey: ['live', 'workspace-versions', workspaceId] }),
      client.invalidateQueries({ queryKey: ['live', 'review-workspace', projectId] }),
      client.invalidateQueries({ queryKey: ['live', 'review-workspace-versions', workspaceId] }),
    ]);
  async function upload() {
    if (!file || !path || command.busy || reading || !current) return;
    if (file.size === 0 || file.size > humanRevisionMaxBytes) {
      setFileError('请选择不超过 128 KiB 的非空 UTF-8 文本。');
      return;
    }
    setReading(true);
    setFileError('');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        await file.arrayBuffer(),
      );
    } catch {
      setFileError('无法读取该文件。请以 UTF-8 编码另存后重试。');
      setReading(false);
      return;
    }
    const input = {
      reviewId,
      sourceVersionId,
      expectedCurrentVersionId,
      path,
      text,
      dataLevel: level,
    };
    let conflict = false;
    const receipt = await command.run(
      [workspaceId, reviewId, sourceVersionId, expectedCurrentVersionId, path, text, level],
      (requestKey) => api.saveHumanRevision(workspaceId, { ...input, requestKey }),
      (error) => {
        conflict = isStaleError(error);
      },
    );
    if (conflict) await refreshWorkspace();
    setReading(false);
    if (!receipt) return;
    setFile(undefined);
    setPages([null]);
    await Promise.all([client.invalidateQueries({ queryKey: key }), refreshWorkspace()]);
  }

  return (
    <details
      className="live-human-revision"
      onToggle={(event) => {
        setExpanded(event.currentTarget.open);
        if (!event.currentTarget.open) setFile(undefined);
      }}
    >
      <summary>人工修改稿</summary>
      {expanded && current && path && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void upload();
          }}
        >
          <label>
            替换文件
            <select
              value={path}
              disabled={reading}
              onChange={(event) => setSelection(event.target.value)}
            >
              {paths.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label className="live-human-file">
            修改稿（Markdown 或纯文本）
            <input
              type="file"
              className="sr-only"
              aria-label="修改稿（Markdown 或纯文本）"
              accept=".md,.txt,text/markdown,text/plain"
              disabled={reading}
              onChange={(event) => {
                setFile(event.target.files?.[0]);
                setFileError('');
              }}
            />
            <span aria-hidden="true">{file?.name ?? '选择修改稿'}</span>
          </label>
          <label>
            资料密级
            <select
              value={level}
              disabled={reading}
              onChange={(event) =>
                setLevel(event.target.value === 'confidential' ? 'confidential' : 'internal')
              }
            >
              <option value="internal">沿用原稿密级</option>
              <option value="confidential">保密</option>
            </select>
          </label>
          <button
            className="live-review-neutral"
            type="submit"
            disabled={!file || reading || command.busy}
          >
            上传并保存新版本
          </button>
          {(fileError || command.error) && <p role="alert">{fileError || command.error}</p>}
        </form>
      )}
      {history.isError && <p role="alert">读取修改记录失败，请折叠后重新打开。</p>}
      {expanded &&
        history.data?.items.map((item) => (
          <details key={item.id}>
            <summary>
              {item.path} · 人工修改第 {item.version.number} 版
            </summary>
            <p>
              {item.skillId} {item.skillVersion} · 新增 {item.difference.added} 段，删除{' '}
              {item.difference.removed} 段
            </p>
            <ul>
              {item.difference.paragraphs.map((paragraph) => (
                <li key={`${paragraph.kind}-${paragraph.number}`}>
                  <strong>
                    {paragraph.kind === 'added' ? '新增' : '删除'}第 {paragraph.number} 段
                  </strong>
                  <pre>{paragraph.text}</pre>
                  {paragraph.truncated && <small>段落已截断，可打开工作区版本核对全文。</small>}
                </li>
              ))}
            </ul>
            {item.difference.truncated && <p>部分改动未在摘要展开，请对照工作区版本。</p>}
          </details>
        ))}
      {expanded && (pages.length > 1 || nextPage) && (
        <div className="live-human-feedback-actions">
          {pages.length > 1 && (
            <button
              type="button"
              className="live-review-link"
              onClick={() => setPages(pages.slice(0, -1))}
            >
              上一页
            </button>
          )}
          {nextPage && (
            <button
              type="button"
              className="live-review-link"
              onClick={() => setPages([...pages, nextPage])}
            >
              下一页
            </button>
          )}
        </div>
      )}
    </details>
  );
}
