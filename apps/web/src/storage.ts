import { compileAssertion } from "../../../src/ltl/assertion.js";
import type { AssertionDraft, StoredAssertionEnvelope } from "./domain.js";
import { STORAGE_VERSION } from "./domain.js";

function isDraft(value: unknown): value is AssertionDraft {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<AssertionDraft>;
  if (typeof candidate.localId !== "string" || candidate.localId.length === 0) return false;
  if (typeof candidate.expectation !== "string" || candidate.expectation.trim().length === 0) return false;
  if (candidate.status !== "monitoring" && candidate.status !== "paused") return false;
  if (typeof candidate.createdAt !== "string" || Number.isNaN(Date.parse(candidate.createdAt))) return false;
  if (typeof candidate.updatedAt !== "string" || Number.isNaN(Date.parse(candidate.updatedAt))) return false;
  try {
    compileAssertion(candidate.definition as AssertionDraft["definition"]);
    return candidate.definition?.id === candidate.localId;
  } catch {
    return false;
  }
}

export function parseStoredAssertions(raw: string | null): AssertionDraft[] {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as Partial<StoredAssertionEnvelope>;
    if (parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.assertions)) return [];
    if (!parsed.assertions.every(isDraft)) return [];
    return structuredClone(parsed.assertions);
  } catch {
    return [];
  }
}

export function serializeAssertions(assertions: readonly AssertionDraft[]): string {
  const envelope: StoredAssertionEnvelope = { version: STORAGE_VERSION, assertions };
  return JSON.stringify(envelope);
}
