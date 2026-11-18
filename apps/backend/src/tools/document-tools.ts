import { docSearchTool } from './doc-search.js';
import { docReadTool } from './doc-read.js';
import { skillLoadTool } from './skill-load.js';

export function buildDocumentTools() {
  return [docSearchTool(), docReadTool(), skillLoadTool()];
}
