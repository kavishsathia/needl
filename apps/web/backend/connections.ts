/**
 * Validates a signing secret pasted during setup and derives the adapter settings for it. Formats follow what each
 * provider issues, so an obviously wrong paste (for example a Stripe API key instead of its webhook secret) is caught
 * before any webhook arrives.
 */
export function connectionSettings(provider: string, rawSecret: string, mode?: string): { readonly secret: string; readonly config: Readonly<Record<string, unknown>> } {
  const secret = rawSecret.trim();
  const fail = (message: string): never => { throw Object.assign(new Error(message), { statusCode: 400 }); };
  if (secret.length < 8) fail("Paste the full signing secret");
  if (secret.length > 512 || /\s/.test(secret)) fail("A signing secret is a single value without spaces");
  switch (provider) {
    case "gitlab": {
      const authMode = mode === "secret-token" ? "secret-token" : "signing-token";
      if (authMode === "signing-token" && !secret.startsWith("whsec_")) fail("GitLab signing tokens start with whsec_. For a secret token you typed yourself, choose “Secret token”.");
      return { secret, config: { authMode } };
    }
    case "posthog": {
      if (mode === "shared-header") return { secret, config: { authentication: { mode: "shared-header", headerName: "authorization", prefix: "Bearer " } } };
      if (!secret.startsWith("whsec_")) fail("PostHog signing secrets start with whsec_. Without one, choose “Authorization header”.");
      return { secret, config: { authentication: { mode: "standard-webhooks" } } };
    }
    case "stripe":
      if (!secret.startsWith("whsec_")) fail("Stripe webhook signing secrets start with whsec_ (not the sk_ or pk_ API keys).");
      return { secret, config: {} };
    default:
      return { secret, config: {} };
  }
}
