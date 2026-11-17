import { sql } from 'drizzle-orm';
import {
  boolean,
  bigint,
  check,
  index,
  integer,
  doublePrecision,
  foreignKey,
  jsonb,
  numeric,
  pgEnum,
  pgSequence,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';

export const userStatus = pgEnum('app_user_status', ['active', 'disabled']);
export const userRole = pgEnum('app_role', ['RA', 'RB', 'GM', 'SALES', 'TECH']);
export const scopeType = pgEnum('role_scope_type', ['global', 'project', 'own']);
export const auditActorKind = pgEnum('audit_actor_kind', ['browser', 'agent', 'system']);
export const legalEntityType = pgEnum('legal_entity_type', [
  'company',
  'affiliate',
  'agent',
  'importer',
  'external_manufacturer',
]);
export const entityRoleType = pgEnum('entity_role_type', [
  'applicant',
  'manufacturer',
  'holder',
  'importer',
  'us_agent',
]);

const timestamps = () => ({
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const appUser = pgTable(
  'app_user',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    username: varchar('username', { length: 80 }).notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    displayName: varchar('display_name', { length: 120 }).notNull(),
    status: userStatus('status').notNull().default('active'),
    isDevelopment: boolean('is_development').notNull().default(false),
    ...timestamps(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    check('app_user_username_format', sql`${table.username} ~ '^[a-z0-9][a-z0-9_.@-]{1,79}$'`),
    check('app_user_password_hash_format', sql`${table.passwordHash} LIKE '$argon2id$%'`),
    check('app_user_display_name_not_blank', sql`length(btrim(${table.displayName})) > 0`),
    check('app_user_version_positive', sql`${table.version} > 0`),
  ],
);

export const roleBinding = pgTable(
  'role_binding',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'restrict' }),
    role: userRole('role').notNull(),
    scopeType: scopeType('scope_type').notNull(),
    scopeId: uuid('scope_id'),
    ...timestamps(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    unique('role_binding_identity_unique')
      .on(table.userId, table.role, table.scopeType, table.scopeId)
      .nullsNotDistinct(),
    check(
      'role_binding_scope_consistent',
      sql`(${table.scopeType} = 'project' AND ${table.scopeId} IS NOT NULL) OR (${table.scopeType} IN ('global', 'own') AND ${table.scopeId} IS NULL)`,
    ),
    check('role_binding_version_positive', sql`${table.version} > 0`),
    index('role_binding_user_idx').on(table.userId),
  ],
);

export const webSession = pgTable(
  'web_session',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
    csrfTokenHash: varchar('csrf_token_hash', { length: 64 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    unique('web_session_actor_unique').on(table.id, table.userId),
    check('web_session_token_hash_format', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check('web_session_csrf_hash_format', sql`${table.csrfTokenHash} ~ '^[0-9a-f]{64}$'`),
    check('web_session_expiry_order', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'web_session_revocation_order',
      sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt}`,
    ),
    index('web_session_user_idx').on(table.userId),
    index('web_session_expiry_idx').on(table.expiresAt),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actorUserId: uuid('actor_user_id').references(() => appUser.id, { onDelete: 'restrict' }),
    actorKind: auditActorKind('actor_kind').notNull(),
    action: varchar('action', { length: 120 }).notNull(),
    targetType: varchar('target_type', { length: 80 }).notNull(),
    targetId: varchar('target_id', { length: 255 }).notNull(),
    beforeHash: varchar('before_hash', { length: 64 }),
    afterHash: varchar('after_hash', { length: 64 }),
    ...timestamps(),
  },
  (table) => [
    check(
      'audit_log_actor_required',
      sql`${table.actorKind} = 'system' OR ${table.actorUserId} IS NOT NULL`,
    ),
    check('audit_log_action_not_blank', sql`length(btrim(${table.action})) > 0`),
    check('audit_log_target_type_not_blank', sql`length(btrim(${table.targetType})) > 0`),
    check('audit_log_target_id_not_blank', sql`length(btrim(${table.targetId})) > 0`),
    check(
      'audit_log_before_hash_format',
      sql`${table.beforeHash} IS NULL OR ${table.beforeHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'audit_log_after_hash_format',
      sql`${table.afterHash} IS NULL OR ${table.afterHash} ~ '^[0-9a-f]{64}$'`,
    ),
    index('audit_log_actor_time_idx').on(table.actorUserId, table.createdAt),
    index('audit_log_target_time_idx').on(table.targetType, table.targetId, table.createdAt),
  ],
);

export const legalEntity = pgTable(
  'legal_entity',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    address: text('address').notNull(),
    country: varchar('country', { length: 2 }).notNull(),
    type: legalEntityType('type').notNull(),
    ...timestamps(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    check('legal_entity_name_not_blank', sql`length(btrim(${table.name})) > 0`),
    check('legal_entity_address_not_blank', sql`length(btrim(${table.address})) > 0`),
    check('legal_entity_country_format', sql`${table.country} ~ '^[A-Z]{2}$'`),
    check('legal_entity_version_positive', sql`${table.version} > 0`),
    index('legal_entity_name_idx').on(table.name),
  ],
);

export const entityRole = pgTable(
  'entity_role',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => legalEntity.id, { onDelete: 'restrict' }),
    market: varchar('market', { length: 16 }).notNull(),
    role: entityRoleType('role').notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }),
    validUntil: timestamp('valid_until', { withTimezone: true }),
    source: text('source').notNull(),
    ...timestamps(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    unique('entity_role_identity_unique')
      .on(table.entityId, table.market, table.role, table.validFrom)
      .nullsNotDistinct(),
    check('entity_role_market_format', sql`${table.market} ~ '^[A-Z][A-Z0-9_-]{1,15}$'`),
    check(
      'entity_role_validity_order',
      sql`${table.validFrom} IS NULL OR ${table.validUntil} IS NULL OR ${table.validUntil} >= ${table.validFrom}`,
    ),
    check('entity_role_source_not_blank', sql`length(btrim(${table.source})) > 0`),
    check('entity_role_version_positive', sql`${table.version} > 0`),
    index('entity_role_entity_idx').on(table.entityId),
  ],
);

export const modelStatus = pgEnum('model_status', ['active', 'retired']);
export const certProjectType = pgEnum('cert_project_type', ['registration', 'maintenance']);
export const certMarket = pgEnum('cert_market', ['US', 'CA', 'US_CA']);
export const certProjectStatus = pgEnum('cert_project_status', [
  'preparing',
  'submitted',
  'under_review',
  'deficiency',
  'approved',
  'rejected',
  'closed',
  'cancelled',
]);
export const goalStatus = pgEnum('goal_status', [
  'active',
  'waiting_materials',
  'waiting_external',
  'waiting_decision',
  'pending_review',
  'human_controlled',
  'paused',
  'completed',
  'cancelled',
]);
export const contactChannel = pgEnum('contact_channel', ['local_test']);
export const submissionSnapshotKind = pgEnum('submission_snapshot_kind', [
  'approved_review',
  'rehearsal',
  'submission',
]);
export const certProjectCodeSequence = pgSequence('cert_project_code_seq', {
  startWith: 1,
  minValue: 1,
  cycle: false,
});

export const product = pgTable(
  'product',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    code: varchar('code', { length: 32 }).notNull().unique(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description').notNull().default(''),
    createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'restrict' }),
    ...timestamps(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    check('product_code_format', sql`${table.code} ~ '^[A-Z0-9][A-Z0-9-]{1,31}$'`),
    check('product_name_not_blank', sql`length(btrim(${table.name})) > 0`),
    check('product_version_positive', sql`${table.version} > 0`),
  ],
);

export const model = pgTable(
  'model',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    productId: uuid('product_id')
      .notNull()
      .references(() => product.id, { onDelete: 'restrict' }),
    code: varchar('code', { length: 32 }).notNull().unique(),
    name: varchar('name', { length: 255 }).notNull().default(''),
    udiDi: varchar('udi_di', { length: 128 }),
    upc: varchar('upc', { length: 12 }),
    upcNote: text('upc_note'),
    packaging: text('packaging'),
    researchProjectRef: varchar('research_project_ref', { length: 120 }),
    status: modelStatus('status').notNull().default('active'),
    source: text('source').notNull(),
    createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'restrict' }),
    ...timestamps(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    check('model_code_format', sql`${table.code} ~ '^[A-Z0-9][A-Z0-9.-]{1,31}$'`),
    check('model_upc_format', sql`${table.upc} IS NULL OR ${table.upc} ~ '^[0-9]{12}$'`),
    check('model_source_not_blank', sql`length(btrim(${table.source})) > 0`),
    check('model_version_positive', sql`${table.version} > 0`),
    index('model_product_idx').on(table.productId),
  ],
);

export const certProject = pgTable(
  'cert_project',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // format 的宽度是最小宽度；编号超过四位时保留全部数字，不截断回已用编号。
    code: varchar('code', { length: 32 })
      .notNull()
      .unique()
      .default(sql`replace(format('C%4s', nextval('public.cert_project_code_seq')), ' ', '0')`),
    name: varchar('name', { length: 255 }).notNull(),
    developmentSeedKey: varchar('development_seed_key', { length: 80 }).unique(),
    projectType: certProjectType('project_type').notNull().default('registration'),
    market: certMarket('market').notNull(),
    pathway: varchar('pathway', { length: 255 }).notNull(),
    modelId: uuid('model_id').references(() => model.id, { onDelete: 'restrict' }),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'restrict' }),
    reviewerUserId: uuid('reviewer_user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'restrict' }),
    applicantEntityId: uuid('applicant_entity_id').references(() => legalEntity.id, {
      onDelete: 'restrict',
    }),
    holderEntityId: uuid('holder_entity_id').references(() => legalEntity.id, {
      onDelete: 'restrict',
    }),
    targetAt: timestamp('target_at', { withTimezone: true }),
    jurisdictionTz: varchar('jurisdiction_tz', { length: 100 })
      .notNull()
      .default('America/New_York'),
    status: certProjectStatus('status').notNull().default('preparing'),
    submissionNumber: varchar('submission_number', { length: 255 }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    nextAction: text('next_action'),
    note: text('note').notNull().default(''),
    createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'restrict' }),
    ...timestamps(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    check('cert_project_code_format', sql`${table.code} ~ '^C[0-9]{4,}$'`),
    check('cert_project_name_not_blank', sql`length(btrim(${table.name})) > 0`),
    check('cert_project_pathway_not_blank', sql`length(btrim(${table.pathway})) > 0`),
    check('cert_project_timezone_not_blank', sql`length(btrim(${table.jurisdictionTz})) > 0`),
    check(
      'cert_project_owner_reviewer_distinct',
      sql`${table.ownerUserId} <> ${table.reviewerUserId}`,
    ),
    check(
      'cert_project_submission_dates_order',
      sql`${table.submittedAt} IS NULL OR ${table.acceptedAt} IS NULL OR ${table.acceptedAt} >= ${table.submittedAt}`,
    ),
    check('cert_project_version_positive', sql`${table.version} > 0`),
    index('cert_project_model_idx').on(table.modelId),
    index('cert_project_owner_idx').on(table.ownerUserId),
    index('cert_project_reviewer_idx').on(table.reviewerUserId),
  ],
);

export const goal = pgTable(
  'goal',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => certProject.id, { onDelete: 'restrict' }),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'restrict' }),
    title: varchar('title', { length: 255 }).notNull(),
    acceptanceCriteria: text('acceptance_criteria').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }),
    budgetUsd: numeric('budget_usd', { precision: 12, scale: 6 }).notNull().default('10'),
    status: goalStatus('status').notNull().default('active'),
    directionVersion: integer('direction_version').notNull().default(1),
    outboundPaused: boolean('outbound_paused').notNull().default(false),
    createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'restrict' }),
    ...timestamps(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    check('goal_title_not_blank', sql`length(btrim(${table.title})) > 0`),
    unique('goal_id_project_unique').on(table.id, table.projectId),
    check('goal_acceptance_not_blank', sql`length(btrim(${table.acceptanceCriteria})) > 0`),
    check(
      'goal_budget_nonnegative_finite',
      sql`${table.budgetUsd} >= 0 AND ${table.budgetUsd} < 'Infinity'::numeric`,
    ),
    check('goal_direction_version_positive', sql`${table.directionVersion} > 0`),
    check('goal_version_positive', sql`${table.version} > 0`),
    index('goal_project_idx').on(table.projectId),
    index('goal_owner_idx').on(table.ownerUserId),
  ],
);

export const contact = pgTable(
  'contact',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => certProject.id, { onDelete: 'restrict' }),
    name: varchar('name', { length: 120 }).notNull(),
    channel: contactChannel('channel').notNull().default('local_test'),
    address: varchar('address', { length: 255 }).notNull(),
    active: boolean('active').notNull().default(true),
    source: text('source').notNull(),
    createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'restrict' }),
    ...timestamps(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    unique('contact_project_channel_address_unique').on(
      table.projectId,
      table.channel,
      table.address,
    ),
    unique('contact_id_project_unique').on(table.id, table.projectId),
    check('contact_name_not_blank', sql`length(btrim(${table.name})) > 0`),
    check(
      'contact_address_format',
      sql`length(btrim(${table.address})) > 0 AND ${table.address} !~ '[[:cntrl:]]'`,
    ),
    check('contact_source_not_blank', sql`length(btrim(${table.source})) > 0`),
    check('contact_version_positive', sql`${table.version} > 0`),
    index('contact_project_idx').on(table.projectId),
  ],
);

export const submissionSnapshot = pgTable(
  'submission_snapshot',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => certProject.id, { onDelete: 'restrict' }),
    sequence: integer('sequence').notNull(),
    kind: submissionSnapshotKind('kind').notNull(),
    fileManifest: jsonb('file_manifest').$type<unknown[]>().notNull(),
    manifestSha256: varchar('manifest_sha256', { length: 64 }).notNull(),
    workspaceVersionId: uuid('workspace_version_id'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id, { onDelete: 'restrict' }),
    ...timestamps(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique('submission_snapshot_project_sequence_unique').on(table.projectId, table.sequence),
    foreignKey({
      name: 'submission_snapshot_workspace_project_fk',
      columns: [table.projectId, table.workspaceVersionId],
      foreignColumns: [workspaceVersion.projectId, workspaceVersion.id],
    }).onDelete('restrict'),
    check('submission_snapshot_sequence_positive', sql`${table.sequence} > 0`),
    check('submission_snapshot_manifest_array', sql`jsonb_typeof(${table.fileManifest}) = 'array'`),
    check('submission_snapshot_hash_format', sql`${table.manifestSha256} ~ '^[0-9a-f]{64}$'`),
    index('submission_snapshot_project_idx').on(table.projectId),
  ],
);

export const documentDataLevel = pgEnum('document_data_level', [
  'public',
  'internal',
  'confidential',
]);
export const documentAuthorType = pgEnum('document_author_type', ['ai', 'human', 'external']);
export const documentContentKind = pgEnum('document_content_kind', ['parsed_text', 'original']);
export const documentPageMethod = pgEnum('document_page_method', ['text', 'ocr', 'docx']);
export const documentLocatorKind = pgEnum('document_locator_kind', [
  'physical_page',
  'extraction_unit',
]);

export const document = pgTable(
  'document',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => certProject.id, { onDelete: 'restrict' }),
    sourceKey: varchar('source_key', { length: 128 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    sourcePath: varchar('source_path', { length: 2048 }).notNull(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'restrict' }),
    importedBy: uuid('imported_by').references(() => appUser.id, { onDelete: 'restrict' }),
    voided: boolean('voided').notNull().default(false),
    voidReason: text('void_reason'),
    ...timestamps(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    unique('document_project_source_unique').on(table.projectId, table.sourceKey),
    check('document_source_key_not_blank', sql`length(btrim(${table.sourceKey})) > 0`),
    check('document_name_not_blank', sql`length(btrim(${table.name})) > 0`),
    check('document_source_path_not_blank', sql`length(btrim(${table.sourcePath})) > 0`),
    check(
      'document_void_reason_consistent',
      sql`(NOT ${table.voided} AND ${table.voidReason} IS NULL) OR (${table.voided} AND ${table.voidReason} IS NOT NULL AND length(btrim(${table.voidReason})) > 0)`,
    ),
    check('document_version_positive', sql`${table.version} > 0`),
    index('document_project_idx').on(table.projectId),
    index('document_owner_idx').on(table.ownerUserId),
  ],
);

export const documentVersion = pgTable(
  'document_version',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => document.id, { onDelete: 'restrict' }),
    versionNo: integer('version_no').notNull(),
    sourceSnapshot: varchar('source_snapshot', { length: 64 }).notNull(),
    originalSha256: varchar('original_sha256', { length: 64 }),
    contentSha256: varchar('content_sha256', { length: 64 }).notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    mediaType: varchar('media_type', { length: 255 }).notNull(),
    contentKind: documentContentKind('content_kind').notNull(),
    dataLevel: documentDataLevel('data_level').notNull(),
    authorType: documentAuthorType('author_type').notNull(),
    importedBy: uuid('imported_by').references(() => appUser.id, { onDelete: 'restrict' }),
    sourceMetadata: jsonb('source_metadata').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps(),
  },
  (table) => [
    unique('document_version_number_unique').on(table.documentId, table.versionNo),
    unique('document_version_snapshot_unique').on(table.documentId, table.sourceSnapshot),
    check('document_version_number_positive', sql`${table.versionNo} > 0`),
    check('document_version_snapshot_hash_format', sql`${table.sourceSnapshot} ~ '^[0-9a-f]{64}$'`),
    check(
      'document_version_original_hash_format',
      sql`${table.originalSha256} IS NULL OR ${table.originalSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check('document_version_content_hash_format', sql`${table.contentSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'document_version_size_safe',
      sql`${table.byteSize} >= 0 AND ${table.byteSize} <= 9007199254740991`,
    ),
    check('document_version_media_type_not_blank', sql`length(btrim(${table.mediaType})) > 0`),
    check(
      'document_version_source_metadata_object',
      sql`jsonb_typeof(${table.sourceMetadata}) = 'object'`,
    ),
    index('document_version_document_idx').on(table.documentId),
    index('document_version_content_idx').on(table.contentSha256),
  ],
);

export const documentPage = pgTable(
  'document_page',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    versionId: uuid('version_id')
      .notNull()
      .references(() => documentVersion.id, { onDelete: 'restrict' }),
    pageNumber: integer('page_number').notNull(),
    text: text('text').notNull(),
    method: documentPageMethod('method').notNull(),
    locatorKind: documentLocatorKind('locator_kind').notNull(),
    ocrScore: doublePrecision('ocr_score'),
    isPlaceholder: boolean('is_placeholder').notNull().default(false),
    ...timestamps(),
  },
  (table) => [
    unique('document_page_number_unique').on(table.versionId, table.pageNumber),
    check('document_page_number_positive', sql`${table.pageNumber} > 0`),
    check('document_page_text_limit', sql`length(${table.text}) <= 1000000`),
    check(
      'document_page_ocr_score_range',
      sql`${table.ocrScore} IS NULL OR (${table.ocrScore} >= 0 AND ${table.ocrScore} <= 1)`,
    ),
    index('document_page_version_idx').on(table.versionId),
  ],
);

export const conversationMode = pgEnum('conversation_mode', ['read_only', 'execute']);
export const conversationStatus = pgEnum('conversation_status', ['active', 'archived']);
export const workspaceAuthorType = pgEnum('workspace_author_type', ['human', 'ai', 'system']);

export const conversation = pgTable(
  'conversation',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: uuid('project_id').references(() => certProject.id, { onDelete: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'restrict' }),
    title: varchar('title', { length: 255 }).notNull(),
    mode: conversationMode('mode').notNull().default('execute'),
    maxDataLevel: documentDataLevel('max_data_level').notNull().default('internal'),
    status: conversationStatus('status').notNull().default('active'),
    goalId: uuid('goal_id'),
    ...timestamps(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    unique('conversation_owner_project_unique').on(table.id, table.userId, table.projectId),
    unique('conversation_owner_unique').on(table.id, table.userId),
    foreignKey({
      name: 'conversation_goal_project_fk',
      columns: [table.goalId, table.projectId],
      foreignColumns: [goal.id, goal.projectId],
    }).onDelete('restrict'),
    check(
      'conversation_goal_requires_project',
      sql`${table.goalId} IS NULL OR ${table.projectId} IS NOT NULL`,
    ),
    check('conversation_title_not_blank', sql`length(btrim(${table.title})) > 0`),
    check(
      'conversation_data_level_internal',
      sql`${table.maxDataLevel} IN ('internal', 'confidential')`,
    ),
    check('conversation_version_positive', sql`${table.version} > 0`),
    index('conversation_user_project_idx').on(table.userId, table.projectId),
  ],
);

export const workspace = pgTable(
  'workspace',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: uuid('project_id')
      .notNull()
      .unique()
      .references(() => certProject.id, { onDelete: 'restrict' }),
    currentVersionId: uuid('current_version_id'),
    dataLevel: documentDataLevel('data_level').notNull().default('internal'),
    ...timestamps(),
    version: integer('version').notNull().default(1),
  },
  (table): PgTableExtraConfigValue[] => [
    unique('workspace_id_project_unique').on(table.id, table.projectId),
    foreignKey({
      name: 'workspace_current_version_fk',
      columns: [table.id, table.currentVersionId],
      foreignColumns: [workspaceVersion.workspaceId, workspaceVersion.id],
    }).onDelete('restrict'),
    check('workspace_data_level_internal', sql`${table.dataLevel} IN ('internal', 'confidential')`),
    check('workspace_version_positive', sql`${table.version} > 0`),
  ],
);

export const workspaceVersion = pgTable(
  'workspace_version',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    number: integer('number').notNull(),
    parentVersionId: uuid('parent_version_id'),
    authorUserId: uuid('author_user_id').references(() => appUser.id, { onDelete: 'restrict' }),
    authorType: workspaceAuthorType('author_type').notNull(),
    summary: text('summary').notNull(),
    dataLevel: documentDataLevel('data_level').notNull(),
    ...timestamps(),
  },
  (table): PgTableExtraConfigValue[] => [
    unique('workspace_version_identity_unique').on(table.workspaceId, table.id),
    unique('workspace_version_project_unique').on(table.projectId, table.id),
    unique('workspace_version_number_unique').on(table.workspaceId, table.number),
    foreignKey({
      name: 'workspace_version_workspace_project_fk',
      columns: [table.workspaceId, table.projectId],
      foreignColumns: [workspace.id, workspace.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workspace_version_parent_workspace_fk',
      columns: [table.workspaceId, table.parentVersionId],
      foreignColumns: [table.workspaceId, table.id],
    }).onDelete('restrict'),
    check('workspace_version_number_positive', sql`${table.number} > 0`),
    check(
      'workspace_version_parent_not_self',
      sql`${table.parentVersionId} IS NULL OR ${table.parentVersionId} <> ${table.id}`,
    ),
    check('workspace_version_summary_not_blank', sql`length(btrim(${table.summary})) > 0`),
    check(
      'workspace_version_author_present',
      sql`${table.authorType} = 'system' OR ${table.authorUserId} IS NOT NULL`,
    ),
    check(
      'workspace_version_data_level_internal',
      sql`${table.dataLevel} IN ('internal', 'confidential')`,
    ),
  ],
);

export const workspaceFile = pgTable(
  'workspace_file',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    versionId: uuid('version_id')
      .notNull()
      .references(() => workspaceVersion.id, { onDelete: 'restrict' }),
    path: varchar('path', { length: 512 }).notNull(),
    sha256: varchar('sha256', { length: 64 }).notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    dataLevel: documentDataLevel('data_level').notNull(),
    mediaType: varchar('media_type', { length: 255 }).notNull(),
    ...timestamps(),
  },
  (table) => [
    unique('workspace_file_path_unique').on(table.versionId, table.path),
    check(
      'workspace_file_path_nfc',
      sql`length(btrim(${table.path})) > 0 AND ${table.path} = normalize(${table.path}, NFC)`,
    ),
    check('workspace_file_hash_format', sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'workspace_file_size_safe',
      sql`${table.byteSize} >= 0 AND ${table.byteSize} <= 9007199254740991`,
    ),
    check('workspace_file_media_type_not_blank', sql`length(btrim(${table.mediaType})) > 0`),
    index('workspace_file_version_idx').on(table.versionId),
  ],
);

export const workspaceDraft = pgTable(
  'workspace_draft',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    projectId: uuid('project_id').notNull(),
    conversationId: uuid('conversation_id').notNull().unique(),
    ownerUserId: uuid('owner_user_id').notNull(),
    baseVersionId: uuid('base_version_id').notNull(),
    dataLevel: documentDataLevel('data_level').notNull().default('internal'),
    ...timestamps(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    foreignKey({
      name: 'workspace_draft_workspace_project_fk',
      columns: [table.workspaceId, table.projectId],
      foreignColumns: [workspace.id, workspace.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workspace_draft_conversation_owner_project_fk',
      columns: [table.conversationId, table.ownerUserId, table.projectId],
      foreignColumns: [conversation.id, conversation.userId, conversation.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'workspace_draft_base_version_fk',
      columns: [table.workspaceId, table.baseVersionId],
      foreignColumns: [workspaceVersion.workspaceId, workspaceVersion.id],
    }).onDelete('restrict'),
    check(
      'workspace_draft_data_level_internal',
      sql`${table.dataLevel} IN ('internal', 'confidential')`,
    ),
    check('workspace_draft_version_positive', sql`${table.version} > 0`),
    index('workspace_draft_owner_idx').on(table.ownerUserId),
  ],
);

export const workspaceDraftFile = pgTable(
  'workspace_draft_file',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    draftId: uuid('draft_id')
      .notNull()
      .references(() => workspaceDraft.id, { onDelete: 'restrict' }),
    path: varchar('path', { length: 512 }).notNull(),
    sha256: varchar('sha256', { length: 64 }),
    byteSize: bigint('byte_size', { mode: 'number' }),
    dataLevel: documentDataLevel('data_level').notNull(),
    mediaType: varchar('media_type', { length: 255 }).notNull(),
    isDeleted: boolean('is_deleted').notNull().default(false),
    ...timestamps(),
  },
  (table) => [
    unique('workspace_draft_file_path_unique').on(table.draftId, table.path),
    check(
      'workspace_draft_file_path_nfc',
      sql`length(btrim(${table.path})) > 0 AND ${table.path} = normalize(${table.path}, NFC)`,
    ),
    check(
      'workspace_draft_file_tombstone',
      sql`(${table.isDeleted} AND ${table.sha256} IS NULL AND ${table.byteSize} IS NULL) OR (NOT ${table.isDeleted} AND ${table.sha256} IS NOT NULL AND ${table.byteSize} IS NOT NULL)`,
    ),
    check(
      'workspace_draft_file_hash_format',
      sql`${table.sha256} IS NULL OR ${table.sha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'workspace_draft_file_size_safe',
      sql`${table.byteSize} IS NULL OR (${table.byteSize} >= 0 AND ${table.byteSize} <= 9007199254740991)`,
    ),
    check('workspace_draft_file_media_type_not_blank', sql`length(btrim(${table.mediaType})) > 0`),
    index('workspace_draft_file_draft_idx').on(table.draftId),
  ],
);

export const runTriggerType = pgEnum('run_trigger_type', ['conversation', 'wakeup', 'evaluation']);
export const runStatus = pgEnum('run_status', [
  'queued',
  'running',
  'waiting',
  'completed',
  'failed',
  'stopped',
  'budget_exhausted',
]);
export const toolEffect = pgEnum('tool_effect', [
  'read',
  'reversible_write',
  'external',
  'irreversible',
]);
export const toolInvocationStatus = pgEnum('tool_invocation_status', [
  'started',
  'completed',
  'denied',
  'failed',
]);
export const toolInvocationOperation = pgEnum('tool_invocation_operation', ['execute', 'undo']);
export const undoRecordStatus = pgEnum('undo_record_status', ['pending', 'available', 'undone']);

export const run = pgTable(
  'run',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id').notNull(),
    userId: uuid('user_id').notNull(),
    projectId: uuid('project_id'),
    goalId: uuid('goal_id'),
    directionVersion: integer('direction_version').notNull().default(1),
    triggerType: runTriggerType('trigger_type').notNull().default('conversation'),
    status: runStatus('status').notNull().default('queued'),
    maxDataLevel: documentDataLevel('max_data_level').notNull().default('internal'),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    unique('run_conversation_user_unique').on(table.id, table.conversationId, table.userId),
    unique('run_proposal_context_unique').on(
      table.id,
      table.conversationId,
      table.userId,
      table.projectId,
      table.goalId,
    ),
    foreignKey({
      name: 'run_conversation_owner_fk',
      columns: [table.conversationId, table.userId],
      foreignColumns: [conversation.id, conversation.userId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'run_conversation_owner_project_fk',
      columns: [table.conversationId, table.userId, table.projectId],
      foreignColumns: [conversation.id, conversation.userId, conversation.projectId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'run_goal_project_fk',
      columns: [table.goalId, table.projectId],
      foreignColumns: [goal.id, goal.projectId],
    }).onDelete('restrict'),
    check(
      'run_goal_requires_project',
      sql`${table.goalId} IS NULL OR ${table.projectId} IS NOT NULL`,
    ),
    check('run_direction_version_positive', sql`${table.directionVersion} > 0`),
    check('run_data_level_internal', sql`${table.maxDataLevel} IN ('internal', 'confidential')`),
    check(
      'run_finished_time_order',
      sql`${table.finishedAt} IS NULL OR ${table.finishedAt} >= ${table.createdAt}`,
    ),
    check('run_version_positive', sql`${table.version} > 0`),
    index('run_conversation_idx').on(table.conversationId),
    index('run_user_status_idx').on(table.userId, table.status),
  ],
);

export const toolInvocation = pgTable(
  'tool_invocation',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    runId: uuid('run_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    userId: uuid('user_id').notNull(),
    callId: varchar('call_id', { length: 128 }).notNull(),
    toolName: varchar('tool_name', { length: 64 }).notNull(),
    toolVersion: varchar('tool_version', { length: 128 }).notNull(),
    argumentsHash: varchar('arguments_hash', { length: 64 }).notNull(),
    effect: toolEffect('effect').notNull(),
    operation: toolInvocationOperation('operation').notNull().default('execute'),
    status: toolInvocationStatus('status').notNull().default('started'),
    dataLevel: documentDataLevel('data_level').notNull().default('internal'),
    ...timestamps(),
  },
  (table) => [
    unique('tool_invocation_call_unique').on(table.runId, table.callId),
    unique('tool_invocation_owner_unique').on(table.id, table.conversationId, table.userId),
    unique('tool_invocation_run_owner_unique').on(
      table.id,
      table.runId,
      table.conversationId,
      table.userId,
    ),
    foreignKey({
      name: 'tool_invocation_run_owner_fk',
      columns: [table.runId, table.conversationId, table.userId],
      foreignColumns: [run.id, run.conversationId, run.userId],
    }).onDelete('restrict'),
    check('tool_invocation_call_not_blank', sql`length(btrim(${table.callId})) > 0`),
    check('tool_invocation_name_not_blank', sql`length(btrim(${table.toolName})) > 0`),
    check('tool_invocation_version_not_blank', sql`length(btrim(${table.toolVersion})) > 0`),
    check('tool_invocation_arguments_hash_format', sql`${table.argumentsHash} ~ '^[0-9a-f]{64}$'`),
    index('tool_invocation_conversation_idx').on(table.conversationId),
  ],
);

// 工具正文属于受用户/对话授权的内容，不能进入 run_event 或元数据日志。
export const conversationToolResult = pgTable(
  'conversation_tool_result',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    invocationId: uuid('invocation_id').notNull().unique(),
    conversationId: uuid('conversation_id').notNull(),
    userId: uuid('user_id').notNull(),
    contentJson: jsonb('content_json').notNull(),
    dataLevel: documentDataLevel('data_level').notNull(),
    ...timestamps(),
  },
  (table) => [
    foreignKey({
      name: 'conversation_tool_result_invocation_owner_fk',
      columns: [table.invocationId, table.conversationId, table.userId],
      foreignColumns: [toolInvocation.id, toolInvocation.conversationId, toolInvocation.userId],
    }).onDelete('restrict'),
    index('conversation_tool_result_conversation_idx').on(table.conversationId),
  ],
);

export const undoRecord = pgTable(
  'undo_record',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    invocationId: uuid('invocation_id').notNull().unique(),
    runId: uuid('run_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    userId: uuid('user_id').notNull(),
    toolName: varchar('tool_name', { length: 64 }).notNull(),
    toolVersion: varchar('tool_version', { length: 128 }).notNull(),
    targetType: varchar('target_type', { length: 64 }).notNull(),
    targetId: uuid('target_id').notNull(),
    beforeState: jsonb('before_state').notNull(),
    beforeVersion: varchar('before_version', { length: 128 }),
    afterVersion: varchar('after_version', { length: 128 }),
    status: undoRecordStatus('status').notNull().default('pending'),
    undoneVersion: varchar('undone_version', { length: 128 }),
    undoneAt: timestamp('undone_at', { withTimezone: true }),
    undoneBy: uuid('undone_by').references(() => appUser.id, { onDelete: 'restrict' }),
    ...timestamps(),
  },
  (table) => [
    foreignKey({
      name: 'undo_record_invocation_run_owner_fk',
      columns: [table.invocationId, table.runId, table.conversationId, table.userId],
      foreignColumns: [
        toolInvocation.id,
        toolInvocation.runId,
        toolInvocation.conversationId,
        toolInvocation.userId,
      ],
    }).onDelete('restrict'),
    check('undo_record_tool_name_not_blank', sql`length(btrim(${table.toolName})) > 0`),
    check('undo_record_tool_version_not_blank', sql`length(btrim(${table.toolVersion})) > 0`),
    check('undo_record_target_type_not_blank', sql`length(btrim(${table.targetType})) > 0`),
    check(
      'undo_record_before_version_not_blank',
      sql`${table.beforeVersion} IS NULL OR length(btrim(${table.beforeVersion})) > 0`,
    ),
    check(
      'undo_record_after_version_not_blank',
      sql`${table.afterVersion} IS NULL OR length(btrim(${table.afterVersion})) > 0`,
    ),
    check(
      'undo_record_undone_version_not_blank',
      sql`${table.undoneVersion} IS NULL OR length(btrim(${table.undoneVersion})) > 0`,
    ),
    check(
      'undo_record_state_consistent',
      sql`(${table.status} = 'pending' AND ${table.afterVersion} IS NULL AND ${table.undoneVersion} IS NULL AND ${table.undoneAt} IS NULL AND ${table.undoneBy} IS NULL) OR (${table.status} = 'available' AND ${table.afterVersion} IS NOT NULL AND ${table.undoneVersion} IS NULL AND ${table.undoneAt} IS NULL AND ${table.undoneBy} IS NULL) OR (${table.status} = 'undone' AND ${table.afterVersion} IS NOT NULL AND ${table.undoneVersion} IS NOT NULL AND ${table.undoneAt} IS NOT NULL AND ${table.undoneBy} IS NOT NULL)`,
    ),
    check(
      'undo_record_undone_time_order',
      sql`${table.undoneAt} IS NULL OR ${table.undoneAt} >= ${table.createdAt}`,
    ),
    index('undo_record_conversation_idx').on(table.conversationId),
  ],
);

export const proposalStatus = pgEnum('proposal_status', [
  'proposed',
  'approved',
  'executing',
  'done',
  'failed',
  'reconcile',
  'rejected',
  'expired',
]);
export const proposalDecisionAction = pgEnum('proposal_decision_action', ['approved', 'rejected']);
export const outboundMessageStatus = pgEnum('outbound_message_status', [
  'queued',
  'done',
  'failed',
  'reconcile',
  'cancelled',
]);

export const proposal = pgTable(
  'proposal',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    projectId: uuid('project_id').notNull(),
    goalId: uuid('goal_id').notNull(),
    conversationId: uuid('conversation_id').notNull(),
    runId: uuid('run_id').notNull(),
    invocationId: uuid('invocation_id').notNull().unique(),
    proposedBy: uuid('proposed_by').notNull(),
    contactId: uuid('contact_id').notNull(),
    recipientVersion: integer('recipient_version').notNull(),
    recipientName: varchar('recipient_name', { length: 120 }).notNull(),
    recipientAddress: varchar('recipient_address', { length: 255 }).notNull(),
    channel: contactChannel('channel').notNull().default('local_test'),
    subject: varchar('subject', { length: 200 }).notNull(),
    body: text('body').notNull(),
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    dataLevel: documentDataLevel('data_level').notNull().default('internal'),
    status: proposalStatus('status').notNull().default('proposed'),
    ...timestamps(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    unique('proposal_queue_context_unique').on(
      table.id,
      table.projectId,
      table.goalId,
      table.contactId,
    ),
    foreignKey({
      name: 'proposal_run_context_fk',
      columns: [table.runId, table.conversationId, table.proposedBy, table.projectId, table.goalId],
      foreignColumns: [run.id, run.conversationId, run.userId, run.projectId, run.goalId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'proposal_invocation_context_fk',
      columns: [table.invocationId, table.runId, table.conversationId, table.proposedBy],
      foreignColumns: [
        toolInvocation.id,
        toolInvocation.runId,
        toolInvocation.conversationId,
        toolInvocation.userId,
      ],
    }).onDelete('restrict'),
    foreignKey({
      name: 'proposal_contact_project_fk',
      columns: [table.contactId, table.projectId],
      foreignColumns: [contact.id, contact.projectId],
    }).onDelete('restrict'),
    check('proposal_recipient_version_positive', sql`${table.recipientVersion} > 0`),
    check('proposal_recipient_name_not_blank', sql`length(btrim(${table.recipientName})) > 0`),
    check(
      'proposal_recipient_address_not_blank',
      sql`length(btrim(${table.recipientAddress})) > 0`,
    ),
    check(
      'proposal_subject_not_blank',
      sql`length(btrim(${table.subject})) > 0 AND ${table.subject} !~ '[[:cntrl:]]'`,
    ),
    check(
      'proposal_body_limit',
      sql`length(btrim(${table.body})) > 0 AND length(${table.body}) <= 8000`,
    ),
    check('proposal_content_hash_format', sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
    check('proposal_data_level_internal', sql`${table.dataLevel} IN ('internal', 'confidential')`),
    check('proposal_version_positive', sql`${table.version} > 0`),
    index('proposal_project_status_idx').on(table.projectId, table.status),
    index('proposal_goal_idx').on(table.goalId),
  ],
);

export const decision = pgTable(
  'decision',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => proposal.id, { onDelete: 'restrict' }),
    actorUserId: uuid('actor_user_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    requestKey: uuid('request_key').notNull(),
    sourceVersion: integer('source_version').notNull(),
    action: proposalDecisionAction('action').notNull(),
    contentHash: varchar('content_hash', { length: 64 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('decision_actor_request_unique').on(table.actorUserId, table.requestKey),
    unique('decision_proposal_source_unique').on(table.proposalId, table.sourceVersion),
    unique('decision_proposal_identity_unique').on(table.id, table.proposalId),
    foreignKey({
      name: 'decision_browser_session_actor_fk',
      columns: [table.sessionId, table.actorUserId],
      foreignColumns: [webSession.id, webSession.userId],
    }).onDelete('restrict'),
    check('decision_source_version_positive', sql`${table.sourceVersion} > 0`),
    check('decision_content_hash_format', sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
    index('decision_proposal_idx').on(table.proposalId),
  ],
);

export const outboundMessage = pgTable(
  'outbound_message',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    proposalId: uuid('proposal_id').notNull(),
    decisionId: uuid('decision_id').notNull().unique(),
    goalId: uuid('goal_id').notNull(),
    projectId: uuid('project_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    approvedVersion: integer('approved_version').notNull(),
    channel: contactChannel('channel').notNull().default('local_test'),
    status: outboundMessageStatus('status').notNull().default('queued'),
    attempts: integer('attempts').notNull().default(0),
    lastReason: varchar('last_reason', { length: 500 }),
    receiptId: uuid('receipt_id'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    ...timestamps(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    foreignKey({
      name: 'outbound_message_proposal_context_fk',
      columns: [table.proposalId, table.projectId, table.goalId, table.contactId],
      foreignColumns: [proposal.id, proposal.projectId, proposal.goalId, proposal.contactId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'outbound_message_decision_proposal_fk',
      columns: [table.decisionId, table.proposalId],
      foreignColumns: [decision.id, decision.proposalId],
    }).onDelete('restrict'),
    check('outbound_message_approved_version_positive', sql`${table.approvedVersion} > 0`),
    check('outbound_message_attempts_nonnegative', sql`${table.attempts} >= 0`),
    check('outbound_message_version_positive', sql`${table.version} > 0`),
    check(
      'outbound_message_processed_time_order',
      sql`${table.processedAt} IS NULL OR ${table.processedAt} >= ${table.createdAt}`,
    ),
    check(
      'outbound_message_receipt_complete',
      sql`${table.receiptId} IS NULL OR ${table.processedAt} IS NOT NULL`,
    ),
    index('outbound_message_status_idx').on(table.status),
    index('outbound_message_goal_idx').on(table.goalId),
  ],
);
