import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
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
