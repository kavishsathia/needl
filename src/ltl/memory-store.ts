import type {
  CounterexampleRecord,
  MonitorCheckpoint,
  MonitorCommit,
  MonitorOutboxItem,
  MonitorStore,
  MonitorTraceItem,
  OutboxAttempt,
} from "./runtime-types.js";

function copy<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryMonitorStore implements MonitorStore {
  readonly #checkpoints = new Map<string, MonitorCheckpoint>();
  readonly #processed = new Set<string>();
  readonly #traces = new Map<string, MonitorTraceItem[]>();
  readonly #violations = new Map<string, CounterexampleRecord>();
  readonly #outbox = new Map<string, MonitorOutboxItem>();

  async loadCheckpoint(key: string): Promise<MonitorCheckpoint | undefined> {
    const value = this.#checkpoints.get(key);
    return value === undefined ? undefined : copy(value);
  }

  async hasProcessedInput(key: string, inputId: string): Promise<boolean> {
    return this.#processed.has(`${key}\u0000${inputId}`);
  }

  async loadTrace(key: string): Promise<readonly MonitorTraceItem[]> {
    return copy(this.#traces.get(key) ?? []);
  }

  async commit(request: MonitorCommit): Promise<"committed" | "duplicate" | "conflict"> {
    const inputKey = `${request.instance.key}\u0000${request.inputId}`;
    if (this.#processed.has(inputKey)) return "duplicate";
    const revision = this.#checkpoints.get(request.instance.key)?.revision ?? 0;
    if (revision !== request.expectedRevision) return "conflict";
    this.#processed.add(inputKey);
    this.#checkpoints.set(request.instance.key, copy(request.checkpoint));
    const trace = this.#traces.get(request.instance.key) ?? [];
    trace.push(copy(request.traceItem));
    this.#traces.set(request.instance.key, trace);
    for (const violation of request.violations) {
      if (!this.#violations.has(violation.id)) this.#violations.set(violation.id, copy(violation));
    }
    for (const item of request.outbox) {
      if (!this.#outbox.has(item.id)) this.#outbox.set(item.id, copy(item));
    }
    return "committed";
  }

  async listCheckpoints(): Promise<readonly MonitorCheckpoint[]> {
    return copy([...this.#checkpoints.values()]);
  }

  async listViolations(): Promise<readonly CounterexampleRecord[]> {
    return copy([...this.#violations.values()]);
  }

  async listOutbox(status?: MonitorOutboxItem["status"]): Promise<readonly MonitorOutboxItem[]> {
    const values = [...this.#outbox.values()];
    return copy(status === undefined ? values : values.filter((item) => item.status === status));
  }

  async recordOutboxAttempt(id: string, attempt: OutboxAttempt): Promise<void> {
    const current = this.#outbox.get(id);
    if (current === undefined) throw new Error(`Unknown outbox item ${id}`);
    const { lastError: _lastError, ...withoutLastError } = current;
    this.#outbox.set(id, {
      ...withoutLastError,
      status: attempt.success ? "dispatched" : "failed",
      attempts: current.attempts + 1,
      lastAttemptAt: attempt.at,
      ...(attempt.error === undefined ? {} : { lastError: attempt.error }),
    });
  }
}
