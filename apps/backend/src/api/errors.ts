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

export class ModelNotDispatchedError extends AppError {
  constructor() {
    super(502, 'MODEL_DISPATCH_BLOCKED', 'Cursor 尚未发送模型请求。请核对验收配置、数据级别和运行状态。');
  }
}
