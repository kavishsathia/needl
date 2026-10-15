import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import type { DatabaseRuntime } from "./database.js";

export function createAuthOptions(runtime: DatabaseRuntime, environment: NodeJS.ProcessEnv = process.env) {
  const baseURL = environment.BETTER_AUTH_URL ?? "http://127.0.0.1:4173";
  const secret = environment.BETTER_AUTH_SECRET ?? (environment.NODE_ENV === "production" ? undefined : "needl-local-development-secret-change-me-32-chars");
  if (secret === undefined || secret.length < 32) throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
  const trustedOrigins = (environment.NEEDL_TRUSTED_ORIGINS ?? `${baseURL},http://127.0.0.1:5173`)
    .split(",").map((value) => value.trim()).filter(Boolean);
  return {
    appName: "Needl",
    baseURL,
    secret,
    database: { db: runtime.db, type: runtime.type, casing: "snake" as const },
    emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128 },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    trustedOrigins,
    rateLimit: { enabled: true, window: 60, max: 20, storage: "database" as const },
    advanced: {
      cookiePrefix: "needl",
      useSecureCookies: environment.NODE_ENV === "production",
      disableCSRFCheck: false,
      disableOriginCheck: false,
      ipAddress: { ipAddressHeaders: ["x-needl-remote-ip"] },
    },
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
