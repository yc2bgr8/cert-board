import { useEffect, useRef, useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import * as Collapsible from '@radix-ui/react-collapsible';
import * as Dialog from '@radix-ui/react-dialog';
import { SafeMarkdown } from './SafeMarkdown.js';
import './prototype.css';

const paths = {
  inbox: 'M4 4h16v16H4z M4 13h5l2 3h2l2-3h5',
  folder: 'M3 6h7l2 2h9v12H3z',
  calendar: 'M4 5h16v16H4z M8 3v4 M16 3v4 M4 10h16',
  plus: 'M12 5v14 M5 12h14',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  chevron: 'm9 5 7 7-7 7',
  check: 'm5 12 4 4L19 6',
  close: 'm6 6 12 12 M6 18 18 6',
  file: 'M5 3h9l5 5v13H5z M14 3v6h5 M8 13h8 M8 17h6',
  search: 'M20 20l-5-5 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M12 7v5l3 2',
  attach: 'm8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8',
  spark: 'm12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z',
  list: 'M8 6h12 M8 12h12 M8 18h12 M3 6h1 M3 12h1 M3 18h1',
} as const;

function Icon({ name, size = 18 }: { name: keyof typeof paths; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

type Project = 'registration' | 'maintenance' | 'todo' | 'sales';
type Panel = 'review' | 'evidence' | 'changes' | 'plan' | null;
type Phase = 'ready' | 'running' | 'review' | 'approved' | 'stopped' | 'returned' | 'transferred';
type DecisionAction = 'amend' | 'return' | 'question' | 'transfer' | null;
type Message = { id: number; role: 'user' | 'agent'; text: string };

const phaseLabels: Record<Phase, string> = {
  ready: '准备就绪',
  running: '运行中',
  review: '等待你的决定',
  approved: '已通过',
  stopped: '已停止',
  returned: '已退回',
  transferred: '已转交',
};
const decisionLabels = { amend: '修改后通过', return: '退回', question: '追问', transfer: '转交' };

function ReviewSection({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="review-section">
      <h3>
        <span>{number}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

export function PrototypeApp() {
  const [role, setRole] = useState('RA');
  const [project, setProject] = useState<Project>('registration');
  const [tab, setTab] = useState('conversation');
  const [panel, setPanel] = useState<Panel>(null);
  const [phase, setPhase] = useState<Phase>('ready');
  const [version, setVersion] = useState(0);
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [notice, setNotice] = useState('');
  const [highRisk, setHighRisk] = useState(false);
  const [judgment, setJudgment] = useState('');
  const [judgmentSubmitted, setJudgmentSubmitted] = useState(false);
  const [decisionAction, setDecisionAction] = useState<DecisionAction>(null);
  const [decisionNote, setDecisionNote] = useState('');
  const [feedback, setFeedback] = useState<Record<number, string>>({});
  const [feedbackReason, setFeedbackReason] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [questionAnswer, setQuestionAnswer] = useState('');
  const [salesRequestOpen, setSalesRequestOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageId = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const maintenance = project === 'maintenance';
  const sales = role === 'SALES';
  const title =
    project === 'todo'
      ? '待我处理'
      : sales
        ? '合规报告'
        : maintenance
          ? 'L08 年度注册'
          : 'L08 510(k)';
  const addMessage = (messageRole: Message['role'], text: string) => {
    const id = ++messageId.current;
    setMessages((current) => [...current, { id, role: messageRole, text }]);
  };
  const chooseProject = (next: Project) => {
    if (timer.current) clearTimeout(timer.current);
    setProject(next);
    setTab('conversation');
    setPanel(null);
    setNotice('');
    setMessages([]);
    setInput('');
    setPhase('ready');
    setVersion(0);
    setHighRisk(false);
    setJudgmentSubmitted(false);
    setQuestionAnswer('');
  };
  const showDemoNotice = (text: string) => setNotice(`${text}（仅界面稿演示，未写入后台）`);

  const startCheck = (text: string) => {
    if (!text.trim()) {
      setNotice('请先输入要交给 Agent 的任务。');
      return;
    }
    if (phase === 'running') {
      addMessage('user', text.trim());
      setInput('');
      showDemoNotice('插话已加入本页对话，演示运行继续');
      return;
    }
    addMessage('user', text.trim());
    setInput('');
    setPhase('running');
    setJudgment('');
    setJudgmentSubmitted(false);
    setPanel(null);
    const nextVersion = version + 1;
    timer.current = setTimeout(() => {
      setVersion(nextVersion);
      setPhase('review');
      addMessage(
        'agent',
        maintenance
          ? '已完成年度维护核查的**界面演示**。三项记录需要核对：企业注册状态、年度费用依据、美国代理人协议。所有状态均为虚构示例，不代表 L08 的实际情况。'
          : nextVersion > 1
            ? '已按你的修改意见更新示例检查记录，并重新提交审核。请核对改动和依据，再决定是否通过。'
            : '示例资料中出现两种对比器械 K 号写法：**K123456** 与 **K123465**。已整理为一项待确认差异并提交审核；这些号码和摘录均为虚构示例。',
      );
      timer.current = null;
    }, 900);
  };

  const stopRun = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setPhase('stopped');
    addMessage(
      'agent',
      '演示运行已停止。已展示的读取过程保留，没有生成审核结果，也没有保存工作区版本。',
    );
  };

  const openExampleReview = (target: 'registration' | 'maintenance') => {
    chooseProject(target);
    setPhase('review');
    setVersion(1);
    setPanel('review');
    addMessage('agent', '已打开待我处理中的示例审核。此卡仅用于确认界面布局，不对应真实业务事项。');
  };

  const approve = () => {
    setPhase('approved');
    showDemoNotice(`已通过第 ${version} 版示例审核`);
    addMessage(
      'agent',
      `你已在审核卡上通过第 ${version} 版。界面稿展示为已定稿；此演示没有形成真实审批或冻结记录。`,
    );
  };

  const confirmDecision = () => {
    if (!decisionAction || !decisionNote.trim()) return;
    if (decisionAction === 'amend') approve();
    else if (decisionAction === 'return') {
      setPhase('returned');
      addMessage('agent', '审核已在本页演示中退回。可以在对话中提出修改意见，再次提交。');
    } else if (decisionAction === 'transfer') setPhase('transferred');
    else {
      addMessage('user', decisionNote);
      setPanel(null);
    }
    showDemoNotice(`已演示“${decisionLabels[decisionAction]}”`);
    setDecisionAction(null);
    setDecisionNote('');
  };

  const feedbackButtons = (id: number) => (
    <div className="feedback-row">
      <button
        type="button"
        aria-pressed={feedback[id] === 'useful'}
        onClick={() => {
          setFeedback((current) => ({ ...current, [id]: 'useful' }));
          showDemoNotice('已记录“有用”反馈');
        }}
      >
        有用
      </button>
      <span>·</span>
      <button
        type="button"
        aria-pressed={feedback[id] === 'not-useful'}
        onClick={() => setFeedbackReason(id)}
      >
        没用
      </button>
    </div>
  );

  const processDetails = (
    <Collapsible.Root className="process-block" defaultOpen={false}>
      <Collapsible.Trigger className="process-trigger">
        <span className={phase === 'running' ? 'process-indicator running' : 'process-indicator'}>
          <Icon name={phase === 'running' ? 'clock' : 'check'} size={14} />
        </span>
        <span>
          {phase === 'running' ? '正在读取示例资料…' : '已读取 2 份示例资料，完成 3 步检查'}
        </span>
        <Icon name="chevron" size={14} />
      </Collapsible.Trigger>
      <Collapsible.Content className="process-content">
        <div>
          <span>01</span>
          <strong>读取项目说明与 {maintenance ? 'M02' : 'R09'} 技能</strong>
          <code>load_skill</code>
          <p>技能草稿 · 示例版本；了解任务范围和交付要求。</p>
        </div>
        <div>
          <span>02</span>
          <strong>查找对比器械 K 号</strong>
          <code>doc_search → doc_read</code>
          <p>资料 EXAMPLE-01 / EXAMPLE-02，v1，第 2 / 4 页；仅显示摘要。</p>
        </div>
        <div>
          <span>03</span>
          <strong>整理差异并自检</strong>
          <code>submit_review</code>
          <p>虚构摘录检查通过；真实法规判断仍待注册人员确认。</p>
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );

  const reviewCard = (
    <>
      <div className="review-meta">
        <span className="eyebrow">人工审核</span>
        <span className={`status-pill ${phase === 'approved' ? 'success' : ''}`}>
          {phaseLabels[phase]}
        </span>
      </div>
      <h2>{maintenance ? '年度维护核查' : '对比器械 K 号写法'}</h2>
      <p className="panel-subtitle">工作区第 {version || 1} 版 · 虚构示例</p>
      <label className="risk-toggle">
        <input
          type="checkbox"
          checked={highRisk}
          onChange={(event) => {
            setHighRisk(event.target.checked);
            setJudgmentSubmitted(false);
            setJudgment('');
          }}
        />
        演示高风险审核
      </label>
      {highRisk && !judgmentSubmitted ? (
        <div className="independent-judgment">
          <span className="eyebrow">先形成独立判断</span>
          <h3>请先写下你的判断</h3>
          <p>提交后才显示 AI 结论和审核操作。正式版本由后端强制执行。</p>
          <label htmlFor="independent-judgment">你的独立判断</label>
          <textarea
            id="independent-judgment"
            value={judgment}
            onChange={(event) => setJudgment(event.target.value)}
            placeholder="根据原始资料，你认为应如何处理？"
          />
          <button
            type="button"
            className="button primary"
            disabled={!judgment.trim()}
            onClick={() => setJudgmentSubmitted(true)}
          >
            提交判断
          </button>
        </div>
      ) : (
        <>
          <ReviewSection number="01" title="结论">
            <p>
              {maintenance ? (
                '三项年度维护记录仍需人工核对，暂不判断为完成。'
              ) : (
                <>
                  两份示例资料的对比器械 K 号写法不一致：<strong>K123456</strong> /{' '}
                  <strong>K123465</strong>。
                </>
              )}
            </p>
            <span className="tag amber">待注册人员确认</span>
          </ReviewSection>
          <ReviewSection number="02" title="需要你做什么">
            <p>
              {maintenance
                ? '核对正式台账和付款凭据，确认各项状态及适用期限。'
                : '确认正确号码与差异原因，决定是否通过这份检查记录。此操作不修改原始申报资料。'}
            </p>
          </ReviewSection>
          <ReviewSection number="03" title="改动">
            <button type="button" className="file-link" onClick={() => setPanel('changes')}>
              <Icon name="file" />
              <span>
                检查记录.md<small>已保存为第 {version || 1} 版 · 1 个文件</small>
              </span>
              <Icon name="chevron" size={14} />
            </button>
          </ReviewSection>
          <ReviewSection number="04" title="关键依据">
            <button type="button" className="evidence-link" onClick={() => setPanel('evidence')}>
              [1] 示例对比表 · v1 · 第 2 页<Icon name="arrow" size={14} />
            </button>
            <button type="button" className="evidence-link" onClick={() => setPanel('evidence')}>
              [2] 示例摘要 · v1 · 第 4 页<Icon name="arrow" size={14} />
            </button>
            <small className="muted">虚构原文，仅供界面评审。</small>
          </ReviewSection>
          <ReviewSection number="05" title="AI 自检">
            <ul className="check-list">
              <li>
                <Icon name="check" size={14} />
                示例摘录与引用匹配
              </li>
              <li>
                <Icon name="check" size={14} />
                结果结构完整
              </li>
              <li>
                <Icon name="check" size={14} />
                未对外发送、未改变原件
              </li>
            </ul>
          </ReviewSection>
          <ReviewSection number="06" title="不确定事项">
            <p>尚未核实哪个号码为正确记录。法规判断与真实资料均需注册人员确认。</p>
          </ReviewSection>
          <ReviewSection number="07" title="操作">
            {phase === 'approved' ? (
              <div className="approved-state">
                <Icon name="check" />
                <strong>已通过</strong>
                <p>第 {version || 1} 版 · 仅原型演示</p>
              </div>
            ) : (
              <div className="decision-buttons">
                <button type="button" className="button primary" onClick={approve}>
                  通过
                  <Icon name="check" size={16} />
                </button>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setDecisionAction('amend')}
                >
                  修改后通过
                </button>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setDecisionAction('return')}
                >
                  退回
                </button>
                <button
                  type="button"
                  className="button quiet"
                  onClick={() => setDecisionAction('question')}
                >
                  追问
                </button>
                <button
                  type="button"
                  className="button quiet"
                  onClick={() => setDecisionAction('transfer')}
                >
                  转交
                </button>
              </div>
            )}
            <p className="tiny-note">批准只在审核卡上操作。对话中的“已批准”不算审批。</p>
          </ReviewSection>
          {feedbackButtons(-1)}
        </>
      )}
    </>
  );

  return (
    <div className={`cert-app ${panel && !sales ? 'has-panel' : ''}`}>
      <aside className="sidebar" aria-label="主导航">
        <a
          href="#"
          className="brand"
          onClick={(event) => {
            event.preventDefault();
            chooseProject(sales ? 'sales' : 'registration');
          }}
        >
          <span className="brand-mark">
            <Icon name="spark" size={22} />
          </span>
          <span>
            器械认证<small>CERT BOARD</small>
          </span>
        </a>
        <div className="workspace-label">
          工作空间<span>开发环境</span>
        </div>
        <nav>
          {!sales ? (
            <>
              <button
                type="button"
                className={`nav-item ${project === 'todo' ? 'selected' : ''}`}
                onClick={() => chooseProject('todo')}
              >
                <Icon name="inbox" />
                <span>待我处理</span>
                <span className="nav-count">2</span>
              </button>
              <div className="nav-group-label">注册项目</div>
              <button
                type="button"
                className={`nav-item ${project === 'registration' ? 'selected' : ''}`}
                onClick={() => chooseProject('registration')}
              >
                <Icon name="folder" />
                <span>L08 510(k)</span>
                <i className="nav-dot" />
              </button>
              <div className="nav-group-label">维护事项</div>
              <button
                type="button"
                className={`nav-item ${project === 'maintenance' ? 'selected' : ''}`}
                onClick={() => chooseProject('maintenance')}
              >
                <Icon name="calendar" />
                <span>L08 年度注册</span>
              </button>
              <button
                type="button"
                className="new-conversation"
                onClick={() => {
                  chooseProject(project === 'maintenance' ? 'maintenance' : 'registration');
                  showDemoNotice('已开始新的示例对话');
                }}
              >
                <Icon name="plus" />
                新对话
              </button>
            </>
          ) : (
            <>
              <div className="nav-group-label">销售工作台</div>
              <button
                type="button"
                className="nav-item selected"
                onClick={() => chooseProject('sales')}
              >
                <Icon name="file" />
                合规报告
              </button>
              <div className="nav-group-label">我的请求</div>
              <button
                type="button"
                className="nav-item"
                onClick={() => showDemoNotice('当前展示你的两条示例请求')}
              >
                <Icon name="list" />
                我的报告请求<span className="nav-count">2</span>
              </button>
            </>
          )}
        </nav>
        <div className="sidebar-footer">
          <div className="local-status">
            <span />
            资料与改动，交由你审核
          </div>
          <div className="profile">
            <span className="avatar">{sales ? '销' : '注'}</span>
            <div>
              {sales ? '销售人员' : '注册人员 A'}
              <small>开发演示账号</small>
            </div>
            <span className="profile-indicator">在线</span>
          </div>
        </div>
      </aside>

      <div className="workspace-main">
        <header className="topbar">
          <div className="breadcrumbs">
            工作空间
            <Icon name="chevron" size={12} />
            <span>{title}</span>
          </div>
          <div className="prototype-tools">
            <span className="prototype-badge">界面稿 · 待确认</span>
            <label>
              原型角色
              <select
                aria-label="原型角色"
                value={role}
                onChange={(event) => {
                  setRole(event.target.value);
                  chooseProject(event.target.value === 'SALES' ? 'sales' : 'registration');
                }}
              >
                <option value="RA">注册人员 A</option>
                <option value="SALES">销售人员</option>
              </select>
            </label>
          </div>
        </header>
        <div className="project-heading">
          <div>
            <div className="eyebrow">
              {sales
                ? '销售支持'
                : project === 'todo'
                  ? '你的工作队列'
                  : maintenance
                    ? '维护事项 / 美国'
                    : '注册项目 / 美国'}
            </div>
            <h1>
              {title}
              {project !== 'todo' && !sales && <span className="tag teal">进行中</span>}
            </h1>
            <p>
              {sales
                ? '申请所需的合规材料，跟踪自己的报告请求。'
                : project === 'todo'
                  ? '集中处理需要你审核、判断或补充的信息。'
                  : maintenance
                    ? '围绕企业注册、年度费用与美国代理人，核对维护依据。'
                    : '核对申报资料，保留过程和依据，由人决定最终版本。'}
            </p>
          </div>
          {!sales && project !== 'todo' && (
            <button
              type="button"
              className="button secondary plan-toggle"
              onClick={() => setPanel(panel === 'plan' ? null : 'plan')}
            >
              <Icon name="list" size={16} />
              计划与待办
            </button>
          )}
        </div>
        <div className="demo-strip">
          <span className="demo-dot" />
          示例数据 · 未调用模型<span className="demo-strip-note">所有号码、摘录和状态均为虚构</span>
        </div>
        {notice && (
          <div className="notice" role="status">
            <span>{notice}</span>
            <button type="button" aria-label="关闭提示" onClick={() => setNotice('')}>
              <Icon name="close" size={14} />
            </button>
          </div>
        )}

        {sales ? (
          <section className="sales-page">
            <div className="section-heading">
              <h2>我的报告请求</h2>
              <button
                type="button"
                className="button primary"
                onClick={() => setSalesRequestOpen(true)}
              >
                <Icon name="plus" size={16} />
                申请合规报告
              </button>
            </div>
            <div className="request-card">
              <span className="document-icon">
                <Icon name="file" size={23} />
              </span>
              <div>
                <h3>L08 美国市场销售资料包</h3>
                <p>示例请求 SR-001 · 用途：客户资料预审</p>
              </div>
              <span className="tag amber">等待注册人员</span>
            </div>
            <div className="request-card">
              <span className="document-icon">
                <Icon name="file" size={23} />
              </span>
              <div>
                <h3>L08 产品合规报告</h3>
                <p>示例请求 SR-002 · 申请人：当前销售账号</p>
              </div>
              <button
                type="button"
                className="button secondary"
                onClick={() => showDemoNotice('此处展示报告下载入口，界面稿未生成可用报告')}
              >
                查看报告
              </button>
            </div>
            <p className="muted access-note">
              销售视图只展示自己的请求。正式版本由后端执行访问授权。
            </p>
          </section>
        ) : project === 'todo' ? (
          <section className="todo-page">
            <div className="section-heading">
              <h2>
                需要你的决定 <span>2</span>
              </h2>
              <span className="muted">示例工作队列</span>
            </div>
            <button
              type="button"
              className="todo-card"
              onClick={() => openExampleReview('registration')}
            >
              <span className="document-icon amber">
                <Icon name="file" size={23} />
              </span>
              <div>
                <span className="eyebrow">L08 510(k) · 审核</span>
                <h3>对比器械 K 号写法核查</h3>
                <p>1 项候选差异 · 工作区第 1 版</p>
              </div>
              <span className="tag amber">待审核</span>
              <Icon name="arrow" />
            </button>
            <button
              type="button"
              className="todo-card"
              onClick={() => openExampleReview('maintenance')}
            >
              <span className="document-icon">
                <Icon name="calendar" size={23} />
              </span>
              <div>
                <span className="eyebrow">L08 年度注册 · 维护</span>
                <h3>年度维护核查结果</h3>
                <p>3 项记录待确认 · 不代表真实逾期</p>
              </div>
              <span className="tag">待确认</span>
              <Icon name="arrow" />
            </button>
          </section>
        ) : (
          <Tabs.Root value={tab} onValueChange={setTab} className="project-tabs">
            <Tabs.List className="tab-list" aria-label="项目内容">
              <Tabs.Trigger value="conversation">
                对话<span>1</span>
              </Tabs.Trigger>
              <Tabs.Trigger value="files">
                文件<span>{version ? '2' : '1'}</span>
              </Tabs.Trigger>
              <Tabs.Trigger value="documents">
                资料<span>2</span>
              </Tabs.Trigger>
              <span className="tab-list-spacer" />
              <span className={`conversation-status ${phase === 'running' ? 'is-running' : ''}`}>
                <i />
                {phaseLabels[phase]}
              </span>
            </Tabs.List>
            <Tabs.Content value="conversation" className="conversation-content">
              <div className="conversation-scroll">
                <div className="conversation-date">
                  演示会话 <span />
                  今天
                </div>
                {maintenance && (
                  <div className="maintenance-overview">
                    <div className="section-heading">
                      <h2>本次维护概览</h2>
                      <span className="tag">M02</span>
                    </div>
                    <div className="maintenance-grid">
                      {['企业注册', '年度费用', '美国代理人'].map((item) => (
                        <div key={item}>
                          <Icon name="calendar" size={17} />
                          <strong>{item}</strong>
                          <span>待核对</span>
                        </div>
                      ))}
                    </div>
                    <p>这是演示提醒，不是真实逾期。请先核对依据，再确认维护状态。</p>
                    <button
                      type="button"
                      className="button secondary"
                      onClick={() => startCheck('查看 L08 年度维护核查结果')}
                    >
                      查看核查结果
                      <Icon name="arrow" size={15} />
                    </button>
                  </div>
                )}
                <article className="message agent-message">
                  <span className="agent-avatar">
                    <Icon name="spark" size={19} />
                  </span>
                  <div className="message-body">
                    <div className="message-author">
                      器械认证 Agent<span>演示</span>
                    </div>
                    <SafeMarkdown>
                      {maintenance
                        ? '我会把维护事项的记录、来源和不确定信息放在一起，交给你核对。你可以先查看核查结果，也可以告诉我想检查哪一项。'
                        : '我可以帮你检查申报资料，整理差异和依据。完成后，我会提交审核，原始资料的处理由你决定。'}
                    </SafeMarkdown>
                    {!maintenance && messages.length === 0 && (
                      <button
                        type="button"
                        className="starter-task"
                        onClick={() => startCheck('检查 L08 申报资料中对比器械 K 号的写法')}
                      >
                        <span>
                          <Icon name="search" size={18} />
                          <span>
                            <strong>检查对比器械 K 号的写法</strong>
                            <small>读取资料 → 核对依据 → 提交审核</small>
                          </span>
                        </span>
                        <span className="starter-action">
                          开始检查
                          <Icon name="arrow" size={17} />
                        </span>
                      </button>
                    )}
                  </div>
                </article>
                {messages.map((message) => (
                  <article
                    className={`message ${message.role === 'user' ? 'user-message' : 'agent-message'}`}
                    key={message.id}
                  >
                    {message.role === 'agent' ? (
                      <span className="agent-avatar">
                        <Icon name="spark" size={19} />
                      </span>
                    ) : (
                      <span className="user-avatar">你</span>
                    )}
                    <div className="message-body">
                      <div className="message-author">
                        {message.role === 'user' ? '你' : '器械认证 Agent'}
                        {message.role === 'agent' && <span>演示</span>}
                      </div>
                      {message.role === 'agent' && version > 0 && processDetails}
                      <SafeMarkdown>{message.text}</SafeMarkdown>
                      {message.role === 'agent' && feedbackButtons(message.id)}
                    </div>
                  </article>
                ))}
                {phase === 'running' && (
                  <article className="message agent-message">
                    <span className="agent-avatar">
                      <Icon name="spark" size={19} />
                    </span>
                    <div className="message-body">
                      <div className="message-author">
                        器械认证 Agent<span>演示运行</span>
                      </div>
                      {processDetails}
                      <p className="muted">读取项目说明，整理待核对的资料…</p>
                    </div>
                  </article>
                )}
                {version > 0 && phase !== 'running' && (
                  <div className="result-area">
                    <div className="change-card">
                      <span>
                        <Icon name="file" size={18} />
                        <strong>本轮改动</strong>
                      </span>
                      <button type="button" onClick={() => setPanel('changes')}>
                        检查记录.md
                        <Icon name="chevron" size={14} />
                      </button>
                      <small>已保存为第 {version} 版 · 演示</small>
                    </div>
                    <button
                      type="button"
                      className={`review-summary ${phase === 'approved' ? 'approved' : ''}`}
                      onClick={() => setPanel('review')}
                    >
                      <span className="review-summary-icon">
                        <Icon name={phase === 'approved' ? 'check' : 'inbox'} size={21} />
                      </span>
                      <span>
                        <strong>
                          {phase === 'approved' ? '审核已通过' : '检查结果已提交审核'}
                        </strong>
                        <small>
                          {maintenance ? '3 项维护记录' : '1 项候选差异'} · 工作区第 {version} 版 ·{' '}
                          {phaseLabels[phase]}
                        </small>
                      </span>
                      <span className="review-summary-action">
                        查看审核卡
                        <Icon name="arrow" size={16} />
                      </span>
                    </button>
                  </div>
                )}
                <Collapsible.Root className="run-details">
                  <Collapsible.Trigger>
                    <Icon name="chevron" size={13} />
                    运行详情
                  </Collapsible.Trigger>
                  <Collapsible.Content>
                    <dl>
                      <div>
                        <dt>运行方式</dt>
                        <dd>本页静态演示</dd>
                      </div>
                      <div>
                        <dt>工具调用</dt>
                        <dd>3 步示例，未执行真实工具</dd>
                      </div>
                      <div>
                        <dt>用量 / 费用</dt>
                        <dd>0 tokens / $0（未调用模型）</dd>
                      </div>
                      <div>
                        <dt>子 Agent / 评测</dt>
                        <dd>未运行 / 未运行</dd>
                      </div>
                    </dl>
                    <p>事件：开始 → 读取示例 → 检查示例 → 提交审核。正式运行会逐条记录。</p>
                  </Collapsible.Content>
                </Collapsible.Root>
                <Collapsible.Root className="question-example">
                  <Collapsible.Trigger>
                    <Icon name="chevron" size={13} />
                    查看提问卡示例
                  </Collapsible.Trigger>
                  <Collapsible.Content>
                    <div className="question-card">
                      <h3>这项差异应如何记录？</h3>
                      <p>请结合原始资料，选择一个处理方向。</p>
                      <div className="question-options">
                        {['先列为待确认差异', '按笔误记录，补充依据'].map((answer) => (
                          <button
                            type="button"
                            className={`button secondary ${questionAnswer === answer ? 'is-selected' : ''}`}
                            key={answer}
                            onClick={() => {
                              setQuestionAnswer(answer);
                              showDemoNotice(`已选择：${answer}`);
                            }}
                          >
                            {answer}
                          </button>
                        ))}
                      </div>
                      {questionAnswer && <small role="status">你的回答：{questionAnswer}</small>}
                    </div>
                  </Collapsible.Content>
                </Collapsible.Root>
              </div>
              <form
                className="composer-area"
                onSubmit={(event) => {
                  event.preventDefault();
                  startCheck(input);
                }}
              >
                <div className="composer">
                  <textarea
                    ref={inputRef}
                    aria-label="发送给器械认证Agent的消息"
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    placeholder={
                      version ? '提出修改意见，或继续检查其他内容…' : '告诉 Agent 你希望完成什么…'
                    }
                    rows={2}
                  />
                  <div className="composer-actions">
                    <button
                      type="button"
                      className="attach-button"
                      onClick={() => showDemoNotice('附件入口已展示；真实上传在后续版本实现')}
                    >
                      <Icon name="attach" size={17} />
                      附件
                    </button>
                    <span className="composer-context">
                      {maintenance ? 'M02 年度维护' : 'L08 项目工作区'}
                      <span>·</span>执行模式
                    </span>
                    {phase === 'running' && (
                      <button type="button" className="button stop-button" onClick={stopRun}>
                        <span />
                        停止
                      </button>
                    )}
                    <button
                      type="submit"
                      className="button primary send-button"
                      disabled={!input.trim()}
                    >
                      发送
                      <Icon name="arrow" size={16} />
                    </button>
                  </div>
                </div>
                <p className="composer-footnote">
                  AI 的结论需要你审核。此界面稿使用虚构数据，不作法规或申报依据。
                </p>
              </form>
            </Tabs.Content>
            <Tabs.Content value="files" className="collection-page">
              <div className="section-heading">
                <h2>项目工作区</h2>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => showDemoNotice('上传修改稿尚未接入，未选择或保存任何文件')}
                >
                  <Icon name="attach" size={16} />
                  上传修改稿
                </button>
              </div>
              <div className="file-table">
                <div className="file-table-head">
                  <span>文件</span>
                  <span>版本</span>
                  <span>状态</span>
                  <span>操作</span>
                </div>
                <div className="file-table-row">
                  <span>
                    <Icon name="file" />
                    AGENTS.md<small>项目说明</small>
                  </span>
                  <span>v1</span>
                  <span>示例</span>
                  <button
                    type="button"
                    onClick={() =>
                      showDemoNotice('项目说明：先读资料与技能，执行、自查，再提交审核')
                    }
                  >
                    查看
                  </button>
                </div>
                {version > 0 && (
                  <div className="file-table-row">
                    <span>
                      <Icon name="file" />
                      检查记录.md<small>Agent 交付物</small>
                    </span>
                    <span>v{version}</span>
                    <span>{phase === 'approved' ? '已定稿（演示）' : '待审核'}</span>
                    <button type="button" onClick={() => setPanel('changes')}>
                      对比
                    </button>
                  </div>
                )}
              </div>
              <p className="muted">工作副本独立；保存基于后端版本，冲突时不会覆盖他人的修改。</p>
              <button
                type="button"
                className="text-button"
                onClick={() => showDemoNotice('历史版本入口已展示，当前仅有本页示例版本')}
              >
                查看历史版本
                <Icon name="clock" size={14} />
              </button>
            </Tabs.Content>
            <Tabs.Content value="documents" className="collection-page">
              <div className="section-heading">
                <h2>项目资料库</h2>
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => showDemoNotice('导入资料尚未接入，未上传任何内容')}
                >
                  <Icon name="plus" size={16} />
                  添加资料
                </button>
              </div>
              <div className="source-notice">以下资料和摘录均为虚构示例，不是真实 L08 原文。</div>
              {[
                { name: '示例对比表.pdf', id: 'EXAMPLE-01', page: 2 },
                { name: '示例摘要.pdf', id: 'EXAMPLE-02', page: 4 },
              ].map((document) => (
                <button
                  type="button"
                  className="document-card"
                  key={document.id}
                  onClick={() => setPanel('evidence')}
                >
                  <span className="document-icon">
                    <Icon name="file" size={25} />
                  </span>
                  <span>
                    <strong>{document.name}</strong>
                    <small>
                      {document.id} · v1 · 第 {document.page} 页 · 内部
                    </small>
                  </span>
                  <span className="tag teal">已解析（示例）</span>
                  <Icon name="arrow" size={17} />
                </button>
              ))}
              <div
                className="upload-zone"
                role="region"
                aria-label="资料导入演示区"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  showDemoNotice('已识别拖放动作；界面稿不会读取或上传文件');
                }}
              >
                <Icon name="attach" size={21} />
                <strong>将资料放到这里</strong>
                <span>拖放交互示例；实际导入在后续版本实现</span>
              </div>
            </Tabs.Content>
          </Tabs.Root>
        )}
      </div>

      {panel && !sales && (
        <aside className="inspector" aria-label="审核详情">
          <div className="inspector-toolbar">
            <span>
              {panel === 'review'
                ? '审核卡'
                : panel === 'evidence'
                  ? '证据原文'
                  : panel === 'changes'
                    ? '改动对比'
                    : '计划与待办'}
            </span>
            <button type="button" aria-label="关闭侧栏" onClick={() => setPanel(null)}>
              <Icon name="close" size={18} />
            </button>
          </div>
          <div className="inspector-content">
            {panel === 'review' ? (
              reviewCard
            ) : panel === 'evidence' ? (
              <>
                <div className="eyebrow">只读证据 · 虚构示例</div>
                <h2>同一差异的两处来源</h2>
                <p className="panel-subtitle">资料库版本固定，点击引用回到原文。</p>
                {[
                  { id: 'EXAMPLE-01', name: '示例对比表', page: 2, number: 'K123456' },
                  { id: 'EXAMPLE-02', name: '示例摘要', page: 4, number: 'K123465' },
                ].map((source) => (
                  <section className="source-excerpt" key={source.id}>
                    <span className="eyebrow">
                      {source.id} · v1 · 第 {source.page} 页
                    </span>
                    <h3>{source.name}</h3>
                    <p>
                      Predicate device 510(k) number: <mark>{source.number}</mark>.
                    </p>
                    <small>虚构原文，不对应真实 L08 资料。</small>
                  </section>
                ))}
                <div className="page-preview">
                  <span>原页占位 · 非真实 PDF</span>
                  <div className="paper-page">
                    <strong>示例资料</strong>
                    <p>Predicate Device</p>
                    <div />
                    <div />
                    <p className="highlight-line">510(k): K123456</p>
                    <div />
                    <div />
                    <small>此区域展示原页位置与高亮样式。</small>
                  </div>
                </div>
                <button
                  type="button"
                  className="button secondary full-width"
                  onClick={() => setPanel('review')}
                >
                  返回审核卡
                </button>
              </>
            ) : panel === 'changes' ? (
              <>
                <div className="eyebrow">工作区版本对比</div>
                <h2>检查记录.md</h2>
                <p className="panel-subtitle">
                  {version > 1 ? `第 ${version - 1} 版 → 第 ${version} 版` : '工作副本 → 第 1 版'} ·
                  虚构示例
                </p>
                <div className="diff-stats">
                  <span>+ 3 行</span>
                  <span>− 1 行</span>
                </div>
                <div className="diff-view">
                  <div className="diff-context">
                    <span>1</span># 对比器械 K 号检查记录
                  </div>
                  <div className="diff-removed">
                    <span>−</span>待核对资料写法。
                  </div>
                  <div className="diff-added">
                    <span>+</span>示例对比表：K123456
                  </div>
                  <div className="diff-added">
                    <span>+</span>示例摘要：K123465
                  </div>
                  <div className="diff-added">
                    <span>+</span>
                    {version > 1
                      ? '已按人工意见补充差异原因，待确认。'
                      : '两处写法不一致，待人工确认。'}
                  </div>
                </div>
                <p className="tiny-note">仅修改工作区检查记录，原始资料保持只读。</p>
                <button
                  type="button"
                  className="button secondary full-width"
                  onClick={() => setPanel('review')}
                >
                  返回审核卡
                </button>
              </>
            ) : (
              <>
                <div className="eyebrow">本次任务</div>
                <h2>{maintenance ? '年度维护核查' : '核对对比器械 K 号'}</h2>
                <p className="panel-subtitle">每一步保留来源，最终由你审核。</p>
                <ol className="plan-list">
                  {[
                    '读取项目说明和相关技能',
                    '检索、读取两份示例资料',
                    '整理差异并执行自检',
                    '提交审核，等待你的决定',
                  ].map((step, index) => (
                    <li
                      key={step}
                      className={
                        version > 0 && (index < 3 || phase === 'approved') ? 'complete' : ''
                      }
                    >
                      <span>
                        {version > 0 && (index < 3 || phase === 'approved') ? (
                          <Icon name="check" size={14} />
                        ) : (
                          index + 1
                        )}
                      </span>
                      <div>
                        <strong>{step}</strong>
                        <small>
                          {index === 3 ? phaseLabels[phase] : version ? '已完成（演示）' : '待执行'}
                        </small>
                      </div>
                    </li>
                  ))}
                </ol>
                <div className="plan-note">
                  <strong>交付物</strong>
                  <p>一份带来源的检查记录，以及需要人判断的事项。</p>
                </div>
              </>
            )}
          </div>
        </aside>
      )}

      <Dialog.Root
        open={decisionAction !== null}
        onOpenChange={(open) => {
          if (!open) setDecisionAction(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            <Dialog.Title>
              {decisionAction ? decisionLabels[decisionAction] : '处理审核'}
            </Dialog.Title>
            <Dialog.Description>
              请留下处理说明。这里仅演示交互，不会提交真实审批。
            </Dialog.Description>
            {decisionAction === 'transfer' && (
              <label>
                转交给
                <select>
                  <option>注册人员 B（示例）</option>
                  <option>技术维护人员（示例）</option>
                </select>
              </label>
            )}
            <label htmlFor="decision-note">处理说明</label>
            <textarea
              id="decision-note"
              value={decisionNote}
              onChange={(event) => setDecisionNote(event.target.value)}
              placeholder="说明修改、退回、追问或转交的原因…"
            />
            <div className="dialog-actions">
              <Dialog.Close className="button secondary">取消</Dialog.Close>
              <button
                type="button"
                className="button primary"
                disabled={!decisionNote.trim()}
                onClick={confirmDecision}
              >
                确认{decisionAction ? decisionLabels[decisionAction] : ''}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root
        open={feedbackReason !== null}
        onOpenChange={(open) => {
          if (!open) setFeedbackReason(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            <Dialog.Title>告诉我们哪里没用</Dialog.Title>
            <Dialog.Description>
              你的反馈会帮助改进技能；本页反馈仅用于交互演示。
            </Dialog.Description>
            <label htmlFor="feedback-reason">反馈原因</label>
            <textarea
              id="feedback-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="例如：依据不够清楚，或遗漏了重要资料…"
            />
            <div className="dialog-actions">
              <Dialog.Close className="button secondary">取消</Dialog.Close>
              <button
                type="button"
                className="button primary"
                disabled={!reason.trim()}
                onClick={() => {
                  if (feedbackReason !== null)
                    setFeedback((current) => ({ ...current, [feedbackReason]: 'not-useful' }));
                  setFeedbackReason(null);
                  setReason('');
                  showDemoNotice('已记录反馈原因');
                }}
              >
                提交反馈
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Dialog.Root open={salesRequestOpen} onOpenChange={setSalesRequestOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content">
            <Dialog.Title>申请合规报告</Dialog.Title>
            <Dialog.Description>
              填写需求，交给注册人员准备资料。界面稿不会创建真实请求。
            </Dialog.Description>
            <label>
              产品 / 型号
              <input defaultValue="L08（示例）" />
            </label>
            <label>
              用途
              <textarea placeholder="说明客户、市场与需要的材料…" />
            </label>
            <div className="dialog-actions">
              <Dialog.Close className="button secondary">取消</Dialog.Close>
              <button
                type="button"
                className="button primary"
                onClick={() => {
                  setSalesRequestOpen(false);
                  showDemoNotice('申请入口已展示，尚未创建真实报告请求');
                }}
              >
                提交申请示例
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

export default PrototypeApp;
