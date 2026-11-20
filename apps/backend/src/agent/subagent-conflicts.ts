import type { SubagentReport } from '@cert-board/shared';

type Report = { key: string; report: SubagentReport };
type Claim = SubagentReport['claims'][number];

export type SubagentConflict =
  | { kind: 'value'; subject: string; field: string; claims: { task: string; claim: Claim }[] }
  | { kind: 'version'; documentId: string; versions: number[]; tasks: string[] };

const fieldKey = (value: string) => value.trim().normalize('NFC').toLocaleLowerCase('zh-CN');

export function subagentConflicts(reports: readonly Report[]): SubagentConflict[] {
  const fields = new Map<string, { task: string; claim: Claim }[]>();
  const documents = new Map<string, Map<string, Set<number>>>();
  for (const { key, report } of reports) {
    for (const claim of report.claims) {
      const id = JSON.stringify([fieldKey(claim.object), fieldKey(claim.field)]);
      const matches = fields.get(id) ?? [];
      matches.push({ task: key, claim });
      fields.set(id, matches);
      for (const source of claim.sources) {
        const uses = documents.get(source.documentId) ?? new Map<string, Set<number>>();
        const versions = uses.get(key) ?? new Set<number>();
        versions.add(source.version);
        uses.set(key, versions);
        documents.set(source.documentId, uses);
      }
    }
  }
  const conflicts: SubagentConflict[] = [];
  for (const [documentId, uses] of documents) {
    const versions = new Set([...uses.values()].flatMap((entries) => [...entries]));
    if (uses.size > 1 && versions.size > 1)
      conflicts.push({
        kind: 'version',
        documentId,
        versions: [...versions].sort((a, b) => a - b),
        tasks: [...uses.keys()],
      });
  }
  for (const claims of fields.values()) {
    if (new Set(claims.map(({ task }) => task)).size < 2) continue;
    const values = new Set(claims.map(({ claim }) => JSON.stringify([claim.value, claim.unit])));
    if (values.size < 2) continue;
    const { object, field } = claims[0]!.claim;
    conflicts.push({ kind: 'value', subject: object, field, claims });
  }
  return conflicts;
}
