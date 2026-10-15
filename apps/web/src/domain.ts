import type { AssertionDefinition } from "../../../src/ltl/assertion.js";
import type {
  CounterexampleRecord,
  MonitorCheckpoint,
  MonitorOutboxItem,
  MonitorProcessResult,
} from "../../../src/ltl/runtime-types.js";
import type { NormalizedEvent, Provider } from "../../../src/core/types.js";

export type AssertionStatus = "monitoring" | "paused" | "needs-review";
export type TemplateId = "ghost" | "boomerang" | "clean-break";
export type LegacyTemplateId = "provisioning";
export const DEMO_TENANT_ID = "synthetic-demo";
export const MAX_ASSERTIONS = 25;

export interface AssertionDraft {
  readonly localId: string;
  readonly expectation: string;
  readonly definition: AssertionDefinition;
  readonly status: AssertionStatus;
  readonly templateId?: TemplateId | LegacyTemplateId;
  readonly meaning?: {
    readonly templateId: TemplateId;
    readonly values: Readonly<Record<string, string>>;
  };
  readonly reviewReason?: string;
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

export interface WorkspaceBootstrap {
  readonly user: { readonly id: string; readonly name: string; readonly email: string };
  readonly tenantId: string;
  readonly assertions: readonly AssertionDraft[];
  readonly translator: "available" | "unavailable";
  readonly integrations: readonly IntegrationSummary[];
}

export interface IntegrationSummary {
  readonly id: string;
  readonly provider: string;
  readonly purpose: string;
  readonly enabled: boolean;
  readonly webhookPath?: string;
}

export interface InvestigationRecord {
  readonly id: string;
  readonly integrationId: string;
  readonly violationId: string;
  readonly assertionVersion: number;
  readonly attempt: number;
  readonly clientReference: string;
  readonly workflowId?: string;
  readonly webUrl?: string;
  readonly status: "queued" | "launching" | "running" | "completed" | "failed" | "stopped" | "launch_unknown" | "failed_to_start" | "callback_lost";
  readonly lastProgress?: unknown;
  readonly resultMessage?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MonitorSnapshot {
  readonly events: readonly NormalizedEvent[];
  readonly checkpoints: readonly MonitorCheckpoint[];
  readonly counterexamples: readonly CounterexampleRecord[];
  readonly outbox: readonly MonitorOutboxItem[];
  readonly investigations: readonly InvestigationRecord[];
}

export interface TranslationProposalResponse {
  readonly proposalId: string;
  readonly remaining: number;
  readonly proposal: {
    readonly supported: boolean;
    readonly templateId?: TemplateId;
    readonly values?: Readonly<Record<string, string>>;
    readonly explanation: string;
    readonly rejectionReason?: string;
  };
}
