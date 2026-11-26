const referenceLine = /^资料引用：(.+)（文档编号 [\da-f-]{36}，第 ([1-9]\d*) 版）$/u;

export function splitConversationDraft(text: string) {
  const lines = text.split('\n');
  const references = [];
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index] ?? '';
    const match = referenceLine.exec(line);
    if (!match) break;
    references.unshift({ line, label: match[1] ?? line, version: match[2] });
    lines.pop();
  }
  return { body: lines.join('\n'), references };
}

export function joinConversationDraft(body: string, references: string[]) {
  return references.length ? [body, ...references].filter(Boolean).join('\n') : body;
}
