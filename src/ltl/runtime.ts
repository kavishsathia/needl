import type { NormalizedEvent } from "../core/types.js";
import { stableId } from "../core/crypto.js";
import {
  applyStateUpdates,
  compileAssertion,
  evaluatePredicate,
  evaluatePropositions,
  extractBinding,
  extractScope,
  type AssertionDefinition,
  type CompiledAssertion,
  type PredicateEvaluation,
} from "./assertion.js";
import { advanceFormulaTime, containsBind, containsTimed, evaluateCompleteTrace, nextDeadline, prefixVerdict, progressFormula, type ProgressionContext } from "./formula.js";
import type { BindingEnvironment, LtlFormula } from "./types.js";
import type {
  CounterexampleRecord,
  DeadlineObligation,
  FinalizeResult,
  MonitorCheckpoint,
  MonitorCommit,
  MonitorInstance,
  MonitorOutboxItem,
  MonitorProcessResult,
  MonitorStore,
  MonitorTraceItem,
  ObservationTraceItem,
  SourceEventReference,
  TimerInput,
} from "./runtime-types.js";

function assertionLookupKey(tenantId: string, assertionId: string, version: number): string {
  return `${tenantId}\u0000${assertionId}\u0000${String(version)}`;
}

function canonicalScope(assertion: CompiledAssertion, supplied: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const expected = assertion.scope.keys.map((key) => key.name);
  const actual = Object.keys(supplied);
  if (actual.length !== expected.length || expected.some((key) => typeof supplied[key] !== "string" || supplied[key]!.length === 0)) {
    throw new Error(`Scope must bind exactly: ${expected.join(", ")}`);
  }
  for (const key of actual) if (!expected.includes(key)) throw new Error(`Unknown scope key ${key}`);
  return Object.fromEntries(expected.map((key) => [key, supplied[key]!]));
}

export function monitorInstance(
  assertion: CompiledAssertion,
  scopeInput: Readonly<Record<string, string>>,
): MonitorInstance {
  const scope = canonicalScope(assertion, scopeInput);
  const parts = [assertion.tenantId, assertion.id, String(assertion.version), ...Object.entries(scope).flat()];
  return {
    key: stableId(["monitor", ...parts]).replace(/^evt_/, "mon_"),
    tenantId: assertion.tenantId,
    assertionId: assertion.id,
    assertionVersion: assertion.version,
    scope,
  };
}

function logicalTime(event: NormalizedEvent): string {
  const value = event.occurredAt ?? event.receivedAt;
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) throw new Error(`Event ${event.id} has invalid logical time`);
  return time.toISOString();
}

function normalizedTime(value: string, label: string): string {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) throw new Error(`${label} is not a valid timestamp`);
  return time.toISOString();
}

function sourceReference(event: NormalizedEvent): SourceEventReference {
  return {
    eventId: event.id,
    provider: event.provider,
    providerEventType: event.providerEventType,
    kind: event.kind,
    ...(event.occurredAt === undefined ? {} : { occurredAt: event.occurredAt }),
    receivedAt: event.receivedAt,
    subject: event.subject,
    relationships: event.relationships,
    links: event.evidence.links,
    bodySha256: event.evidence.bodySha256,
  };
}

function environmentLabel(env: BindingEnvironment): string {
  return `{${Object.entries(env).map(([key, value]) => `${key}=${value === null ? "<missing>" : JSON.stringify(value)}`).join(", ")}}`;
}

/** Progresses the residual against one observation, evaluating bound propositions under each frozen environment. */
function progressObservation(
  assertion: CompiledAssertion,
  residual: LtlFormula,
  event: NormalizedEvent,
  state: ReturnType<typeof applyStateUpdates>,
  valuation: Readonly<Record<string, boolean>>,
  at: string,
): {
  readonly residual: LtlFormula;
  readonly valuation: Readonly<Record<string, boolean>>;
  readonly evaluations: Readonly<Record<string, PredicateEvaluation>>;
  readonly captured: Readonly<Record<string, string | null>>;
  /** Obligations that failed at this observation (isolated `G` formulas only). */
  readonly failed: number;
} {
  const boundValuation: Record<string, boolean> = {};
  const boundEvaluations: Record<string, PredicateEvaluation> = {};
  const captured: Record<string, string | null> = {};
  const context: ProgressionContext = {
    atom: (name, env) => {
      if ((assertion.propositionVariables[name] ?? []).length === 0) return valuation[name] === true;
      const key = `${name}${environmentLabel(env)}`;
      if (!(key in boundValuation)) {
        const proposition = assertion.propositions.find((candidate) => candidate.name === name)!;
        const evaluated = evaluatePredicate(proposition.predicate, event, state, env);
        boundValuation[key] = evaluated.value;
        boundEvaluations[key] = evaluated;
      }
      return boundValuation[key]!;
    },
    bind: (variable) => {
      const value = extractBinding(assertion, variable, event);
      captured[variable] = value ?? null;
      return value;
    },
    at,
  };
  if (isolatesViolations(assertion)) {
    const step = stepIsolated(resume(assertion, residual), (part) => progressFormula(part, context), true);
    return { residual: step.residual, valuation: boundValuation, evaluations: boundEvaluations, captured, failed: step.failed };
  }
  return { residual: progressFormula(residual, context), valuation: boundValuation, evaluations: boundEvaluations, captured, failed: 0 };
}

/**
 * A rule `G φ` keeps monitoring after a violation. Its residual is a conjunction of independent obligations (one per
 * trigger, each with its own frozen values and time windows) plus `G φ` itself, so each obligation is progressed on its
 * own: one that fails is reported and dropped, and the others, and every future trigger, continue.
 */
function isolatesViolations(assertion: CompiledAssertion): boolean {
  return assertion.formula.kind === "always";
}

/** Monitors saved before violations were isolated stopped at `false`; they resume watching from the rule itself. */
function resume(assertion: CompiledAssertion, residual: LtlFormula): LtlFormula {
  return residual.kind === "false" ? assertion.formula as LtlFormula : residual;
}

function conjuncts(formula: LtlFormula): LtlFormula[] {
  return formula.kind === "and" ? formula.operands.flatMap(conjuncts) : [formula];
}

function stepIsolated(residual: LtlFormula, step: (part: LtlFormula) => LtlFormula, unfoldAlways: boolean): { readonly residual: LtlFormula; readonly failed: number } {
  const kept = new Map<string, LtlFormula>();
  let failed = 0;
  for (const part of conjuncts(residual)) {
    // G φ progresses to (progress φ) ∧ G φ; progressing φ separately keeps G φ when this observation breaks φ.
    const pieces = unfoldAlways && part.kind === "always" ? [step(part.operand), part] : [step(part)];
    for (const piece of pieces.flatMap(conjuncts)) {
      if (piece.kind === "false") failed += 1;
      else if (piece.kind !== "true") kept.set(JSON.stringify(piece), piece);
    }
  }
  const remaining = [...kept.values()];
  return { residual: remaining.length === 0 ? { kind: "true" } : remaining.length === 1 ? remaining[0]! : { kind: "and", operands: remaining }, failed };
}

function initialCheckpoint(assertion: CompiledAssertion, instance: MonitorInstance): MonitorCheckpoint {
  return {
    ...instance,
    revision: 0,
    verdict: "inconclusive",
    state: {},
    ...(assertion.formula.kind === "deadline" ? {} : { residual: assertion.formula }),
    pendingObligations: [],
    processedCount: 0,
    traceTail: [],
    traceTruncated: false,
    finalized: false,
  };
}

function traceTail(assertion: CompiledAssertion, previous: MonitorCheckpoint, item: MonitorTraceItem): {
  readonly traceTail: readonly MonitorTraceItem[];
  readonly traceTruncated: boolean;
} {
  const appended = [...previous.traceTail, item];
  return {
    traceTail: appended.slice(-assertion.checkpointTraceLimit),
    traceTruncated: previous.traceTruncated || appended.length > assertion.checkpointTraceLimit,
  };
}

function sourceEvents(trace: readonly MonitorTraceItem[]): SourceEventReference[] {
  const output: SourceEventReference[] = [];
  const seen = new Set<string>();
  for (const item of trace) {
    if (item.type !== "observation" || seen.has(item.source.eventId)) continue;
    seen.add(item.source.eventId);
    output.push(item.source);
  }
  return output;
}

function violation(
  assertion: CompiledAssertion,
  instance: MonitorInstance,
  cause: CounterexampleRecord["cause"],
  detectedAt: string,
  explanation: string,
  trace: readonly MonitorTraceItem[],
  evaluations: Readonly<Record<string, PredicateEvaluation>>,
  identity: string,
  triggerEventId?: string,
): CounterexampleRecord {
  const id = stableId(["violation", instance.key, cause, identity]).replace(/^evt_/, "vio_");
  return {
    ...instance,
    id,
    assertionName: assertion.name,
    cause,
    detectedAt,
    explanation,
    ...(triggerEventId === undefined ? {} : { triggerEventId }),
    sourceEvents: sourceEvents(trace),
    evaluations,
    trace,
    traceRange: { from: trace[0]?.position ?? 0, to: trace.at(-1)?.position ?? 0 },
    minimal: false,
  };
}

function outbox(record: CounterexampleRecord): MonitorOutboxItem {
  return {
    id: `out_${record.id}`,
    violationId: record.id,
    tenantId: record.tenantId,
    assertionId: record.assertionId,
    assertionVersion: record.assertionVersion,
    scope: record.scope,
    status: "pending",
    attempts: 0,
    createdAt: record.detectedAt,
  };
}

function dueAt(residual: LtlFormula | undefined, pending: readonly DeadlineObligation[]): { readonly nextDueAt?: string } {
  const candidates = [...(residual === undefined ? [] : [nextDeadline(residual)]), ...pending.map((obligation) => obligation.dueAt)]
    .filter((value): value is string => value !== undefined)
    .sort();
  return candidates[0] === undefined ? {} : { nextDueAt: candidates[0] };
}

function withoutDue(checkpoint: MonitorCheckpoint): MonitorCheckpoint {
  const { nextDueAt: _previous, ...rest } = checkpoint;
  return rest;
}

function applied(instance: MonitorInstance, checkpoint: MonitorCheckpoint, records: readonly CounterexampleRecord[]): MonitorProcessResult {
  return {
    ...instance,
    outcome: "applied",
    verdict: checkpoint.verdict,
    pendingObligations: checkpoint.pendingObligations.length,
    violationIds: records.map((record) => record.id),
  };
}

export interface RuntimeMonitorOptions {
  readonly store: MonitorStore;
  readonly assertions: readonly AssertionDefinition[];
  readonly maxCommitRetries?: number;
}

export class RuntimeMonitor {
  readonly #store: MonitorStore;
  readonly #assertions: readonly CompiledAssertion[];
  readonly #lookup = new Map<string, CompiledAssertion>();
  readonly #maxCommitRetries: number;

  constructor(options: RuntimeMonitorOptions) {
    this.#store = options.store;
    this.#assertions = options.assertions.map(compileAssertion);
    this.#maxCommitRetries = options.maxCommitRetries ?? 5;
    for (const assertion of this.#assertions) {
      const key = assertionLookupKey(assertion.tenantId, assertion.id, assertion.version);
      if (this.#lookup.has(key)) throw new Error(`Duplicate assertion registration ${assertion.id}@${assertion.version}`);
      this.#lookup.set(key, assertion);
    }
  }

  async process(event: NormalizedEvent): Promise<readonly MonitorProcessResult[]> {
    const results: MonitorProcessResult[] = [];
    for (const assertion of this.#assertions) {
      if (assertion.tenantId !== event.tenantId) continue;
      const scope = extractScope(assertion, event);
      if (scope === undefined) {
        results.push({
          outcome: "missing_scope",
          tenantId: event.tenantId,
          assertionId: assertion.id,
          assertionVersion: assertion.version,
          eventId: event.id,
        });
        continue;
      }
      results.push(await this.#processAssertion(assertion, monitorInstance(assertion, scope), event));
    }
    return results;
  }

  async #processAssertion(
    assertion: CompiledAssertion,
    instance: MonitorInstance,
    event: NormalizedEvent,
  ): Promise<MonitorProcessResult> {
    const at = logicalTime(event);
    for (let attempt = 0; attempt < this.#maxCommitRetries; attempt += 1) {
      if (await this.#store.hasProcessedInput(instance.key, event.id)) return { ...instance, outcome: "duplicate" };
      const previous = await this.#store.loadCheckpoint(instance.key) ?? initialCheckpoint(assertion, instance);
      if (previous.finalized) return { ...instance, outcome: "closed" };
      if (previous.lastLogicalTime !== undefined && at < previous.lastLogicalTime) {
        return { ...instance, outcome: "out_of_order", lastLogicalTime: previous.lastLogicalTime, inputTime: at };
      }
      const state = applyStateUpdates(assertion, event, previous.state);
      const evaluation = evaluatePropositions(assertion, event, state);
      let progressed: ReturnType<typeof progressObservation> | undefined;
      if (assertion.formula.kind !== "deadline") {
        if (previous.residual === undefined) throw new Error("Ordinary LTL checkpoint is missing a residual formula");
        progressed = progressObservation(assertion, previous.residual, event, state, evaluation.valuation, at);
      }
      const item: ObservationTraceItem = {
        type: "observation",
        position: previous.processedCount + 1,
        inputId: event.id,
        at,
        source: sourceReference(event),
        valuation: { ...evaluation.valuation, ...progressed?.valuation },
        evaluations: { ...evaluation.evaluations, ...progressed?.evaluations },
        ...(progressed === undefined || Object.keys(progressed.captured).length === 0 ? {} : { captured: progressed.captured }),
        state,
      };
      const fullTrace = [...await this.#store.loadTrace(instance.key), item];
      const records: CounterexampleRecord[] = [];
      let residual = previous.residual;
      let pending = [...previous.pendingObligations];
      let verdict = previous.verdict;
      if (assertion.formula.kind === "deadline") {
        const expired = pending.filter((obligation) => obligation.dueAt < at);
        pending = pending.filter((obligation) => obligation.dueAt >= at);
        for (const obligation of expired) {
          records.push(violation(
            assertion, instance, "deadline_expired", at,
            `No matching response arrived by ${obligation.dueAt} for trigger ${obligation.triggerEventId}.`,
            fullTrace, evaluation.evaluations, obligation.id, obligation.triggerEventId,
          ));
        }
        const response = evaluateCompleteTrace(assertion.formula.response, [evaluation.valuation]);
        const trigger = evaluateCompleteTrace(assertion.formula.trigger, [evaluation.valuation]);
        if (response) pending = [];
        if (trigger && !response) {
          const dueAt = new Date(new Date(at).getTime() + assertion.formula.withinMs).toISOString();
          pending.push({
            id: stableId(["obligation", instance.key, event.id]).replace(/^evt_/, "obl_"),
            openedAt: at,
            dueAt,
            triggerEventId: event.id,
            trigger: item.source,
            triggerEvaluation: evaluation.evaluations,
          });
        }
        if (records.length > 0) verdict = "violated";
      } else {
        if (residual === undefined || progressed === undefined) throw new Error("Ordinary LTL checkpoint is missing a residual formula");
        const before = prefixVerdict(residual);
        residual = progressed.residual;
        if (isolatesViolations(assertion)) {
          for (let index = 0; index < progressed.failed; index += 1) {
            records.push(violation(
              assertion, instance, "formula_false", at,
              `An obligation of the rule became false at event ${event.id}; monitoring continues for the others.`,
              fullTrace, item.evaluations, index === 0 ? event.id : `${event.id}#${index}`,
            ));
          }
          verdict = records.length > 0 || previous.verdict === "violated" ? "violated" : prefixVerdict(residual);
        } else {
          verdict = prefixVerdict(residual);
          if (before !== "violated" && verdict === "violated") {
            records.push(violation(
              assertion, instance, "formula_false", at,
              `The progressed LTL formula became false after event ${event.id}.`,
              fullTrace, item.evaluations, event.id,
            ));
          }
        }
      }
      const tail = traceTail(assertion, previous, item);
      const checkpoint: MonitorCheckpoint = {
        ...instance,
        revision: previous.revision + 1,
        verdict,
        state,
        ...(residual === undefined ? {} : { residual }),
        pendingObligations: pending,
        lastLogicalTime: at,
        ...dueAt(residual, pending),
        processedCount: item.position,
        ...tail,
        finalized: false,
      };
      const request: MonitorCommit = {
        instance,
        inputId: event.id,
        expectedRevision: previous.revision,
        checkpoint,
        traceItem: item,
        violations: records,
        outbox: records.map(outbox),
      };
      const committed = await this.#store.commit(request);
      if (committed === "duplicate") return { ...instance, outcome: "duplicate" };
      if (committed === "committed") return applied(instance, checkpoint, records);
    }
    throw new Error(`Monitor commit conflict limit exceeded for ${instance.key}`);
  }

  async advanceTime(input: TimerInput): Promise<MonitorProcessResult> {
    const assertion = this.#findAssertion(input);
    const instance = monitorInstance(assertion, input.scope);
    const at = normalizedTime(input.at, "tick time");
    for (let attempt = 0; attempt < this.#maxCommitRetries; attempt += 1) {
      if (await this.#store.hasProcessedInput(instance.key, input.id)) return { ...instance, outcome: "duplicate" };
      const previous = await this.#store.loadCheckpoint(instance.key) ?? initialCheckpoint(assertion, instance);
      if (previous.finalized) return { ...instance, outcome: "closed" };
      if (previous.lastLogicalTime !== undefined && at < previous.lastLogicalTime) {
        return { ...instance, outcome: "out_of_order", lastLogicalTime: previous.lastLogicalTime, inputTime: at };
      }
      const item: MonitorTraceItem = { type: "tick", position: previous.processedCount + 1, inputId: input.id, at, state: previous.state };
      const fullTrace = [...await this.#store.loadTrace(instance.key), item];
      const records: CounterexampleRecord[] = [];
      let pending = [...previous.pendingObligations];
      let verdict = previous.verdict;
      let residual = previous.residual;
      if (assertion.formula.kind !== "deadline" && residual !== undefined) {
        const closing = nextDeadline(residual);
        const before = verdict;
        if (isolatesViolations(assertion)) {
          const step = stepIsolated(resume(assertion, residual), (part) => advanceFormulaTime(part, at), false);
          residual = step.residual;
          for (let index = 0; index < step.failed; index += 1) {
            records.push(violation(
              assertion, instance, "deadline_expired", at,
              `A time window ending ${closing ?? "earlier"} closed at ${at} without the rule being met; monitoring continues.`,
              fullTrace, {}, index === 0 ? input.id : `${input.id}#${index}`,
            ));
          }
          if (records.length > 0) verdict = "violated";
        } else {
          residual = advanceFormulaTime(residual, at);
          verdict = prefixVerdict(residual);
          if (before !== "violated" && verdict === "violated") {
            records.push(violation(
              assertion, instance, "deadline_expired", at,
              `A time window ending ${closing ?? "earlier"} closed at ${at} without the rule being met.`,
              fullTrace, {}, input.id,
            ));
          }
        }
      }
      if (assertion.formula.kind === "deadline") {
        const expired = pending.filter((obligation) => obligation.dueAt <= at);
        pending = pending.filter((obligation) => obligation.dueAt > at);
        for (const obligation of expired) {
          records.push(violation(
            assertion, instance, "deadline_expired", at,
            `Explicit clock tick reached ${obligation.dueAt} without a matching response for trigger ${obligation.triggerEventId}.`,
            fullTrace, obligation.triggerEvaluation, obligation.id, obligation.triggerEventId,
          ));
        }
        if (records.length > 0) verdict = "violated";
      }
      const checkpoint: MonitorCheckpoint = {
        ...withoutDue(previous),
        revision: previous.revision + 1,
        verdict,
        ...(residual === undefined ? {} : { residual }),
        pendingObligations: pending,
        lastLogicalTime: at,
        ...dueAt(residual, pending),
        processedCount: item.position,
        ...traceTail(assertion, previous, item),
      };
      const committed = await this.#store.commit({
        instance, inputId: input.id, expectedRevision: previous.revision, checkpoint, traceItem: item,
        violations: records, outbox: records.map(outbox),
      });
      if (committed === "duplicate") return { ...instance, outcome: "duplicate" };
      if (committed === "committed") return applied(instance, checkpoint, records);
    }
    throw new Error(`Monitor commit conflict limit exceeded for ${instance.key}`);
  }

  async finalize(input: TimerInput): Promise<FinalizeResult> {
    const assertion = this.#findAssertion(input);
    const instance = monitorInstance(assertion, input.scope);
    const at = normalizedTime(input.at, "finalization time");
    for (let attempt = 0; attempt < this.#maxCommitRetries; attempt += 1) {
      if (await this.#store.hasProcessedInput(instance.key, input.id)) return { ...instance, outcome: "duplicate" };
      const previous = await this.#store.loadCheckpoint(instance.key) ?? initialCheckpoint(assertion, instance);
      if (previous.finalized) return { ...instance, outcome: "closed" };
      if (previous.lastLogicalTime !== undefined && at < previous.lastLogicalTime) {
        return { ...instance, outcome: "out_of_order", lastLogicalTime: previous.lastLogicalTime, inputTime: at };
      }
      const item: MonitorTraceItem = { type: "finalization", position: previous.processedCount + 1, inputId: input.id, at, state: previous.state };
      const existingTrace = await this.#store.loadTrace(instance.key);
      const fullTrace = [...existingTrace, item];
      const observations = existingTrace.filter((traceItem): traceItem is ObservationTraceItem => traceItem.type === "observation");
      const records: CounterexampleRecord[] = [];
      let verdict: "satisfied" | "violated";
      let pending = [...previous.pendingObligations];
      if (assertion.formula.kind === "deadline") {
        verdict = previous.verdict === "violated" || pending.length > 0 ? "violated" : "satisfied";
        for (const obligation of pending) {
          records.push(violation(
            assertion, instance, "finalization", at,
            `The complete trace ended with no response for trigger ${obligation.triggerEventId}.`,
            fullTrace, obligation.triggerEvaluation, `final-${obligation.id}`, obligation.triggerEventId,
          ));
        }
        pending = [];
      } else {
        // Bound and timed formulas cannot be re-evaluated from stored valuations; the residual already carries every frozen value and opened window,
        // so the complete trace satisfies the formula exactly when the residual holds on the empty remaining suffix.
        const complete = containsBind(assertion.formula) || containsTimed(assertion.formula)
          ? evaluateCompleteTrace(previous.residual ?? assertion.formula, [], 0)
          : evaluateCompleteTrace(assertion.formula, observations.map((observation) => observation.valuation));
        verdict = complete ? "satisfied" : "violated";
        if (!complete && previous.verdict !== "violated") {
          records.push(violation(
            assertion, instance, "finalization", at,
            "The explicitly completed finite trace does not satisfy the formula.",
            fullTrace, observations.at(-1)?.evaluations ?? {}, input.id,
          ));
        }
      }
      const checkpoint: MonitorCheckpoint = {
        ...withoutDue(previous),
        revision: previous.revision + 1,
        verdict,
        pendingObligations: pending,
        lastLogicalTime: at,
        processedCount: item.position,
        ...traceTail(assertion, previous, item),
        finalized: true,
      };
      const committed = await this.#store.commit({
        instance, inputId: input.id, expectedRevision: previous.revision, checkpoint, traceItem: item,
        violations: records, outbox: records.map(outbox),
      });
      if (committed === "duplicate") return { ...instance, outcome: "duplicate" };
      if (committed === "committed") return { ...instance, outcome: "finalized", verdict, violationIds: records.map((record) => record.id) };
    }
    throw new Error(`Monitor commit conflict limit exceeded for ${instance.key}`);
  }

  #findAssertion(input: Pick<TimerInput, "tenantId" | "assertionId" | "assertionVersion">): CompiledAssertion {
    const assertion = this.#lookup.get(assertionLookupKey(input.tenantId, input.assertionId, input.assertionVersion));
    if (assertion === undefined) throw new Error(`Unknown assertion ${input.assertionId}@${input.assertionVersion} for tenant ${input.tenantId}`);
    return assertion;
  }
}
