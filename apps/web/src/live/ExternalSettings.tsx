import { useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { externalModelWordCategorySchema, type ExternalModelWordInput } from '@cert-board/shared';
import { api, errorMessage } from './api.js';
import { useBrowserCommand } from './ApprovalCard.js';
import { formatExternalUsd, useExternalModelSetup } from './ExternalWorkbench.js';

const categories: Record<ExternalModelWordInput['category'], string> = {
  customer: '客户名',
  product: '产品代号',
  price: '价格',
  contract: '合同条款',
  other: '其他',
};
const days = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
const clock = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function ExternalSettings({ userId }: { userId: string }) {
  const client = useQueryClient();
  const wordsKey = ['live', 'external-model-words', userId];
  const words = useQuery({
    queryKey: wordsKey,
    queryFn: ({ signal }) => api.externalWords(signal),
    retry: false,
  });
  const command = useBrowserCommand();
  const [phrase, setPhrase] = useState('');
  const [category, setCategory] = useState<ExternalModelWordInput['category']>('customer');
  const [day, setDay] = useState(() => days.format(new Date()));
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const archive = useInfiniteQuery({
    queryKey: ['live', 'external-model-day', userId, day],
    queryFn: ({ signal, pageParam }) => api.externalArchiveDay(day, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!day,
    retry: false,
  });
  const items = archive.data?.pages.flatMap((page) => page.items) ?? [];
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = phrase.trim();
    if (!value || command.busy) return;
    const result = await command.run(['add-word', value, category], () =>
      api.externalSaveWord({ phrase: value, category }),
    );
    if (!result) return;
    setPhrase('');
    void client.invalidateQueries({ queryKey: wordsKey });
  }
  async function download() {
    if (!items.length || downloading) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      const encoder = new TextEncoder();
      const chunks = ['[\n'];
      let size = 4;
      let cursor: string | null = null;
      do {
        const batch = await api.externalArchiveDay(day, cursor);
        for (const { title: _localTitle, ...entry } of batch.items) {
          const chunk = (chunks.length > 1 ? ',\n' : '') + JSON.stringify(entry);
          size += encoder.encode(chunk).byteLength;
          if (size > 16 * 1024 * 1024) {
            setDownloadError('当日档案过大，请分页查看。');
            return;
          }
          chunks.push(chunk);
        }
        cursor = batch.nextCursor;
      } while (cursor);
      chunks.push('\n]');
      const url = URL.createObjectURL(new Blob(chunks, { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `外发清单-${day}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (failure) {
      setDownloadError(errorMessage(failure));
    } finally {
      setDownloading(false);
    }
  }
  return (
    <>
      <section id="external-model-words" className="live-page-card" aria-label="保密词表">
        <header className="live-page-card-head">
          <h2>保密词表</h2>
          {words.data && <span className="live-muted">{words.data.length} 个词</span>}
        </header>
        <form className="external-word-form" onSubmit={(event) => void add(event)}>
          <input
            aria-label="新保密词"
            placeholder="填写保密词"
            value={phrase}
            maxLength={120}
            onChange={(event) => setPhrase(event.target.value)}
          />
          <select
            aria-label="词类"
            value={category}
            onChange={(event) =>
              setCategory(externalModelWordCategorySchema.parse(event.target.value))
            }
          >
            {Object.entries(categories).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <button className="live-primary" type="submit" disabled={!phrase.trim() || command.busy}>
            添加
          </button>
        </form>
        {(command.error || words.isError) && (
          <p role="alert" className="live-page-message live-error">
            {command.error ?? errorMessage(words.error)}
          </p>
        )}
        {!!words.data && !words.data.length && (
          <p className="live-page-message live-muted">暂无保密词。</p>
        )}
        <ul className="external-word-list">
          {words.data?.map((word) => (
            <li key={word.id}>
              <span>{word.phrase}</span>
              <span className="live-notice-chip">{categories[word.category]}</span>
              <button
                className="live-text-button"
                type="button"
                disabled={command.busy}
                aria-label={`停用保密词 ${word.phrase}`}
                onClick={() => {
                  void command
                    .run(['disable', word.id], async () => {
                      await api.externalRemoveWord(word.id);
                      return true;
                    })
                    .then((removed) => {
                      if (removed) void client.invalidateQueries({ queryKey: wordsKey });
                    });
                }}
              >
                停用
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section id="external-model-archive" className="live-page-card" aria-label="外发记录">
        <header className="live-page-card-head">
          <h2>外发记录</h2>
          {archive.data && (
            <span className="live-muted">
              {items.length} 条{archive.hasNextPage && '已加载'}
            </span>
          )}
        </header>
        <div className="external-archive-controls">
          <input
            aria-label="外发日期"
            type="date"
            value={day}
            onChange={(event) => setDay(event.target.value)}
          />
          <button
            type="button"
            className="live-secondary"
            disabled={!items.length || downloading}
            onClick={() => void download()}
          >
            下载外发清单
          </button>
        </div>
        {(archive.isError || downloadError) && (
          <p role="alert" className="live-page-message live-error">
            {downloadError ?? errorMessage(archive.error)}
          </p>
        )}
        {!!archive.data && !items.length && (
          <p className="live-page-message live-muted">当天暂无外发记录。</p>
        )}
        <ul className="external-archive-list">
          {items.map((entry) => (
            <li key={entry.id}>
              <details className="external-archive">
                <summary>
                  {entry.title} · {clock.format(new Date(entry.createdAt))} ·{' '}
                  {entry.status === 'settled' ? '已结算' : '费用待核对'}
                </summary>
                <h3>发出内容</h3>
                <pre>{JSON.stringify(entry.sent, null, 2)}</pre>
                <h3>返回内容</h3>
                {entry.returned ? (
                  <pre>{JSON.stringify(entry.returned, null, 2)}</pre>
                ) : (
                  <p>未收到完整回执。</p>
                )}
              </details>
            </li>
          ))}
        </ul>
        {archive.hasNextPage && (
          <button
            type="button"
            className="live-secondary live-assets-more"
            disabled={archive.isFetchingNextPage}
            onClick={() => void archive.fetchNextPage()}
          >
            加载更多外发记录
          </button>
        )}
      </section>
    </>
  );
}

export function ExternalModelBudgetLine({ userId }: { userId: string }) {
  const setup = useExternalModelSetup(userId);
  const budget = setup.data?.budget;
  return budget ? (
    <p className="live-page-message" aria-label="外部模型入口预算">
      外部模型入口 · {formatExternalUsd(budget.usedNano)} / {formatExternalUsd(budget.limitNano)}{' '}
      美元
      {budget.blocked && ' · 已暂停'}
    </p>
  ) : (
    <p className="live-page-message live-muted">
      {setup.isError ? '外部模型预算暂不可用。' : '正在读取外部模型预算…'}
    </p>
  );
}
