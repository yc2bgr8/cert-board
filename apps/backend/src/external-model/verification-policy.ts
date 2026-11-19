import {
  verificationConclusionSchema,
  type VerificationClaim,
  type VerificationMessage,
  type VerificationModel,
} from '@cert-board/shared';

export const verificationIssueKey = (text: string) =>
  text.normalize('NFC').trim().toLowerCase().replace(/\s+/gu, ' ');

export function eligibleParticipants(
  participants: readonly VerificationModel[],
  attempts: Readonly<Record<string, number>>,
  autoRounds: number,
  humanJoined: boolean,
) {
  return participants.filter(({ id }) => humanJoined || (attempts[id] ?? 0) < autoRounds);
}

type EvidencePost = {
  message: VerificationMessage;
  participant: VerificationModel | null;
  claims: readonly VerificationClaim[];
};

export function arrangeVerificationConclusion(
  posts: readonly EvidencePost[],
  summary: string,
  selections: Readonly<Record<string, string>>,
  createdAt = new Date().toISOString(),
) {
  const issues = new Map<string, Map<string, { post: EvidencePost; claim: VerificationClaim }>>();
  for (const post of posts) {
    if (!post.participant || post.message.type !== 'model') continue;
    for (const claim of post.claims) {
      const key = verificationIssueKey(claim.issue);
      const opinions = issues.get(key) ?? new Map();
      opinions.set(post.participant.id, { post, claim });
      issues.set(key, opinions);
    }
  }
  const byCategory = { trusted: 0, disputed: 1, unverified: 2, human: 3 };
  const items = [...issues.entries()].slice(0, 96).map(([key, opinions]) => {
    const values = [...opinions.values()];
    const sourced = values.filter(({ claim }) => claim.sources.length > 0);
    const providers = new Set(sourced.map(({ post }) => post.participant?.family));
    const stances = new Set(values.map(({ claim }) => claim.stance));
    const statements = new Set(values.map(({ claim }) => verificationIssueKey(claim.statement)));
    const category: 'unverified' | 'trusted' | 'disputed' = !sourced.length
      ? 'unverified'
      : providers.size >= 2 && stances.size === 1 && statements.size === 1
        ? 'trusted'
        : 'disputed';
    return {
      category,
      statement: sourced[0]?.claim.statement ?? values[0]!.claim.statement,
      selection: selections[key] ?? null,
      evidence: values.map(({ post, claim }) => ({
        messageId: post.message.id,
        author: post.message.author,
        statement: claim.statement,
        sources: claim.sources,
      })),
    };
  });
  const human = posts.filter(({ message }) => message.type === 'human').slice(-24);
  const statements = [
    ...items,
    ...human.map(({ message }) => ({
      category: 'human' as const,
      statement: message.text,
      selection: null,
      evidence: [
        { messageId: message.id, author: message.author, statement: message.text, sources: [] },
      ],
    })),
  ].sort((left, right) => byCategory[left.category] - byCategory[right.category]);
  return verificationConclusionSchema.parse({ items: statements, summary, createdAt });
}
