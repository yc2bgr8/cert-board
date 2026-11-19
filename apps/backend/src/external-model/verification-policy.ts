import {
  sourceCheckKey,
  verificationConclusionSchema,
  type VerificationClaim,
  type VerificationConclusion,
  type VerificationMessage,
  type VerificationModel,
  type VerificationSourceCheck,
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
  earlierHistory = false,
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
  const options = new Map(
    Object.entries(selections).map(([key, value]) => [verificationIssueKey(key), value]),
  );
  const byCategory = { trusted: 0, disputed: 1, unverified: 2, human: 3 };
  const items = [...issues.entries()].slice(-96).map(([key, opinions]) => {
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
      selection: options.get(key) ?? null,
      evidence: values.map(({ post, claim }) => ({
        messageId: post.message.id,
        author: post.message.author,
        statement: claim.statement,
        sources: claim.sources,
      })),
    };
  });
  const humanPosts = posts.filter(({ message }) => message.type === 'human');
  const human = humanPosts.slice(-24);
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
  return verificationConclusionSchema.parse({
    items: statements,
    summary,
    createdAt,
    omitted: {
      issues: issues.size - items.length,
      human: humanPosts.length - human.length,
      earlierHistory,
    },
  });
}

export function applySourceChecks(
  conclusion: VerificationConclusion,
  checks?: ReadonlyMap<string, VerificationSourceCheck>,
): VerificationConclusion {
  const counts = { trusted: 0, disputed: 0, unverified: 0, human: 0 };
  const items = conclusion.items.map((item) => {
    const evidence = item.evidence.map((entry) => ({
      ...entry,
      sources: entry.sources.map((source) => ({
        ...source,
        check: checks?.get(sourceCheckKey(source)) ??
          source.check ?? { status: 'source_unavailable' as const },
      })),
    }));
    const cited = evidence.filter(({ sources }) => sources.length > 0);
    const verified = cited.filter(({ sources }) =>
      sources.some(({ check }) => check.status === 'verified'),
    );
    const category: VerificationConclusion['items'][number]['category'] =
      item.category === 'human' || item.category === 'unverified'
        ? item.category
        : item.category === 'trusted' && verified.length >= 2 && verified.length === cited.length
          ? 'trusted'
          : item.category === 'disputed' && verified.length > 0
            ? 'disputed'
            : 'unverified';
    counts[category]++;
    return {
      ...item,
      category,
      selection: category === 'trusted' || category === 'disputed' ? item.selection : null,
      evidence,
    };
  });
  const summary = items.length
    ? `出处核对完成。可信 ${counts.trusted} 项，有分歧 ${counts.disputed} 项，待核实 ${counts.unverified} 项，人工补充 ${counts.human} 项。`
    : '本轮没有可核对出处的结构化结论，事实性判断请保留待核实。';
  return { ...conclusion, items, summary };
}
