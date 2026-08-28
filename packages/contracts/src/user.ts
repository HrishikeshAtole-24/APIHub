/**
 * Identity, favorites, collections and reviews
 * (report 5 FR-06/FR-07, 19, 31).
 */
import { z } from 'zod';

import { ApiSummarySchema } from './catalog';
import { IsoDateSchema, SlugSchema, UserRoleSchema } from './common';

// ── Identity ──────────────────────────────────────────────────

export const PublicUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: UserRoleSchema,
  avatarColor: z.string(),
  createdAt: IsoDateSchema,
});
export type PublicUser = z.infer<typeof PublicUserSchema>;

/**
 * Password policy. Length is the dominant factor in resisting offline cracking,
 * so a 12-character minimum is enforced instead of character-class rules, which
 * mostly push users toward predictable substitutions.
 */
export const PasswordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be at most 128 characters');

export const RegisterRequestSchema = z.object({
  email: z.string().email().max(254),
  name: z.string().min(1).max(80),
  password: PasswordSchema,
});
export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;

export const LoginRequestSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const SessionSchema = z.object({
  user: PublicUserSchema,
  expiresAt: IsoDateSchema,
});
export type Session = z.infer<typeof SessionSchema>;

// ── Favorites ─────────────────────────────────────────────────

export const FavoriteSchema = z.object({
  apiId: z.string(),
  api: ApiSummarySchema,
  createdAt: IsoDateSchema,
});
export type Favorite = z.infer<typeof FavoriteSchema>;

// ── Collections ───────────────────────────────────────────────

export const CollectionSchema = z.object({
  id: z.string(),
  slug: SlugSchema,
  name: z.string(),
  description: z.string().nullable(),
  isPublic: z.boolean(),
  itemCount: z.number().int().nonnegative(),
  /** Populated only on the detail endpoint. */
  items: z.array(ApiSummarySchema).optional(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type Collection = z.infer<typeof CollectionSchema>;

export const CreateCollectionSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  isPublic: z.boolean().default(false),
});
export type CreateCollection = z.infer<typeof CreateCollectionSchema>;

export const UpdateCollectionSchema = CreateCollectionSchema.partial();
export type UpdateCollection = z.infer<typeof UpdateCollectionSchema>;

// ── Reviews ───────────────────────────────────────────────────

/**
 * Multi-dimensional ratings (report Feature 6). Overall is required; the
 * sub-scores are optional so leaving a quick rating stays low-friction.
 */
export const ReviewRatingsSchema = z.object({
  overall: z.number().int().min(1).max(5),
  reliability: z.number().int().min(1).max(5).nullable().optional(),
  documentation: z.number().int().min(1).max(5).nullable().optional(),
  developerExperience: z.number().int().min(1).max(5).nullable().optional(),
  freeTier: z.number().int().min(1).max(5).nullable().optional(),
});
export type ReviewRatings = z.infer<typeof ReviewRatingsSchema>;

export const ReviewSchema = z.object({
  id: z.string(),
  apiId: z.string(),
  author: PublicUserSchema.pick({ id: true, name: true, avatarColor: true }),
  ratings: ReviewRatingsSchema,
  title: z.string().nullable(),
  body: z.string().nullable(),
  helpfulCount: z.number().int().nonnegative(),
  /** True when the requesting user wrote this review. */
  isOwn: z.boolean().optional(),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type Review = z.infer<typeof ReviewSchema>;

export const CreateReviewSchema = z.object({
  ratings: ReviewRatingsSchema,
  title: z.string().max(120).optional(),
  body: z.string().max(4000).optional(),
});
export type CreateReview = z.infer<typeof CreateReviewSchema>;

/** Aggregate shown on the API detail page. */
export const ReviewSummarySchema = z.object({
  average: z.number().min(0).max(5),
  count: z.number().int().nonnegative(),
  /** Star distribution, index 0 = 1 star. */
  distribution: z.array(z.number().int().nonnegative()).length(5),
  dimensions: z.object({
    reliability: z.number().min(0).max(5).nullable(),
    documentation: z.number().min(0).max(5).nullable(),
    developerExperience: z.number().min(0).max(5).nullable(),
    freeTier: z.number().min(0).max(5).nullable(),
  }),
});
export type ReviewSummary = z.infer<typeof ReviewSummarySchema>;
