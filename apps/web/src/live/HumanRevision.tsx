import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  humanRevisionMaxBytes,
  humanRevisionMaxWordBytes,
  humanRevisionWordPathPattern,
  type HumanRevisionCommand,
} from '@cert-board/shared';
import { useBrowserCommand } from './ApprovalCard.js';
import { api, ApiError, errorMessage } from './api.js';

type RevisionAttempt = {
  number: number;
  input: Omit<HumanRevisionCommand, 'requestKey'>;
  content: { text: string } | { file: File };
};

export function HumanRevision({
  workspaceId,
  reviewId,
  projectId,
  sourceVersionId,
  expectedCurrentVersionId,
  current,
  paths,
  initiallyOpen = false,
  onPendingChange,
}: {
  workspaceId: string;
  reviewId: string;
  projectId: string;
  sourceVersionId: string;
  expectedCurrentVersionId: string;
  current: boolean;
  paths: string[];
  initiallyOpen?: boolean;
  onPendingChange?(pending: boolean): void;
}) {
  const [expanded, setExpanded] = useState(initiallyOpen);
  const [selection, setSelection] = useState('');
  const [file, setFile] = useState<File>();
  const [level, setLevel] = useState<HumanRevisionCommand['dataLevel']>('internal');
  const [fileError, setFileError] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [reading, setReading] = useState(false);
  const [pending, setPending] = useState<RevisionAttempt>();
  useEffect(
    () => onPendingChange?.(reading || Boolean(pending)),
    [onPendingChange, reading, pending],
  );
  const fileInput = useRef<HTMLInputElement>(null);
  const nextAttempt = useRef(0);
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
  const word = humanRevisionWordPathPattern.test(pending?.input.path ?? path ?? '');
  const fileLabel = word ? '修改稿（Word .docx）' : '修改稿（Markdown 或纯文本）';
  const refreshWorkspace = () =>
    client.invalidateQueries({
      predicate: ({ queryKey }) => {
        if (queryKey[0] !== 'live') return false;
        const family = queryKey[1];
        const target = queryKey.at(-1);
        return (
          ((family === 'workspace' || family === 'review-workspace') && target === projectId) ||
          ((family === 'workspace-versions' || family === 'review-workspace-versions') &&
            target === workspaceId)
        );
      },
    });
  async function upload() {
    if (command.busy || reading || (!pending && (!file || !path || !current))) return;
    setReading(true);
    setFileError('');
    setUploadError('');
    let attempt = pending;
    if (!attempt) {
      const maximum = word ? humanRevisionMaxWordBytes : humanRevisionMaxBytes;
      if (
        !file ||
        !path ||
        file.size === 0 ||
        file.size > maximum ||
        (word && !humanRevisionWordPathPattern.test(file.name))
      ) {
        setFileError(
          word
            ? '请选择不超过 16 MiB 的完整 Word（.docx）修改稿。'
            : '请选择不超过 128 KiB 的非空 UTF-8 文本。',
        );
        setReading(false);
        return;
      }
      try {
        const content = word
          ? { file }
          : {
              text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
                await file.arrayBuffer(),
              ),
            };
        attempt = {
          number: ++nextAttempt.current,
          input: { reviewId, sourceVersionId, expectedCurrentVersionId, path, dataLevel: level },
          content,
        };
      } catch {
        setFileError('无法读取该文件。请以 UTF-8 编码另存后重试。');
        setReading(false);
        return;
      }
      setPending(attempt);
    }
    const { input, content } = attempt;
    const receipt = await command.run(
      [attempt.number],
      (requestKey) =>
        'file' in content
          ? api.saveWordRevision(workspaceId, { ...input, requestKey }, content.file)
          : api.saveHumanRevision(workspaceId, { ...input, requestKey, text: content.text }),
      (error) => {
        setUploadError(errorMessage(error));
        if (error instanceof ApiError && error.status >= 400 && error.status < 500)
          setPending(undefined);
      },
    );
    if (!receipt) await refreshWorkspace();
    setReading(false);
    if (!receipt) return;
    setPending(undefined);
    setFile(undefined);
    if (fileInput.current) fileInput.current.value = '';
    setPages([null]);
    await Promise.all([client.invalidateQueries({ queryKey: key }), refreshWorkspace()]);
  }

  return (
    <details
      className="live-human-revision"
      open={expanded}
      onToggle={(event) => {
        setExpanded(event.currentTarget.open);
        if (!event.currentTarget.open && !pending) setFile(undefined);
      }}
    >
      <summary>人工修改稿</summary>
      {expanded && ((current && path) || pending) && (
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
              disabled={reading || Boolean(pending)}
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
            {fileLabel}
            <input
              ref={fileInput}
              type="file"
              className="sr-only"
              aria-label={fileLabel}
              accept={
                word
                  ? '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                  : '.md,.txt,text/markdown,text/plain'
              }
              disabled={reading || Boolean(pending)}
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
              disabled={reading || Boolean(pending)}
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
            disabled={(!file && !pending) || reading || command.busy}
          >
            {pending ? '确认上次上传' : '上传并保存新版本'}
          </button>
          {pending && !reading && !command.busy && (
            <button
              type="button"
              className="live-text-button"
              onClick={() => {
                setPending(undefined);
                setFile(undefined);
                if (fileInput.current) fileInput.current.value = '';
                setUploadError('');
                void client.invalidateQueries({ queryKey: key });
                void refreshWorkspace();
              }}
            >
              放弃重试
            </button>
          )}
          {(fileError || uploadError) && <p role="alert">{fileError || uploadError}</p>}
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
