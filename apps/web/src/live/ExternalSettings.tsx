import { useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  externalModelWordCategorySchema,
  verificationChannelSchema,
  type ExternalModelWordInput,
  type VerificationSettings,
  type VerificationSettingsInput,
} from '@cert-board/shared';
import { api, errorMessage } from './api.js';
import { useBrowserCommand } from './ApprovalCard.js';
import { useVerificationSettings, verificationSettingsKey } from './VerificationWorkbench.js';
import './external-model.css';

const channelStates: Record<VerificationSettings['channelStatus'], string> = {
  ready: 'Cursor 命令行可用。',
  fixture: '模拟 Cursor 通道。',
  not_installed: '开发机的 Cursor 命令行尚未配置。',
  not_signed_in: 'Cursor 命令行尚未登录。',
  privacy_unverified: 'Cursor 隐私模式待确认。',
  quota: 'Cursor 订阅额度已用完。',
  unavailable: 'Cursor 通道暂不可用。',
};

function VerificationPreferences({
  settings,
  userId,
  management,
}: {
  settings: VerificationSettings;
  userId: string;
  management: boolean;
}) {
  const [autoRounds, setRounds] = useState(String(settings.autoRounds));
  const [waitMinutes, setWaitMinutes] = useState(String(settings.waitMinutes));
  const [models, setModels] = useState<VerificationSettingsInput['models']>(settings.models);
  const [saved, setSaved] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const command = useBrowserCommand();
  const client = useQueryClient();
  function revise(id: string, patch: Partial<VerificationSettingsInput['models'][number]>) {
    setSaved(false);
    setModels((current) =>
      current.map((model) => (model.id === id ? { ...model, ...patch } : model)),
    );
  }
  return (
    <form
      className="verification-settings-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!management || settings.unavailableReason) return;
        const input = { autoRounds: Number(autoRounds), models, waitMinutes: Number(waitMinutes) };
        void command
          .run([input], () => api.verificationSaveSettings(input))
          .then((result) => {
            if (!result) return;
            client.setQueryData(verificationSettingsKey(userId), result);
            setSaved(true);
          });
      }}
    >
      <p role="status">{settings.unavailableReason ?? channelStates[settings.channelStatus]}</p>
      {settings.catalog.some(({ channel }) => channel === 'gateway') && (
        <p role="status">
          {settings.gatewayReady
            ? 'OpenRouter 核实通道已就绪。'
            : 'OpenRouter 核实通道暂不可用，请查看维护页。'}
        </p>
      )}
      <fieldset disabled={!management || !!settings.unavailableReason || command.busy}>
        <legend>通道和默认参与模型</legend>
        {models.map((model) => {
          const catalog = settings.catalog.find(({ id }) => id === model.id);
          const expenses = settings.gatewayUsage?.find(({ model: id }) => id === model.id);
          return (
            <div className="verification-config-row" key={model.id}>
              <strong>{catalog?.label ?? model.id}</strong>
              <label>
                通道{' '}
                <select
                  value={model.channel}
                  onChange={(event) =>
                    revise(model.id, {
                      channel: verificationChannelSchema.parse(event.target.value),
                    })
                  }
                >
                  <option value="cursor" disabled={catalog?.channel !== 'cursor'}>
                    Cursor（开发机）
                  </option>
                  <option value="gateway" disabled={catalog?.channel !== 'gateway'}>
                    OpenRouter（模型网关）
                  </option>
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={model.enabled}
                  onChange={(event) =>
                    revise(model.id, {
                      enabled: event.target.checked,
                      ...(event.target.checked ? {} : { defaultParticipant: false }),
                    })
                  }
                />{' '}
                启用
              </label>
              <label>
                <input
                  type="checkbox"
                  disabled={!model.enabled}
                  checked={model.defaultParticipant}
                  onChange={(event) =>
                    revise(model.id, { defaultParticipant: event.target.checked })
                  }
                />{' '}
                默认参与
              </label>
              {model.channel === 'cursor' ? (
                <span>
                  {settings.usage.find(({ model: id }) => id === model.id)?.calls ?? 0} 次
                </span>
              ) : (
                <span>
                  {(Number(expenses?.actualNano ?? 0) / 1e9).toFixed(6)} 美元
                  {!!expenses?.unknown && `，${expenses.unknown} 次待核账`}
                </span>
              )}
            </div>
          );
        })}
        <label>
          每个模型最多自动讨论{' '}
          <input
            aria-label="每个模型最多自动讨论轮数"
            type="number"
            min={1}
            max={20}
            value={autoRounds}
            onChange={(event) => {
              setRounds(event.target.value);
              setSaved(false);
            }}
            required
          />{' '}
          轮
        </label>
        <small>有人在群里发言后，轮数上限解除。</small>
        <label>
          核实等待上限{' '}
          <input
            aria-label="核实等待上限"
            type="number"
            min={1}
            max={240}
            value={waitMinutes}
            onChange={(event) => {
              setWaitMinutes(event.target.value);
              setSaved(false);
            }}
            required
          />{' '}
          分钟
        </label>
      </fieldset>
      {management && (
        <button
          className="live-primary"
          type="submit"
          disabled={command.busy || !!settings.unavailableReason}
        >
          保存外部模型设置
        </button>
      )}
      {saved && <p role="status">外部模型设置已保存。</p>}
      {management &&
        !settings.unavailableReason &&
        settings.channelStatus !== 'ready' &&
        settings.channelStatus !== 'fixture' && (
          <button
            type="button"
            className="live-secondary"
            disabled={command.busy}
            onClick={() => {
              void command
                .run(['verification-channel-recheck'], async () => {
                  await api.verificationRecheck();
                  void client.invalidateQueries({ queryKey: verificationSettingsKey(userId) });
                  return true;
                })
                .then((accepted) => {
                  if (accepted) setRechecking(true);
                });
            }}
          >
            复查 Cursor 通道
          </button>
        )}
      {rechecking && <p role="status">已请求复查。通道状态会在检查后更新。</p>}
      {command.error && <p role="alert">{command.error}</p>}
    </form>
  );
}

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

export function ExternalSettings({
  userId,
  management,
  openRoom,
}: {
  userId: string;
  management: boolean;
  openRoom(id: string): void;
}) {
  const verification = useVerificationSettings(userId);
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
      <section
        id="external-verification-settings"
        className="live-page-card"
        aria-label="外部模型设置"
      >
        <header className="live-page-card-head">
          <h2>外部模型</h2>
        </header>
        {verification.data && (
          <VerificationPreferences
            settings={verification.data}
            userId={userId}
            management={management}
          />
        )}
        {verification.isError && <p role="alert">{errorMessage(verification.error)}</p>}
      </section>
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
                  核实：{entry.title} · {clock.format(new Date(entry.createdAt))} ·{' '}
                  {entry.channel === 'cursor' ? 'Cursor' : '模型网关'}
                </summary>
                <button
                  type="button"
                  className="live-text-button"
                  onClick={() => openRoom(entry.conversationId)}
                >
                  打开核实群聊
                </button>
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

export function ExternalUsageSummary({
  userId,
  view,
}: {
  userId: string;
  view: 'budget' | 'models' | 'alert';
}) {
  const { data, isError } = useVerificationSettings(userId);
  if (!data) return isError ? <p className="live-page-message">外部核实状态暂不可用。</p> : null;
  if (view === 'alert')
    return data.channelStatus !== 'ready' && data.channelStatus !== 'fixture' ? (
      <p className="live-page-message" role="status">
        外部核实 · {data.unavailableReason ?? channelStates[data.channelStatus]}
      </p>
    ) : null;
  if (view === 'models')
    return (
      <ul className="live-page-message" aria-label="外部核实的模型">
        {data.catalog.map((model) => {
          const config = data.models.find(({ id }) => id === model.id);
          return (
            <li key={model.id}>
              {model.label} · {config?.channel === 'cursor' ? '经 Cursor' : '经 OpenRouter'} ·{' '}
              {config?.enabled ? '已启用' : '已停用'}
            </li>
          );
        })}
      </ul>
    );
  return (
    <p className="live-page-message" aria-label="外部核实用量">
      外部核实 · 经 Cursor 订阅 · 本月 {data.usage.reduce((total, entry) => total + entry.calls, 0)}{' '}
      次
      {data.catalog.some(({ channel }) => channel === 'gateway') && (
        <>
          。OpenRouter 本月已计{' '}
          {(data.gatewayUsage?.reduce((total, value) => total + Number(value.actualNano), 0) ?? 0) /
            1e9}{' '}
          美元，
          {data.gatewayUsage?.reduce((total, value) => total + value.unknown, 0) ?? 0} 次待核账。
        </>
      )}
    </p>
  );
}
