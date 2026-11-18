import { checkRunTool } from '../tools/check-run.js';
import { submitForReviewTool } from '../tools/submit-for-review.js';
import { proposeExternalTool } from '../tools/propose-external.js';
import { loadReviewPolicy } from '../reviews/policy.js';

export async function buildAgentTools() {
  return [checkRunTool(), submitForReviewTool(await loadReviewPolicy()), proposeExternalTool()];
}
