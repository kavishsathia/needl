import type {
  AdapterConfig,
  AdapterResult,
  EvidenceLink,
  Provider,
  WebhookHeaders,
  WebhookRequest,
} from "./types.js";

const decoder = new TextDecoder("utf-8", { fatal: true });

export function header(headers: WebhookHeaders, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    return typeof value === "string" ? value : value?.[0];
  }
  return undefined;
}

export function rawText(rawBody: Uint8Array): string {
  return decoder.decode(rawBody);
}

export function parseJson(rawBody: Uint8Array): unknown {
  return JSON.parse(rawText(rawBody)) as unknown;
}

export function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function unixSeconds(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value * 1_000).toISOString()
    : undefined;
}

export function isEnabled(config: AdapterConfig, eventType: string): boolean {
  return config.enabledEvents === undefined || config.enabledEvents.includes(eventType);
}

export function mapKind(
  config: AdapterConfig,
  eventType: string,
  fallback: string,
): string {
  return config.kindMappings?.[eventType] ?? fallback;
}

export function receivedAt(request: WebhookRequest): string {
  return request.receivedAt.toISOString();
}

export function rejected(
  provider: Provider,
  reason: "unauthenticated" | "malformed" | "stale",
  message: string,
): AdapterResult {
  return { status: "rejected", provider, reason, message };
}

export function ignored(
  provider: Provider,
  request: WebhookRequest,
  reason: "unknown_event" | "not_subscribed" | "no_observation",
  eventType?: string,
  deliveryId?: string,
): AdapterResult {
  return {
    status: "ignored",
    provider,
    tenantId: request.tenantId,
    receivedAt: receivedAt(request),
    reason,
    ...(eventType === undefined ? {} : { eventType }),
    ...(deliveryId === undefined ? {} : { deliveryId }),
  };
}

export function absoluteLinks(
  candidates: readonly { readonly rel: string; readonly url: unknown }[],
): EvidenceLink[] {
  return candidates.flatMap(({ rel, url }) => {
    if (typeof url !== "string") return [];
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" || parsed.protocol === "http:" ? [{ rel, url }] : [];
    } catch {
      return [];
    }
  });
}

export function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
