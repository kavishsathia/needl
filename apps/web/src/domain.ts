import type { AssertionDefinition } from "../../../src/ltl/assertion.js";
import type {
  CounterexampleRecord,
  MonitorCheckpoint,
  MonitorOutboxItem,
  MonitorProcessResult,
} from "../../../src/ltl/runtime-types.js";
import type { NormalizedEvent } from "../../../src/core/types.js";
import type { ParamValues } from "../../../src/rules/compile.js";
import type { ExampleRule } from "./examples.js";

export type AssertionStatus = "monitoring" | "paused" | "needs-review";
export const DEMO_TENANT_ID = "synthetic-demo";
export const MAX_ASSERTIONS = 25;

/** A rule in the Needl rule language with its chosen `$` values; the stored monitor is compiled from it. */
export interface RuleSpec {
  readonly source: string;
  readonly values: ParamValues;
}

export interface AssertionDraft {
  readonly localId: string;
  readonly expectation: string;
  readonly definition: AssertionDefinition;
  readonly status: AssertionStatus;
  /** Absent only for older engine-level assertions kept for review. */
  readonly rule?: RuleSpec;
  /** The worked example this assertion started from, if any. */
  readonly exampleId?: ExampleRule["id"];
  readonly reviewReason?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DemoBootstrap {
  readonly mode: "deterministic-local-demo";
  readonly anchorTime: string;
  readonly examples: readonly ExampleRule[];
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

/** What the authoring agent proposed: a checked rule, or why none was written. */
export interface RuleProposal {
  readonly supported: boolean;
  readonly name?: string;
  readonly source?: string;
  readonly values?: ParamValues;
  readonly explanation: string;
  readonly rejectionReason?: string;
  /** Model calls used, including repairs after checker errors. */
  readonly attempts: number;
}

export interface TranslationProposalResponse {
  readonly proposalId: string;
  readonly remaining: number;
  readonly proposal: RuleProposal;
}

/** Suggested values for one `$` choice, as served by `/api/rules/suggestions`. */
export interface ChoiceSuggestions {
  readonly param: string;
  readonly label: string;
  readonly type: "string" | "number" | "boolean" | "duration";
  readonly list: boolean;
  readonly freeText: boolean;
  /** Where the choice is used, e.g. `gitlab.deployment.environment`. */
  readonly usages: readonly string[];
  readonly values: readonly {
    readonly value: string | number | boolean;
    readonly label: string;
    readonly counts: readonly number[];
    readonly seenEverywhere: boolean;
    readonly fixed: boolean;
    readonly lastSeen?: string;
  }[];
}

/** A webhook route of this workspace, with the outcome of its latest delivery. */
export interface Connection {
  readonly id: string;
  readonly provider: string;
  readonly enabled: boolean;
  readonly secretSource: "workspace" | "server" | "none";
  readonly authMode?: string;
  readonly webhookPath: string;
  readonly lastAttemptAt?: string;
  readonly lastOutcome?: string;
  readonly lastDetail?: string;
  readonly lastReceivedAt?: string;
  readonly createdAt: string;
}

/** The GitLab flow Needl wakes up when a rule breaks. The access token is never sent to the browser. */
export interface FlowConnectionSummary {
  readonly connected: boolean;
  readonly gitlabUser?: string;
  readonly projectPath?: string;
  readonly flowName?: string;
  readonly consumerId?: number;
  readonly goal: string;
  readonly autoLaunch: boolean;
  readonly updatedAt?: string;
}

export interface FlowOption {
  readonly consumerId: number;
  readonly name: string;
  readonly foundational: boolean;
}

export interface FlowDiscovery {
  readonly gitlabUser: string;
  readonly project: { readonly id: string; readonly path: string };
  readonly flows: readonly FlowOption[];
}

export interface ConnectionsResponse {
  /** NEEDL_PUBLIC_URL when the server pins it; otherwise webhook URLs use the address Needl was opened on. */
  readonly publicUrl: string | null;
  readonly connections: readonly Connection[];
}
