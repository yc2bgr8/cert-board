import type { WorkspaceConflictDetails } from '@cert-board/shared';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: WorkspaceConflictDetails,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
