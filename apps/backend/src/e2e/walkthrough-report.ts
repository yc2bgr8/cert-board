export const requiredRevisionSections = ['核查范围', '已核实', '待核实'] as const;

export function revisionSections(markdown: Buffer) {
  const sections = new Map<string, string>();
  let active: { name: string; level: number } | undefined;
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
      if (!active || level <= active.level) {
        const label = heading[2]?.trim() ?? '';
        const name = requiredRevisionSections.find((section) => label.startsWith(section));
        active = name ? { name, level } : undefined;
      }
      continue;
    }
    const text = line.trim();
    if (active && text) sections.set(active.name, `${sections.get(active.name) ?? ''}\n${text}`);
  }
  return sections;
}
