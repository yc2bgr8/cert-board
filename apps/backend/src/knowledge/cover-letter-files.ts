export const coverLetterFileName = '510k-cover-letter.draft.md';
export const coverLetterSourcesName = '510k-cover-letter.sources.json';
export const coverLetterArtifact = 'cert-board.k05.cover-letter-draft';
export const coverLetterMarker = `<!-- ${coverLetterArtifact} -->`;

export function coverLetterFileHasValidPath(bytes: Buffer, path: string) {
  const header = bytes.subarray(0, 4096).toString('utf8');
  const markdown = header.startsWith('# ') && header.split(/\r?\n/u, 5).includes(coverLetterMarker);
  const sources = /^\s*\{\s*"artifact"\s*:\s*"cert-board\.k05\.cover-letter-draft"\s*,/u.test(
    header,
  );
  if (!markdown && !sources) return true;
  const parts = path.split('/');
  const filename = markdown ? coverLetterFileName : coverLetterSourcesName;
  return parts.length === 3 && parts[0] === '交付' && parts[2] === filename;
}
