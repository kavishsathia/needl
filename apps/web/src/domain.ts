import type { AssertionDefinition } from "../../../src/ltl/assertion.js";
import type {
  CounterexampleRecord,
  MonitorCheckpoint,
  MonitorOutboxItem,
  MonitorProcessResult,
} from "../../../src/ltl/runtime-types.js";
import type { NormalizedEvent, Provider } from "../../../src/core/types.js";

export type AssertionStatus = "monitoring" | "paused";
export type TemplateId = "recurrence" | "feature" | "provisioning";

export interface AssertionDraft {
  readonly localId: string;
  readonly expectation: string;
  readonly definition: AssertionDefinition;
  readonly status: AssertionStatus;
  readonly templateId?: TemplateId;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AuthoringTemplate {
  readonly id: TemplateId;
  readonly prompt: string;
  readonly shortLabel: string;
  readonly description: string;
  readonly providers: readonly Provider[];
  readonly definition: AssertionDefinition;
}

export interface DemoBootstrap {
  readonly mode: "deterministic-local-demo";
  readonly anchorTime: string;
  readonly templates: readonly AuthoringTemplate[];
}

export interface DemoReplayRequest {
  readonly scenario: "violating" | "healthy";
  readonly assertions: readonly AssertionDraft[];
}

export interface DemoReplay {
  readonly mode: "deterministic-local-demo";
  readonly replayedAt: string;
  readonly scenario: DemoReplayRequest["scenario"];
  readonly events: readonly NormalizedEvent[];
  readonly results: readonly MonitorProcessResult[];
  readonly checkpoints: readonly MonitorCheckpoint[];
  readonly violations: readonly CounterexampleRecord[];
  readonly outbox: readonly MonitorOutboxItem[];
  readonly unavailableAssertionIds: readonly string[];
}

export const STORAGE_KEY = "needl.assertions.v1";
export const STORAGE_VERSION = 1;

export interface StoredAssertionEnvelope {
  readonly version: typeof STORAGE_VERSION;
  readonly assertions: readonly AssertionDraft[];
}
