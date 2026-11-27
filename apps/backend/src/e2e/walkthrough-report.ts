export const requiredRevisionSections = ['核查范围', '已核实', '待核实'] as const;

export function canRequestReviewResubmission(
  previousCardId: string,
  cards: { id: string; status: string }[],
  runStatus: string,
  reasonCode: string | null,
  alreadyRequested: boolean,
  hadToolError: boolean,
) {
  return (
    !alreadyRequested &&
    !hadToolError &&
    cards.length === 1 &&
    cards[0]?.id === previousCardId &&
    cards[0].status === 'rejected' &&
    runStatus === 'stopped' &&
    reasonCode === 'REVIEW_NOT_SUBMITTED'
  );
}

export function revisionSections(markdown: Buffer) {
  const sections = new Map<string, string>();
  const active: Array<{ name: string; level: number }> = [];
  let fence: string | undefined;
  for (const line of markdown.toString('utf8').split(/\r?\n/u)) {
    const delim = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      const marker = delim?.[1];
      if (marker?.startsWith(fence) && !delim?.[2]?.trim()) fence = undefined;
      continue;
    }
    if (delim && (delim[1]![0] !== '`' || !delim[2]!.includes('`'))) {
      fence = delim[1];
      continue;
    }
    const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*$)/u.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      while (active.length && level <= active.at(-1)!.level) active.pop();
      const label = heading[2]?.trim() ?? '';
      const name = requiredRevisionSections.find((section) => label.startsWith(section));
      if (name) active.push({ name, level });
      continue;
    }
    const text = line.trim();
    const section = active.at(-1)?.name;
    if (section && text) sections.set(section, `${sections.get(section) ?? ''}\n${text}`);
  }
  return sections;
}
