export type EvidenceTarget = {
  documentId: string;
  version: number;
  page: number;
  quote?: string;
};

export type WorkspaceDiffTarget = {
  projectId: string;
  from: string;
  to: string;
  path?: string;
};

export type WorkspaceFileTarget = {
  projectId: string;
  versionId: string;
  path: string;
};
