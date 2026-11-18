import { checkRunTool } from '../tools/check-run.js';
import { submitForReviewTool } from '../tools/submit-for-review.js';
import { proposeExternalTool } from '../tools/propose-external.js';
import { queueInternalMessageTool } from '../tools/queue-internal-message.js';
import { buildDocumentTools } from '../tools/document-tools.js';
import { buildWorkspaceTools } from '../tools/workspace-tools.js';
import { agentInteractionTools } from '../tools/agent-interaction.js';
import { loadAgentSkill } from './definitions.js';
import type { AgentCode } from '@cert-board/shared';
import type { DocumentBlobStore } from '../documents/blob-store.js';

export async function buildAgentTools(store: DocumentBlobStore, agentCode: AgentCode) {
  const skill = await loadAgentSkill(agentCode, {
    id: agentCode === 'registration' ? 'R09' : 'M02',
  });
  return [
    ...buildDocumentTools(),
    ...buildWorkspaceTools(store),
    ...agentInteractionTools(),
    checkRunTool(),
    submitForReviewTool(skill.reviewPolicy),
    proposeExternalTool(),
    queueInternalMessageTool(),
  ];
}
