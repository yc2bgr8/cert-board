import { checkRunTool } from '../tools/check-run.js';
import { identifierCheckTool } from '../tools/identifier-check.js';
import { rulesRunTool, type RulesOriginals } from '../tools/rules-run.js';
import { submitForReviewTool } from '../tools/submit-for-review.js';
import { proposeExternalTool } from '../tools/propose-external.js';
import { queueInternalMessageTool } from '../tools/queue-internal-message.js';
import { buildDocumentTools } from '../tools/document-tools.js';
import { buildWorkspaceTools } from '../tools/workspace-tools.js';
import { agentInteractionTools } from '../tools/agent-interaction.js';
import { loadAgentSkill } from './definitions.js';
import type { AgentCode, BackendConfig } from '@cert-board/shared';
import type { DocumentBlobStore } from '../documents/blob-store.js';
import type { Pool } from 'pg';
import { consultExternalModelTool } from '../tools/consult-external-model.js';
import { deadlineCalcTool } from '../tools/deadline-calc.js';
import { reminderSetTool } from '../tools/reminder-set.js';
import { buildSandboxTools } from '../tools/code-run.js';
import type { SandboxClient } from '../sandbox/client.js';
import { waitRegisterTool } from '../tools/wait-register.js';
import { factProposeTool, knowledgeGetTool } from '../tools/knowledge-tools.js';
import { workScheduleTool } from '../tools/work-schedule.js';

export async function buildAgentTools(
  store: DocumentBlobStore,
  agentCode: AgentCode,
  pool?: Pool,
  containerRuntime: BackendConfig['CONTAINER_RUNTIME'] = 'host',
  sandbox?: SandboxClient,
  ruleSources?: RulesOriginals,
) {
  const skill = await loadAgentSkill(agentCode, {
    id: agentCode === 'registration' ? 'R09' : 'M02',
  });
  return [
    ...buildDocumentTools(),
    ...buildWorkspaceTools(store),
    ...(agentCode === 'registration' ? [workScheduleTool()] : []),
    ...(sandbox ? buildSandboxTools(store, sandbox) : []),
    ...agentInteractionTools(),
    waitRegisterTool(),
    ...(pool && containerRuntime === 'host' ? [consultExternalModelTool(pool)] : []),
    checkRunTool(),
    identifierCheckTool(),
    rulesRunTool(store, ruleSources),
    knowledgeGetTool(),
    factProposeTool(),
    deadlineCalcTool(),
    reminderSetTool(),
    submitForReviewTool(skill.reviewPolicy),
    proposeExternalTool(),
    queueInternalMessageTool(),
  ];
}
