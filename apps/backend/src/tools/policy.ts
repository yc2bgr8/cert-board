// 判定语义参考只读快照 sources/validation/rv02_pi/run_probe.ts 的 Harness.decide。
// 按技术方案4.5重写；不沿用验证脚本记录原始参数或在Harness中审批的做法。
import {
  toolMetadataSchema,
  toolPolicyContextSchema,
  type ToolPolicyDecision,
} from '@cert-board/shared';

export function decideTool(
  metadata: unknown,
  context: unknown,
  registered = true,
): ToolPolicyDecision {
  const deny = (code: string, message: string): ToolPolicyDecision => ({
    decision: 'deny',
    code,
    message,
  });
  if (!registered)
    return deny('TOOL_UNREGISTERED', '工具未登记，请从当前工具目录选择，不要猜测接口。');
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    !('effect' in metadata) ||
    metadata.effect === undefined
  )
    return deny('TOOL_EFFECT_UNDECLARED', '工具未声明动作级别，已拒绝；请维护人员补充登记后再试。');
  const tool = toolMetadataSchema.safeParse(metadata),
    caller = toolPolicyContextSchema.safeParse(context);
  if (!tool.success || !caller.success)
    return deny('TOOL_CONTRACT_INVALID', '工具登记或执行上下文无效，请刷新目录或联系维护人员。');
  const spec = tool.data,
    ctx = caller.data;
  if (spec.publication !== 'published')
    return deny('TOOL_NOT_PUBLISHED', '工具版本尚未发布，不能使用；请选用已发布版本。');
  if (spec.effect === 'irreversible')
    return deny('TOOL_IRREVERSIBLE', '不可逆动作不能由Agent执行；请由人在浏览器中完成相应操作。');
  if (/^(?:approve(?:_|$)|review_decision$|proposal_decision$|workspace_freeze$)/.test(spec.name))
    return deny('TOOL_BROWSER_ONLY', '审批和冻结不能登记为模型工具，请在浏览器审核卡操作。');
  if (!spec.roles.some((role) => ctx.roles.includes(role)) || !ctx.resourceAllowed)
    return deny('TOOL_FORBIDDEN', '当前身份或对象范围不允许使用此工具，请联系有权限的负责人。');
  if (!spec.modes.includes(ctx.mode) || (ctx.mode === 'read_only' && spec.effect !== 'read'))
    return deny('TOOL_READ_ONLY', '当前会话不允许此动作；只读检查不能写入或生成外发提案。');
  if (spec.effect === 'reversible_write' && !ctx.hasUndo)
    return deny(
      'TOOL_UNDO_REQUIRED',
      '写入工具没有可用撤销方式，已按不可逆动作拒绝；请维护人员补全后再试。',
    );
  if (spec.effect !== 'read' && ctx.goalStatus !== 'active')
    return deny('TOOL_GOAL_INACTIVE', '目标当前不能写入或提出外发；请负责人确认目标状态后再继续。');
  if (spec.effect === 'external')
    return {
      decision: 'propose',
      code: 'TOOL_PROPOSAL_ONLY',
      message: '此动作只生成待审核提案，必须由人在浏览器批准，不会直接对外执行。',
    };
  return { decision: 'allow', code: 'TOOL_ALLOWED', message: '动作级别与当前权限检查通过。' };
}

export function toolDescription(metadata: unknown) {
  const tool = toolMetadataSchema.parse(metadata),
    description = tool.description;
  return `${description.purpose}\n何时使用：${description.whenToUse}\n何时不用：${description.avoid}\n参数：${description.parameters}\n示例：${JSON.stringify(description.example)}`;
}
