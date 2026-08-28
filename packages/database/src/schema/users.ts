/**
 * Identity, sessions and user-owned content (report 19, 31).
 */
import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import { apis } from './catalog.js';

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    /** Stored lowercased; the unique index is what actually prevents duplicates. */
    email: text('email').notNull(),
    name: text('name').notNull(),
    /** Argon2id PHC string. Null for accounts created via an OAuth provider. */
    passwordHash: text('password_hash'),
    /** 'user' | 'moderator' | 'admin' */
    role: text('role').notNull().default('user'),
    avatarColor: text('avatar_color').notNull().default('hsl(220 65% 55%)'),
    /** Soft-delete marker; preserves authorship on reviews. */
    deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('users_email_idx').on(table.email)],
);

/**
 * Server-side sessions.
 *
 * The primary key is the HMAC of the session id, not the id itself, so a
 * database dump does not yield usable cookies (see security/tokens.ts).
 */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Truncated for privacy; used only to show "your active sessions". */
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('sessions_user_idx').on(table.userId),
    // Supports the expiry sweep.
    index('sessions_expires_idx').on(table.expiresAt),
  ],
);

// ── Favorites (report FR-06) ──────────────────────────────────

export const favorites = pgTable(
  'favorites',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    apiId: text('api_id')
      .notNull()
      .references(() => apis.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Composite PK is the uniqueness constraint the report asks for and also
    // the index for "is this API favorited by this user".
    primaryKey({ columns: [table.userId, table.apiId] }),
    index('favorites_user_time_idx').on(table.userId, table.createdAt.desc()),
    // Reverse lookup for the denormalised favorite count.
    index('favorites_api_idx').on(table.apiId),
  ],
);

// ── Collections (report FR-07) ────────────────────────────────

export const collections = pgTable(
  'collections',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    isPublic: boolean('is_public').notNull().default(false),
    itemCount: integer('item_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Slugs are unique per user, not globally, so two people can both have
    // a collection called "weather".
    uniqueIndex('collections_user_slug_idx').on(table.userId, table.slug),
    index('collections_public_idx').on(table.isPublic, table.updatedAt.desc()),
  ],
);

export const collectionItems = pgTable(
  'collection_items',
  {
    collectionId: text('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    apiId: text('api_id')
      .notNull()
      .references(() => apis.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.collectionId, table.apiId] }),
    index('collection_items_order_idx').on(table.collectionId, table.position),
  ],
);

// ── Reviews (report Feature 6) ────────────────────────────────

export const reviews = pgTable(
  'reviews',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    apiId: text('api_id')
      .notNull()
      .references(() => apis.id, { onDelete: 'cascade' }),

    ratingOverall: smallint('rating_overall').notNull(),
    ratingReliability: smallint('rating_reliability'),
    ratingDocumentation: smallint('rating_documentation'),
    ratingDeveloperExperience: smallint('rating_developer_experience'),
    ratingFreeTier: smallint('rating_free_tier'),

    title: text('title'),
    body: text('body'),
    helpfulCount: integer('helpful_count').notNull().default(0),

    /** Moderation state: 'published' | 'flagged' | 'removed'. */
    moderationStatus: text('moderation_status').notNull().default('published'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One review per user per API. Enforced by the database, not by app logic.
    uniqueIndex('reviews_user_api_idx').on(table.userId, table.apiId),
    // The report's prescribed index for an API's review feed.
    index('reviews_api_time_idx').on(table.apiId, table.createdAt.desc()),
  ],
);

/** "This review was helpful" votes, one per user per review. */
export const reviewVotes = pgTable(
  'review_votes',
  {
    reviewId: text('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.reviewId, table.userId] })],
);

// ── Relations ─────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
  favorites: many(favorites),
  collections: many(collections),
  reviews: many(reviews),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const favoritesRelations = relations(favorites, ({ one }) => ({
  user: one(users, { fields: [favorites.userId], references: [users.id] }),
  api: one(apis, { fields: [favorites.apiId], references: [apis.id] }),
}));

export const collectionsRelations = relations(collections, ({ one, many }) => ({
  user: one(users, { fields: [collections.userId], references: [users.id] }),
  items: many(collectionItems),
}));

export const collectionItemsRelations = relations(collectionItems, ({ one }) => ({
  collection: one(collections, {
    fields: [collectionItems.collectionId],
    references: [collections.id],
  }),
  api: one(apis, { fields: [collectionItems.apiId], references: [apis.id] }),
}));

export const reviewsRelations = relations(reviews, ({ one }) => ({
  user: one(users, { fields: [reviews.userId], references: [users.id] }),
  api: one(apis, { fields: [reviews.apiId], references: [apis.id] }),
}));

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type CollectionRow = typeof collections.$inferSelect;
export type ReviewRow = typeof reviews.$inferSelect;
