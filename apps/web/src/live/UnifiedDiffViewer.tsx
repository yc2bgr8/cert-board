// 改编自 VisaFlow app/packages/ui/src/components/code-viewer/UnifiedDiffViewer.tsx。
// 保留统一行视图和变更标记，直接渲染后端已定位、分页的行。
import type { workspaceTextDiffSchema } from '@cert-board/shared';
import type { z } from 'zod';

type DiffLine = z.infer<typeof workspaceTextDiffSchema>['lines'][number];

export function UnifiedDiffViewer({ lines }: { lines: DiffLine[] }) {
  return (
    <div className="review-text-diff" role="region" aria-label="文本差异">
      {lines.map((line, index) => (
        <div className={`review-diff-line is-${line.kind}`} data-change={line.kind} key={index}>
          <span className="review-diff-number" aria-label="旧行号">
            {line.oldLine ?? '—'}
          </span>
          <span className="review-diff-number" aria-label="新行号">
            {line.newLine ?? '—'}
          </span>
          <span className="review-diff-symbol" aria-hidden="true">
            {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ''}
          </span>
          <pre>
            {line.text}
            {line.lineTruncated && <span className="review-panel-warning">（本行已截断）</span>}
          </pre>
        </div>
      ))}
    </div>
  );
}
