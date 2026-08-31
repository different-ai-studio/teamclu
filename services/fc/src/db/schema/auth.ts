/**
 * The five Better-Auth tables (user/session/account/verification/jwks).
 *
 * FC no longer runs Better-Auth — GoTrue owns login. These declarations stay
 * because the tables themselves were deliberately NOT retired from the shared
 * saas-mono database, and because the migration set here is what bootstraps the
 * pglite test database, which still creates them.
 *
 * Source: @better-auth/core dist/db/get-tables.mjs (core tables) +
 *         better-auth dist/plugins/anonymous/schema.mjs (isAnonymous on user) +
 *         better-auth dist/plugins/jwt/schema.mjs + utils.mjs (jwks).
 *
 * Column JS property names MUST match Better-Auth's camelCase field names —
 * the drizzle adapter accesses schemaModel[fieldName] directly.
 * SQL column names use snake_case via the first string arg.
 */
import { pgTable, text, boolean, timestamp } from "drizzle-orm/pg-core";

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  // anonymous plugin
  isAnonymous: boolean("is_anonymous").default(false),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// JWT plugin — stores key pairs for signing JWTs.
// Runtime writes: id, publicKey, privateKey, createdAt, alg, crv?, expiresAt?
export const jwks = pgTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at").notNull(),
  alg: text("alg"),
  crv: text("crv"),
  expiresAt: timestamp("expires_at"),
});
