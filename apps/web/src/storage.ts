import type { AssertionDraft, StoredAssertionEnvelope } from "./domain.js";
import { STORAGE_VERSION } from "./domain.js";
import { validateAssertionCollection } from "./collection.js";

export function parseStoredAssertions(raw: string | null): AssertionDraft[] {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as Partial<StoredAssertionEnvelope>;
    if (parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.assertions)) return [];
    return structuredClone(validateAssertionCollection(parsed.assertions));
  } catch {
    return [];
  }
}

export function serializeAssertions(assertions: readonly AssertionDraft[]): string {
  const accepted = validateAssertionCollection(assertions);
  const envelope: StoredAssertionEnvelope = { version: STORAGE_VERSION, assertions: accepted };
  return JSON.stringify(envelope);
}
