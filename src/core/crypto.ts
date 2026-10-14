import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function hmac(
  algorithm: string,
  secret: string | Uint8Array,
  data: string | Uint8Array,
  encoding: "hex" | "base64" = "hex",
): string {
  return createHmac(algorithm, secret).update(data).digest(encoding);
}

export function secureEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function anySecretMatches(
  secrets: readonly string[],
  received: string,
  expected: (secret: string) => string,
): boolean {
  let matched = false;
  for (const secret of secrets) {
    // Do not return early: exercise every configured rotation key.
    matched = secureEqual(expected(secret), received) || matched;
  }
  return matched;
}

export function stableId(parts: readonly (string | undefined)[]): string {
  const digest = createHash("sha256")
    .update(parts.map((part) => part ?? "").join("\u0000"))
    .digest("hex");
  return `evt_${digest}`;
}

