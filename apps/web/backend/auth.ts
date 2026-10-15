import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import type { DatabaseRuntime } from "./database.js";

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
  return {
    appName: "Needl",
    baseURL,
    secret,
    database: { db: runtime.db, type: runtime.type, casing: "snake" as const },
    emailAndPassword: { enabled: true, disableSignUp: !signupEnabled(environment), minPasswordLength: 12, maxPasswordLength: 128 },
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    trustedOrigins,
    rateLimit: {
      enabled: true, window: 60, max: 20, storage: "database" as const,
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
