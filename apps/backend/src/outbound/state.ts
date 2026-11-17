import { proposalRecordSchema, type ProposalRecord } from '@cert-board/shared';

export const proposalColumns = `p.id,p.project_id AS "projectId",p.goal_id AS "goalId",p.conversation_id AS "conversationId",
 p.run_id AS "runId",p.invocation_id AS "invocationId",p.proposed_by AS "proposedBy",p.contact_id AS "contactId",
 p.recipient_version AS "recipientVersion",p.recipient_name AS "recipientName",p.recipient_address AS "recipientAddress",
 p.channel,p.subject,p.body,p.content_hash AS "contentHash",p.data_level AS "dataLevel",p.status,p.version,
 p.created_at AS "createdAt",p.updated_at AS "updatedAt"`;
export type ProposalRow = Omit<ProposalRecord, 'createdAt' | 'updatedAt'> & {
  createdAt: Date;
  updatedAt: Date;
};
export type GoalRow = {
  id: string;
  project_id: string;
  owner_user_id: string;
  status: string;
  outbound_paused: boolean;
  version: number;
};
export type ContactRow = {
  id: string;
  project_id: string;
  name: string;
  address: string;
  version: number;
  active: boolean;
  channel: string;
};
export function proposalDto(row: ProposalRow) {
  return proposalRecordSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}
export function recipientMatches(proposal: ProposalRow, contact: ContactRow | undefined) {
  return Boolean(
    contact &&
    contact.active &&
    contact.id === proposal.contactId &&
    contact.project_id === proposal.projectId &&
    contact.channel === 'local_test' &&
    proposal.channel === 'local_test' &&
    contact.version === proposal.recipientVersion &&
    contact.name === proposal.recipientName &&
    contact.address === proposal.recipientAddress,
  );
}
