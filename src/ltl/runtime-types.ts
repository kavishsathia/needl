import type { EvidenceLink, NormalizedEvent, Provider } from "../core/types.js";
import type { PredicateEvaluation, Scalar, StateSnapshot } from "./assertion.js";
import type { LtlFormula, PrefixVerdict, PropositionValuation } from "./types.js";

export interface MonitorInstance {
  readonly key: string;
  readonly tenantId: string;
  readonly assertionId: string;
  readonly assertionVersion: number;
  readonly scope: Readonly<Record<string, string>>;
}

export interface SourceEventReference {
  readonly eventId: string;
  readonly provider: Provider;
  readonly providerEventType: string;
  readonly kind: string;
  readonly occurredAt?: string;
  readonly receivedAt: string;
  readonly subject: NormalizedEvent["subject"];
  readonly relationships: NormalizedEvent["relationships"];
  readonly links: readonly EvidenceLink[];
  readonly bodySha256: string;
}

export interface ObservationTraceItem {
  readonly type: "observation";
  readonly position: number;
  readonly inputId: string;
  readonly at: string;
  readonly source: SourceEventReference;
  readonly valuation: PropositionValuation;
  readonly evaluations: Readonly<Record<string, PredicateEvaluation>>;
  readonly state: StateSnapshot;
}

export interface TickTraceItem {
  readonly type: "tick";
  readonly position: number;
  readonly inputId: string;
  readonly at: string;
  readonly state: StateSnapshot;
}

export interface FinalizationTraceItem {
  readonly type: "finalization";
  readonly position: number;
  readonly inputId: string;
  readonly at: string;
  readonly state: StateSnapshot;
}

export type MonitorTraceItem = ObservationTraceItem | TickTraceItem | FinalizationTraceItem;

export interface DeadlineObligation {
  readonly id: string;
  readonly openedAt: string;
  readonly dueAt: string;
  readonly triggerEventId: string;
  readonly trigger: SourceEventReference;
  readonly triggerEvaluation: Readonly<Record<string, PredicateEvaluation>>;
}

export interface MonitorCheckpoint extends MonitorInstance {
  readonly revision: number;
  readonly verdict: PrefixVerdict;
  readonly state: Readonly<Record<string, Scalar>>;
  readonly residual?: LtlFormula;
  readonly pendingObligations: readonly DeadlineObligation[];
  readonly lastLogicalTime?: string;
  readonly processedCount: number;
  readonly traceTail: readonly MonitorTraceItem[];
  readonly traceTruncated: boolean;
  readonly finalized: boolean;
}

export type ViolationCause = "formula_false" | "deadline_expired" | "finalization";

export interface CounterexampleRecord extends MonitorInstance {
  readonly id: string;
  readonly assertionName: string;
  readonly cause: ViolationCause;
  readonly detectedAt: string;
  readonly explanation: string;
  readonly triggerEventId?: string;
  readonly sourceEvents: readonly SourceEventReference[];
  readonly evaluations: Readonly<Record<string, PredicateEvaluation>>;
  readonly trace: readonly MonitorTraceItem[];
  readonly traceRange: { readonly from: number; readonly to: number };
  /** The stored sequence is sufficient evidence; no minimality claim is made. */
  readonly minimal: false;
}

export interface MonitorOutboxItem {
  readonly id: string;
  readonly violationId: string;
  readonly tenantId: string;
  readonly assertionId: string;
  readonly assertionVersion: number;
  readonly scope: Readonly<Record<string, string>>;
  readonly status: "pending" | "dispatched" | "failed";
  readonly attempts: number;
  readonly createdAt: string;
  readonly lastAttemptAt?: string;
  readonly lastError?: string;
}

export interface MonitorCommit {
  readonly instance: MonitorInstance;
  readonly inputId: string;
  readonly expectedRevision: number;
  readonly checkpoint: MonitorCheckpoint;
  readonly traceItem: MonitorTraceItem;
  readonly violations: readonly CounterexampleRecord[];
  readonly outbox: readonly MonitorOutboxItem[];
}

export interface OutboxAttempt {
  readonly at: string;
  readonly success: boolean;
  readonly error?: string;
}

export interface MonitorStore {
  loadCheckpoint(key: string): Promise<MonitorCheckpoint | undefined>;
  hasProcessedInput(key: string, inputId: string): Promise<boolean>;
  loadTrace(key: string): Promise<readonly MonitorTraceItem[]>;
  commit(request: MonitorCommit): Promise<"committed" | "duplicate" | "conflict">;
  listCheckpoints(): Promise<readonly MonitorCheckpoint[]>;
  listViolations(): Promise<readonly CounterexampleRecord[]>;
  listOutbox(status?: MonitorOutboxItem["status"]): Promise<readonly MonitorOutboxItem[]>;
  recordOutboxAttempt(id: string, attempt: OutboxAttempt): Promise<void>;
}

export interface TimerInput {
  readonly id: string;
  readonly tenantId: string;
  readonly assertionId: string;
  readonly assertionVersion: number;
  readonly scope: Readonly<Record<string, string>>;
  readonly at: string;
}

export type MonitorProcessResult =
  | (MonitorInstance & { readonly outcome: "applied"; readonly verdict: PrefixVerdict; readonly pendingObligations: number; readonly violationIds: readonly string[] })
  | (MonitorInstance & { readonly outcome: "duplicate" | "closed" })
  | (MonitorInstance & { readonly outcome: "out_of_order"; readonly lastLogicalTime: string; readonly inputTime: string })
  | { readonly outcome: "missing_scope"; readonly tenantId: string; readonly assertionId: string; readonly assertionVersion: number; readonly eventId: string };

export type FinalizeResult =
  | (MonitorInstance & { readonly outcome: "finalized"; readonly verdict: "satisfied" | "violated"; readonly violationIds: readonly string[] })
  | (MonitorInstance & { readonly outcome: "duplicate" | "closed" })
  | (MonitorInstance & { readonly outcome: "out_of_order"; readonly lastLogicalTime: string; readonly inputTime: string });
