import { useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  humanRevisionMaxBytes,
  humanRevisionMaxWordBytes,
  humanRevisionWordPathPattern,
  type HumanRevisionCommand,
} from '@cert-board/shared';
import { useBrowserCommand } from './ApprovalCard.js';
import { api, ApiError, errorMessage } from './api.js';
import { ShellIcon } from './ShellIcon.js';

type RevisionReceipt = Awaited<ReturnType<typeof api.saveHumanRevision>>;

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
  sourceVersionNumber,
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
  sourceVersionNumber?: number | undefined;
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
  const [receipt, setReceipt] = useState<RevisionReceipt>();
  const [openDifference, setOpenDifference] = useState<string>();
  useEffect(
    () => onPendingChange?.(reading || Boolean(pending)),
    [onPendingChange, reading, pending],
  );
  const fileInput = useRef<HTMLInputElement>(null);
  const savedDifference = useRef<HTMLDetailsElement>(null);
  const sourceControlId = useId();
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
  function clearFile() {
    setFile(undefined);
    if (fileInput.current) fileInput.current.value = '';
  }
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
    clearFile();
    setReceipt(receipt);
    setPages([null]);
    await Promise.all([client.invalidateQueries({ queryKey: key }), refreshWorkspace()]);
  }

  return (
    <details
      className="live-human-revision"
      open={expanded}
      onToggle={(event) => {
        setExpanded(event.currentTarget.open);
        if (!event.currentTarget.open && !pending && !reading) clearFile();
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
          <div className="live-revision-source">
            {paths.length > 1 ? (
              <>
                <label htmlFor={sourceControlId}>对照原稿</label>
                <select
                  id={sourceControlId}
                  value={path}
                  disabled={reading || Boolean(pending)}
                  onChange={(event) => {
                    setSelection(event.target.value);
                    clearFile();
                    setFileError('');
                    setUploadError('');
                    setReceipt(undefined);
                  }}
                >
                  {paths.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </>
            ) : (
              <>
                <span>对照原稿</span>
                <strong className="live-revision-path">{pending?.input.path ?? path}</strong>
              </>
            )}
            <small>
              {sourceVersionNumber
                ? `Agent 工作区第 ${sourceVersionNumber} 版`
                : '关联的 Agent 审核原稿'}
            </small>
          </div>
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
            <span className="live-revision-file-button" aria-hidden="true">
              <ShellIcon name="attachment" />
              {file?.name ?? '选择本机修改稿'}
            </span>
            <small>{word ? '完整 .docx 文件，最多 16 MiB' : '完整 UTF-8 文本，最多 128 KiB'}</small>
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
            className="live-review-primary live-revision-submit"
            type="submit"
            disabled={(!file && !pending) || reading || command.busy}
          >
            {reading ? '正在保存…' : pending ? '确认上次上传' : '上传并保存新版本'}
          </button>
          {pending && !reading && !command.busy && (
            <button
              type="button"
              className="live-text-button"
              onClick={() => {
                setPending(undefined);
                clearFile();
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
      {expanded && receipt && (
        <div className="live-revision-receipt">
          <p role="status">
            {receipt.path} 已保存为工作区第 {receipt.version.number} 版。
          </p>
          <button
            type="button"
            className="live-review-neutral"
            disabled={!history.data?.items.some(({ id }) => id === receipt.id)}
            onClick={() => {
              setOpenDifference(receipt.id);
              savedDifference.current?.scrollIntoView?.({ block: 'nearest' });
              savedDifference.current?.querySelector('summary')?.focus();
            }}
          >
            查看本次修改对比
          </button>
        </div>
      )}
      {history.isError && <p role="alert">读取修改记录失败，请折叠后重新打开。</p>}
      {expanded &&
        history.data?.items.map((item) => (
          <details
            key={item.id}
            className="live-revision-difference"
            ref={receipt?.id === item.id ? savedDifference : undefined}
            open={openDifference === item.id}
            onToggle={(event) => {
              const opened = event.currentTarget.open;
              setOpenDifference((previous) =>
                opened ? item.id : previous === item.id ? undefined : previous,
              );
            }}
          >
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
