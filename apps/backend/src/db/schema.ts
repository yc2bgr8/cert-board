import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
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
    createdBy: uuid('created_by').references(() => appUser.id, { onDelete: 'restrict' }),
    ...timestamps(),
    version: integer('version').notNull().default(1),
  },
  (table) => [
    check('goal_title_not_blank', sql`length(btrim(${table.title})) > 0`),
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
    createdBy: uuid('created_by')
      .notNull()
      .references(() => appUser.id, { onDelete: 'restrict' }),
    ...timestamps(),
  },
  (table) => [
    unique('submission_snapshot_project_sequence_unique').on(table.projectId, table.sequence),
    check('submission_snapshot_sequence_positive', sql`${table.sequence} > 0`),
    check('submission_snapshot_manifest_array', sql`jsonb_typeof(${table.fileManifest}) = 'array'`),
    check('submission_snapshot_hash_format', sql`${table.manifestSha256} ~ '^[0-9a-f]{64}$'`),
    index('submission_snapshot_project_idx').on(table.projectId),
  ],
);
