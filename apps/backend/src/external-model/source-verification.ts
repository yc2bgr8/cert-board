import type { Pool, PoolClient } from 'pg';
import {
  canonicalPublicWebUrl,
  sourceCheckKey,
  verificationConclusionSchema,
  type VerificationSource,
  type VerificationSourceCheck,
} from '@cert-board/shared';
import { AppError } from '../api/errors.js';
import { quoteAppears } from '../checks/quotes.js';
import type { DocumentBlobStore } from '../documents/blob-store.js';
import type { FetcherClient } from '../documents/fetcher-client.js';
import {
  archivePublicWebSnapshot,
  cachedPublicWebArchive,
  classifyWebSource,
  downloadPublicWebSnapshot,
  webSourceKey,
} from '../documents/public-web.js';
import { redactExternalMessages } from './policy.js';
import { ExternalModels } from './service.js';
import { applySourceChecks } from './verification-policy.js';

type SourceScope = { roomId: string; leaseId: string; projectId: string | null };
type ArchivedPage = { documentId: string; version: number; sha256: string; text: string };
export type VerificationSourceChecker = (
  scope: SourceScope,
  sources: readonly VerificationSource[],
) => Promise<ReadonlyMap<string, VerificationSourceCheck>>;

export async function readCheckedConclusion(
  db: Pick<Pool, 'query'>,
  projectId: string | null,
  raw: unknown,
) {
  const parsed = verificationConclusionSchema.parse(raw);
  const references = new Map<
    string,
    {
      documentId: string;
      version: number;
      sha256: string;
      url: string;
    }
  >();
  for (const { evidence } of parsed.items) {
    for (const { sources } of evidence) {
      for (const source of sources) {
        if (source.check?.status !== 'verified') continue;
        references.set(sourceCheckKey(source), {
          documentId: source.check.documentId,
          version: source.check.version,
          sha256: source.check.sha256,
          url: canonicalPublicWebUrl(source.url) ?? '',
        });
      }
    }
  }
  if (!references.size) return applySourceChecks(parsed);
  const valid = projectId
    ? await db.query<{ key: string }>(
        `SELECT src.key FROM jsonb_to_recordset($2::jsonb) AS src(
       key text, "documentId" uuid, version integer, sha256 text, url text
     ) JOIN document d ON d.id=src."documentId" AND d.project_id=$1 AND NOT d.voided
     JOIN document_version v ON v.document_id=d.id AND v.version_no=src.version
     JOIN document_page p ON p.version_id=v.id AND p.page_number=1 AND NOT p.is_placeholder
     WHERE v.data_level='public' AND v.original_sha256=src.sha256
       AND v.source_metadata->'webArchive'->>'url'=src.url
       AND NOT EXISTS (SELECT 1 FROM document_version protected
         WHERE protected.document_id=d.id AND protected.data_level='confidential')`,
        [projectId, JSON.stringify(Array.from(references, ([key, value]) => ({ key, ...value })))],
      )
    : null;
  const allowed = new Set(valid?.rows.map(({ key }) => key));
  return applySourceChecks(
    parsed,
    new Map(
      Array.from(references.keys())
        .filter((key) => !allowed.has(key))
        .map((key) => [key, { status: 'source_unavailable' as const }]),
    ),
  );
}

async function scopeAllowed(db: PoolClient, scope: SourceScope) {
  const allowed = await db.query(
    `SELECT 1 FROM external_model_conversation room
      JOIN app_user initiator ON initiator.id=room.user_id AND initiator.status='active'
      LEFT JOIN verification_link link ON link.room_id=room.id
      LEFT JOIN conversation convo ON convo.id=link.conversation_id
      LEFT JOIN run origin_run ON origin_run.id=link.run_id
      WHERE room.id=$1 AND room.lease_id=$2 AND room.state='discussing' AND room.project_id=$3
      AND (link.room_id IS NULL OR (
        convo.project_id=room.project_id AND convo.permission_mode<>'read_only'
        AND convo.max_data_level<>'confidential' AND origin_run.max_data_level<>'confidential'
      )) AND NOT EXISTS (
        SELECT 1 FROM document doc JOIN document_version ver ON ver.document_id=doc.id
        WHERE doc.project_id=room.project_id AND ver.data_level='confidential'
      )`,
    [scope.roomId, scope.leaseId, scope.projectId],
  );
  return !!allowed.rowCount;
}

export function createVerificationSourceChecker(
  pool: Pool,
  store: DocumentBlobStore,
  fetcher: Pick<FetcherClient, 'fetchPage'>,
  extendedHosts: readonly string[] = [],
): VerificationSourceChecker {
  const protection = new ExternalModels(pool, undefined, undefined, 20_000_000_000n);

  async function archivePage(scope: SourceScope, url: string, signal: AbortSignal) {
    const db = await pool.connect();
    let committed = false;
    try {
      await db.query('BEGIN');
      await db.query("SET LOCAL statement_timeout='5000ms'");
      const projectId = scope.projectId;
      if (!projectId || signal.aborted || !(await scopeAllowed(db, scope))) return null;
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `${projectId}:${webSourceKey(url)}`,
      ]);
      if (signal.aborted || !(await scopeAllowed(db, scope))) return null;
      const addresses = [{ role: 'user' as const, content: `${url}\n${decodeURIComponent(url)}` }];
      const words = (await protection.words(db)).map(({ phrase }) => phrase);
      const safe = redactExternalMessages(addresses, words);
      if (safe.replacementCount) return null;
      await protection.checkConfidentialSources(db, safe.messages);
      const cached = await cachedPublicWebArchive(db, projectId, url);
      if (cached)
        return {
          documentId: cached.documentId,
          version: cached.version,
          sha256: cached.archive.sha256,
          text: cached.placeholder ? '' : (cached.text ?? ''),
        };

      const downloaded = await downloadPublicWebSnapshot(fetcher, url, signal);
      if (signal.aborted || !(await scopeAllowed(db, scope))) return null;
      const { saved, archive } = await archivePublicWebSnapshot(
        pool,
        store,
        db,
        projectId,
        downloaded,
        classifyWebSource(url, extendedHosts),
      );
      await db.query('COMMIT');
      committed = true;
      return {
        documentId: saved.documentId,
        version: saved.version,
        sha256: archive.sha256,
        text: downloaded.snapshot.text,
      };
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return null;
    } finally {
      if (!committed) await db.query('ROLLBACK').catch(() => undefined);
      db.release();
    }
  }

  return async (scope, sources) => {
    const checks = new Map<string, VerificationSourceCheck>();
    const archived = new Map<string, ArchivedPage | null>();
    const signal = AbortSignal.timeout(35_000);
    for (const source of sources) {
      const key = sourceCheckKey(source);
      if (checks.has(key)) continue;
      const url = canonicalPublicWebUrl(source.url);
      let check: VerificationSourceCheck;
      if (!source.excerpt?.trim()) check = { status: 'excerpt_missing' };
      else if (!scope.projectId) check = { status: 'scope_unavailable' };
      else if (!url || signal.aborted || (!archived.has(url) && archived.size >= 8))
        check = { status: 'source_unavailable' };
      else {
        if (!archived.has(url)) archived.set(url, await archivePage(scope, url, signal));
        const page = archived.get(url);
        if (!page?.text.trim()) check = { status: 'source_unavailable' };
        else if (!quoteAppears(page.text, source.excerpt)) check = { status: 'excerpt_mismatch' };
        else {
          const { documentId, version, sha256 } = page;
          check = { status: 'verified', documentId, version, page: 1, sha256 };
        }
      }
      checks.set(key, check);
    }
    return checks;
  };
}
