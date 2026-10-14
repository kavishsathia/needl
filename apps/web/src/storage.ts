import type { AssertionDraft, StoredAssertionEnvelope } from "./domain.js";
import { STORAGE_VERSION } from "./domain.js";
import { validateAssertionCollection, validateProductAssertionCollection } from "./collection.js";
import { productSafetyIssue } from "./safety.js";

export function parseStoredAssertions(raw: string | null): AssertionDraft[] {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as Partial<StoredAssertionEnvelope>;
    if (parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.assertions)) return [];
    const validated = validateAssertionCollection(parsed.assertions);
    const migrated = validated.map((draft): AssertionDraft => {
      const reviewReason = productSafetyIssue(draft.definition);
      return reviewReason === undefined ? draft : { ...draft, status: "needs-review", reviewReason };
    });
    return structuredClone(validateProductAssertionCollection(migrated));
  } catch {
    return [];
  }
}

export function serializeAssertions(assertions: readonly AssertionDraft[]): string {
  const accepted = validateProductAssertionCollection(assertions);
  const envelope: StoredAssertionEnvelope = { version: STORAGE_VERSION, assertions: accepted };
  return JSON.stringify(envelope);
}
