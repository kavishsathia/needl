import { compileAssertion } from "../../../src/ltl/assertion.js";
import type { AssertionDraft, TemplateId } from "./domain.js";
import { DEMO_TENANT_ID, MAX_ASSERTIONS } from "./domain.js";

const templateIds = new Set<TemplateId>(["recurrence", "feature", "provisioning"]);

function validateDraft(value: unknown, index: number): asserts value is AssertionDraft {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Assertion ${index + 1} must be an object`);
  }
  const draft = value as Partial<AssertionDraft>;
  if (typeof draft.localId !== "string" || draft.localId.length === 0) {
    throw new Error(`Assertion ${index + 1} needs a localId`);
  }
  if (typeof draft.expectation !== "string" || draft.expectation.trim().length === 0) {
    throw new Error(`Assertion ${draft.localId} needs an expectation`);
  }
  if (draft.status !== "monitoring" && draft.status !== "paused") {
    throw new Error(`Assertion ${draft.localId} has an unknown status`);
  }
  if (draft.templateId !== undefined && !templateIds.has(draft.templateId)) {
    throw new Error(`Assertion ${draft.localId} has an unknown template`);
  }
  if (typeof draft.createdAt !== "string" || Number.isNaN(Date.parse(draft.createdAt))) {
    throw new Error(`Assertion ${draft.localId} has an invalid creation time`);
  }
  if (typeof draft.updatedAt !== "string" || Number.isNaN(Date.parse(draft.updatedAt))) {
    throw new Error(`Assertion ${draft.localId} has an invalid update time`);
  }
  const definition = compileAssertion(draft.definition as AssertionDraft["definition"]);
  if (definition.id !== draft.localId) throw new Error("Assertion localId must match definition id");
  if (definition.tenantId !== DEMO_TENANT_ID) {
    throw new Error(`Demo assertions must use tenant ${DEMO_TENANT_ID}`);
  }
}

export function validateAssertionCollection(value: unknown): AssertionDraft[] {
  if (!Array.isArray(value)) throw new Error("assertions must be an array");
  if (value.length > MAX_ASSERTIONS) throw new Error(`Demo accepts at most ${MAX_ASSERTIONS} assertions`);
  const ids = new Set<string>();
  value.forEach((draft, index) => {
    validateDraft(draft, index);
    if (ids.has(draft.localId)) throw new Error(`Duplicate assertion id ${draft.localId}`);
    ids.add(draft.localId);
  });
  return value;
}

export function assertAssertionCapacity(currentCount: number): void {
  if (currentCount >= MAX_ASSERTIONS) {
    throw new Error(`This demo can save at most ${MAX_ASSERTIONS} assertions. Remove local assertions in Settings before creating another.`);
  }
}
