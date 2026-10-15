import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { getAuthTables } from "better-auth/db";
import { getMigrations } from "better-auth/db/migration";
import type { DatabaseRuntime } from "./database.js";

const snakeCase = (name: string): string => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

/**
 * Auth tables use snake_case names. Better Auth gets a Kysely instance without the app's CamelCasePlugin plus an
 * explicit name mapping, so its migration introspection sees the same names its queries use. (Through the plugin,
 * queries wrote `created_at` while introspection was compared against `createdAt`, so every restart after the first
 * signup failed with UnsafeMigrationError.)
 */
function snakeCaseAuthSchema(options: Parameters<typeof getAuthTables>[0]) {
  return Object.fromEntries(Object.entries(getAuthTables(options)).map(([model, table]) => [model, {
    ...(snakeCase(table.modelName) === table.modelName ? {} : { modelName: snakeCase(table.modelName) }),
    fields: Object.fromEntries(Object.keys(table.fields).filter((field) => snakeCase(field) !== field).map((field) => [field, snakeCase(field)])),
  }])) as Record<"user" | "session" | "account" | "verification" | "rateLimit", { modelName?: string; fields: Record<string, string> }>;
}

export function signupEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.NODE_ENV !== "production" || signupAllowlist(environment).size > 0;
}

function signupAllowlist(environment: NodeJS.ProcessEnv): Set<string> {
  return new Set((environment.NEEDL_SIGNUP_ALLOWLIST ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean));
}

export function createAuthOptions(runtime: DatabaseRuntime, environment: NodeJS.ProcessEnv = process.env) {
  const baseURL = environment.BETTER_AUTH_URL ?? "http://127.0.0.1:4173";
  const secret = environment.BETTER_AUTH_SECRET ?? (environment.NODE_ENV === "production" ? undefined : "needl-local-development-secret-change-me-32-chars");
  if (secret === undefined || secret.length < 32) throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  const trustedOrigins = (environment.NEEDL_TRUSTED_ORIGINS ?? `${baseURL},http://127.0.0.1:5173`)
    .split(",").map((value) => value.trim()).filter(Boolean);
  const allowedEmails = signupAllowlist(environment);
  const database = { db: runtime.db.withoutPlugins(), type: runtime.type };
  const rateLimitStorage = { storage: "database" as const };
  const schema = snakeCaseAuthSchema({ database, rateLimit: { enabled: true, ...rateLimitStorage } });
  return {
    appName: "Needl",
    baseURL,
    secret,
    database,
    user: schema.user,
    account: schema.account,
    verification: schema.verification,
    emailAndPassword: { enabled: true, disableSignUp: !signupEnabled(environment), minPasswordLength: 12, maxPasswordLength: 128 },
    session: { ...schema.session, expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    trustedOrigins,
    rateLimit: {
      ...schema.rateLimit,
      enabled: true, window: 60, max: 20, ...rateLimitStorage,
      customRules: {
        "/sign-up/email": { window: 60, max: environment.NODE_ENV === "production" ? 3 : 100 },
        "/sign-in/email": { window: 10, max: environment.NODE_ENV === "production" ? 3 : 100 },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user: { email: string }) => {
            if (environment.NODE_ENV === "production" && !allowedEmails.has(user.email.toLowerCase())) {
              throw new APIError("FORBIDDEN", { message: "Account creation is not enabled for this email" });
            }
          },
        },
      },
    },
    advanced: {
      cookiePrefix: "needl",
      useSecureCookies: environment.NODE_ENV === "production",
      disableCSRFCheck: false,
      disableOriginCheck: false,
      ipAddress: { ipAddressHeaders: ["x-needl-remote-ip"] },
    },
    telemetry: { enabled: false },
  };
}

export function createAuth(runtime: DatabaseRuntime, environment: NodeJS.ProcessEnv = process.env) {
  const options = createAuthOptions(runtime, environment);
  return { auth: betterAuth(options), options };
}

export async function migrateAuthDatabase(options: ReturnType<typeof createAuthOptions>): Promise<void> {
  const plan = await getMigrations(options);
  await plan.runMigrations();
}

export type NeedlAuth = ReturnType<typeof createAuth>["auth"];
