import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import type { Provider } from "../../../src/core/types.js";
import type { CounterexampleRecord, MonitorTraceItem } from "../../../src/ltl/runtime-types.js";
import { createDraftFromTemplate, formulaText, updateDraft, updateMeaningChoice } from "./authoring.js";
import { confirmTranslation, fetchBootstrap, fetchMonitor, fetchPublicConfig, fetchWorkspace, launchInvestigation, refreshInvestigation, removeAssertion, replayDemo, saveAssertion, signIn, signOut, signUp, translateAssertion } from "./api.js";
import { assertAssertionCapacity, validateAssertionCollection } from "./collection.js";
import type {
  AssertionDraft,
  AuthoringTemplate,
  DemoReplay,
  DemoReplayRequest,
  InvestigationRecord,
  MonitorSnapshot,
  TranslationProposalResponse,
  WorkspaceBootstrap,
} from "./domain.js";
import { MAX_ASSERTIONS } from "./domain.js";
import { Icon } from "./icons.js";
import { parseStoredAssertions, serializeAssertions, storageKeyForTenant } from "./storage.js";
import {
  defaultMeaningValues,
  eventKindsForField,
  fieldForEventKind,
  meaningOption,
  meaningTemplates,
  meaningViolationText,
} from "./meaning.js";
import { EVENTUALITY_EXPLANATION, unsupportedAuthoringIntent } from "./safety.js";

type Section = "assertions" | "activity" | "connections" | "settings";
type Filter = "all" | "attention" | "monitoring" | "paused";
type SortMode = "attention" | "recent" | "name";
type DetailTab = "overview" | "counterexamples" | "activity";

const providerNames: Readonly<Record<Provider, string>> = {
  gitlab: "GitLab",
  linear: "Linear",
  launchdarkly: "LaunchDarkly",
  sentry: "Sentry",
  posthog: "PostHog",
  intercom: "Intercom",
  stripe: "Stripe",
};

const providerGlyphs: Readonly<Record<Provider, string>> = {
  gitlab: "◆",
  linear: "◒",
  launchdarkly: "✦",
  sentry: "△",
  posthog: "●",
  intercom: "▰",
  stripe: "▣",
};

const providers = Object.keys(providerNames) as Provider[];

function beginTransition(update: () => void): void {
  if (document.startViewTransition !== undefined && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.startViewTransition(update);
  } else update();
}

function defaultDrafts(templates: readonly AuthoringTemplate[]): AssertionDraft[] {
  return templates.map((template) => ({
    localId: template.definition.id,
    expectation: template.prompt,
    definition: template.definition,
    status: "monitoring",
    templateId: template.id,
    meaning: { templateId: template.id, values: defaultMeaningValues(template.id) },
    createdAt: "2026-02-18T10:39:00.000Z",
    updatedAt: "2026-02-18T10:39:00.000Z",
  }));
}

function mergeRestored(defaults: readonly AssertionDraft[], restored: readonly AssertionDraft[]): AssertionDraft[] {
  const saved = new Map(restored.map((draft) => [draft.localId, draft]));
  const merged = defaults.map((draft) => saved.get(draft.localId) ?? draft);
  for (const draft of restored) if (!defaults.some((item) => item.localId === draft.localId)) merged.push(draft);
  return merged.length <= MAX_ASSERTIONS ? merged : [...restored];
}

function routeFromLocation(): { section: Section; selectedId?: string } {
  const parts = window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const section = (["assertions", "activity", "connections", "settings"] as const).includes(parts[0] as Section)
    ? parts[0] as Section
    : "assertions";
  if (section !== "assertions" || parts[1] === undefined) return { section };
  try {
    return { section, selectedId: decodeURIComponent(parts[1]) };
  } catch {
    return { section };
  }
}

function useRoute() {
  const initial = routeFromLocation();
  const [section, setSection] = useState<Section>(initial.section);
  const [selectedId, setSelectedId] = useState<string | undefined>(initial.selectedId);
  const previousSelected = useRef<string | undefined>(initial.selectedId);

  useEffect(() => {
    const update = () => {
      const route = routeFromLocation();
      beginTransition(() => {
        previousSelected.current = selectedId;
        setSection(route.section);
        setSelectedId(route.selectedId);
      });
    };
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, [selectedId]);

  const navigate = (nextSection: Section, nextId?: string, replace = false) => {
    const hash = `#/${nextSection}${nextId === undefined ? "" : `/${encodeURIComponent(nextId)}`}`;
    const state = { needl: true, detail: nextId !== undefined };
    if (replace) window.history.replaceState(state, "", hash);
    else window.history.pushState(state, "", hash);
    beginTransition(() => {
      previousSelected.current = selectedId;
      setSection(nextSection);
      setSelectedId(nextId);
    });
  };

  return { section, selectedId, previousSelected, navigate };
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" }).format(new Date(value));
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC",
  }).format(new Date(value));
}

function providersFor(draft: AssertionDraft, templates: readonly AuthoringTemplate[]): readonly Provider[] {
  return templates.find((template) => template.id === draft.templateId)?.providers ?? [];
}

function ProviderBadge({ provider }: { readonly provider: Provider }) {
  return <span className="provider-badge"><span aria-hidden="true">{providerGlyphs[provider]}</span>{providerNames[provider]}</span>;
}

function Pill({ tone, children }: { readonly tone: string; readonly children: ReactNode }) {
  return <span className={`pill pill--${tone}`}>{children}</span>;
}

function AppSkeleton() {
  return <div className="boot-screen"><span className="brand">needl<span className="brand-dot">.</span></span><div className="boot-line"/><p>Opening your workspace…</p></div>;
}

function AuthScreen({ onAuthenticated, signupEnabled }: { readonly onAuthenticated: () => void; readonly signupEnabled: boolean }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "signup") await signUp({ name: name.trim(), email: email.trim(), password });
      else await signIn({ email: email.trim(), password });
      onAuthenticated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Authentication failed");
    } finally { setSubmitting(false); }
  };
  return <main className="auth-shell">
    <section className="auth-card" aria-labelledby="auth-title">
      <span className="brand">needl<span className="brand-dot">.</span></span>
      <span className="eyebrow">Durable safety monitoring</span>
      <h1 id="auth-title">{mode === "signin" ? "Welcome back" : "Create your workspace"}</h1>
      <p>{mode === "signin" ? "Sign in to your private assertion workspace." : "Start with an isolated workspace and a bounded translation allowance."}</p>
      <form onSubmit={(event) => void submit(event)}>
        {mode === "signup" ? <label>Name<input autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={80}/></label> : null}
        <label>Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required/></label>
        <label>Password<input type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} value={password} onChange={(event) => setPassword(event.target.value)} required minLength={12} maxLength={128}/></label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <button className="primary-button" type="submit" disabled={submitting}>{submitting ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}</button>
      </form>
      {signupEnabled || mode === "signup" ? <button className="auth-switch" type="button" onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(null); }}>
        {mode === "signin" ? "New to Needl? Create an account" : "Already have an account? Sign in"}
      </button> : <p className="auth-closed">Account creation is invitation-only on this deployment.</p>}
    </section>
  </main>;
}

function EmptyState({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return <div className="empty-state"><div className="empty-orbit" aria-hidden="true"><span/></div><h3>{title}</h3><p>{children}</p></div>;
}

function assertionTone(draft: AssertionDraft, replay: DemoReplay | null): string {
  if (draft.status === "needs-review") return "needs-review";
  if (draft.status === "paused") return "paused";
  if (replay?.unavailableAssertionIds.includes(draft.localId)) return "unavailable";
  if (replay?.violations.some((violation) => violation.assertionId === draft.definition.id)) return "violated";
  const checkpoint = replay?.checkpoints.find((item) => item.assertionId === draft.definition.id);
  if (checkpoint?.pendingObligations.length) return "pending";
  return "monitoring";
}

function statusLabel(tone: string): string {
  return ({ violated: "Needs attention", monitoring: "Watching · No violations observed", paused: "Paused", "needs-review": "Needs review", pending: "Pending response", unavailable: "No matching evidence" })[tone] ?? tone;
}

function MeaningRule({ draft, activeField, onActiveField, onChange }: {
  readonly draft: AssertionDraft;
  readonly activeField?: string;
  readonly onActiveField?: (fieldId: string) => void;
  readonly onChange?: (fieldId: string, value: string) => void;
}) {
  const [openField, setOpenField] = useState<string | null>(null);
  if (draft.meaning === undefined) return <p className="meaning-sentence meaning-sentence--plain">{draft.expectation}</p>;
  const template = meaningTemplates[draft.meaning.templateId];
  return <p className="meaning-sentence" data-testid={`meaning-${draft.localId}`}>
    {template.sentence.map((segment, index) => {
      if (typeof segment === "string") return <Fragment key={`${segment}-${index}`}>{segment}</Fragment>;
      const field = template.fields.find((item) => item.id === segment.field)!;
      const selected = meaningOption(template.id, field.id, draft.meaning!.values[field.id] ?? "")!;
      const isOpen = openField === field.id;
      return <span className="meaning-chip-wrap" key={field.id}>
        <button
          type="button"
          className={`meaning-chip ${activeField === field.id ? "is-linked" : ""}`}
          aria-label={`${field.accessibleLabel}: ${selected.label}`}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          onFocus={() => onActiveField?.(field.id)}
          onClick={(event) => {
            event.stopPropagation();
            onActiveField?.(field.id);
            setOpenField(isOpen ? null : field.id);
          }}
        >{selected.label}</button>
        {isOpen ? <span className="meaning-popover" role="listbox" aria-label={`${field.accessibleLabel} choices`}>
          {field.options.map((option) => <button
            type="button"
            role="option"
            aria-selected={option.value === selected.value}
            key={option.value}
            onClick={(event) => {
              event.stopPropagation();
              setOpenField(null);
              if (option.value !== selected.value) onChange?.(field.id, option.value);
            }}
          ><span>{option.label}</span><small>{option.evidence === "matched" ? "Fixture evidence available" : "No matching fixture evidence"}</small></button>)}
        </span> : null}
      </span>;
    })}
  </p>;
}

function Sidebar({ section, replay, onNavigate }: {
  readonly section: Section;
  readonly replay: DemoReplay | null;
  readonly onNavigate: (section: Section) => void;
}) {
  const items: readonly { id: Section; label: string; icon: string }[] = [
    { id: "assertions", label: "Assertions", icon: "assertions" },
    { id: "activity", label: "Activity", icon: "activity" },
    { id: "connections", label: "Connections", icon: "connections" },
    { id: "settings", label: "Settings", icon: "settings" },
  ];
  return <aside className="sidebar">
    <button className="brand brand-button" onClick={() => onNavigate("assertions")} aria-label="Needl assertions home">needl<span className="brand-dot">.</span></button>
    <nav aria-label="Primary navigation">
      {items.map((item) => <button key={item.id} className={`nav-item ${section === item.id ? "is-active" : ""}`} onClick={() => onNavigate(item.id)} aria-current={section === item.id ? "page" : undefined}>
        <Icon name={item.icon}/><span>{item.label}</span>
        {item.id === "activity" && (replay?.violations.length ?? 0) > 0 ? <span className="nav-count">{replay!.violations.length}</span> : null}
      </button>)}
    </nav>
    <div className="sidebar-foot">
      <div className="connection-summary"><span className="live-dot"/>7 fixture sources</div>
      <span>Local demo · no live accounts</span>
    </div>
  </aside>;
}

function Topbar({ search, onSearch, onConnections, onSettings }: {
  readonly search: string;
  readonly onSearch: (value: string) => void;
  readonly onConnections: () => void;
  readonly onSettings: () => void;
}) {
  return <header className="topbar">
    <label className="global-search">
      <Icon name="search"/>
      <span className="sr-only">Search assertions and evidence</span>
      <input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search Acme / Production"/>
      <kbd>⌘ K</kbd>
    </label>
    <div className="top-actions">
      <button className="icon-button source-button" onClick={onConnections} aria-label="View demo sources" title="View demo sources"><span className="source-ring"><span/></span></button>
      <button className="avatar" onClick={onSettings} aria-label="Open local settings">K</button>
    </div>
  </header>;
}

function AssertionCard({ draft, templates, replay, compact, selected, onOpen, onMeaningChange }: {
  readonly draft: AssertionDraft;
  readonly templates: readonly AuthoringTemplate[];
  readonly replay: DemoReplay | null;
  readonly compact: boolean;
  readonly selected?: boolean;
  readonly onOpen: () => void;
  readonly onMeaningChange?: (fieldId: string, value: string) => void;
}) {
  const tone = assertionTone(draft, replay);
  const violationCount = replay?.violations.filter((item) => item.assertionId === draft.definition.id).length ?? 0;
  const cardStyle = { viewTransitionName: `assertion-${draft.localId.replace(/[^a-z0-9-]/gi, "-")}` } as CSSProperties;
  const template = templates.find((item) => item.id === draft.templateId);
  return <article className={`assertion-card assertion-card--${tone} ${compact ? "is-compact" : ""}`} style={selected ? undefined : cardStyle} data-testid={`assertion-card-${draft.localId}`}>
    <div className="card-hit">
      <span className="card-topline"><Pill tone={tone}>{statusLabel(tone)}</Pill><button className="card-open" onClick={onOpen} aria-label={`Open ${draft.definition.name}`}><Icon name="arrow"/></button></span>
      <h3>{draft.definition.name}</h3>
      {!compact ? <MeaningRule draft={draft} onChange={onMeaningChange}/> : <p className="compact-meaning">{draft.expectation}</p>}
      {draft.status === "needs-review" ? <p className="review-note">Preserved but disabled · {draft.reviewReason}</p> : null}
      <div className="card-footer">
        <span className="provider-list">{providersFor(draft, templates).map((provider) => <ProviderBadge provider={provider} key={provider}/>)}</span>
        {violationCount > 0 ? <span className="violation-count">{violationCount} counterexample{violationCount === 1 ? "" : "s"}</span> : template === undefined ? <span className="custom-label">Custom</span> : null}
      </div>
    </div>
  </article>;
}

function AssertionBoard({ assertions, templates, replay, selectedId, search, onCreate, onOpen, onReplay, onMeaningChange }: {
  readonly assertions: readonly AssertionDraft[];
  readonly templates: readonly AuthoringTemplate[];
  readonly replay: DemoReplay | null;
  readonly selectedId?: string;
  readonly search: string;
  readonly onCreate: (text: string) => string | undefined;
  readonly onOpen: (id: string) => void;
  readonly onReplay: (scenario: DemoReplayRequest["scenario"]) => void;
  readonly onMeaningChange: (draft: AssertionDraft, fieldId: string, value: string) => void;
}) {
  const [input, setInput] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<SortMode>("attention");
  const [compact, setCompact] = useState(false);
  const [authoringError, setAuthoringError] = useState<string | null>(null);
  const list = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const score = (draft: AssertionDraft) => ({ violated: 0, "needs-review": 1, pending: 2, unavailable: 3, monitoring: 4, paused: 5 })[assertionTone(draft, replay)] ?? 6;
    return assertions
      .filter((draft) => needle.length === 0 || `${draft.definition.name} ${draft.expectation} ${formulaText(draft)}`.toLowerCase().includes(needle))
      .filter((draft) => filter === "all" || (filter === "attention" ? ["violated", "needs-review", "pending", "unavailable"].includes(assertionTone(draft, replay)) : assertionTone(draft, replay) === filter))
      .sort((a, b) => sort === "name" ? a.definition.name.localeCompare(b.definition.name) : sort === "recent" ? b.updatedAt.localeCompare(a.updatedAt) : score(a) - score(b));
  }, [assertions, filter, replay, search, sort]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (input.trim().length === 0) return;
    const message = onCreate(input.trim());
    setAuthoringError(message ?? null);
    if (message === undefined) setInput("");
  };
  return <main className={`board ${selectedId === undefined ? "" : "has-detail"}`} id="main-content">
    <div className="board-heading">
      <div><span className="eyebrow">Acme / Production</span><h1>Assertions</h1><p>Catch a broken promise while it happens.</p></div>
      <div className="replay-control">
        <span>Deterministic demo</span>
        <button onClick={() => onReplay(replay?.scenario === "healthy" ? "violating" : "healthy")} title="Switch and replay the fixture scenario"><Icon name="replay"/>Replay {replay?.scenario === "healthy" ? "violations" : "healthy path"}</button>
      </div>
    </div>
    <form className="composer" onSubmit={submit}>
      <label htmlFor="assertion-input">What should never happen?</label>
      <div><input id="assertion-input" value={input} onChange={(event) => { setInput(event.target.value); setAuthoringError(null); }} placeholder="What should never happen?"/><button type="submit" disabled={input.trim().length === 0} aria-label="Continue authoring"><Icon name="arrow"/></button></div>
      <div className="composer-suggestions" aria-label="Safety rule suggestions">
        {["A shipped fix must not come back as the same error", "A resolved issue must never come back", "A canceled customer must never be charged again"].map((suggestion) => <button type="button" key={suggestion} onClick={() => setInput(suggestion)}>{suggestion}</button>)}
      </div>
      <span>Template-assisted interpretation · safety conditions only</span>
      {authoringError ? <p className="form-error" role="alert">{authoringError}</p> : null}
    </form>
    <div className="board-tools">
      <div className="filters" role="tablist" aria-label="Assertion filters">
        {(["all", "attention", "monitoring", "paused"] as const).map((item) => <button key={item} role="tab" aria-selected={filter === item} className={filter === item ? "is-active" : ""} onClick={() => setFilter(item)}>{item === "attention" ? "Needs attention" : item[0]!.toUpperCase() + item.slice(1)}</button>)}
      </div>
      <div className="view-tools">
        <button onClick={() => setSort(sort === "attention" ? "recent" : sort === "recent" ? "name" : "attention")}>Sort: {sort}<span aria-hidden="true">↕</span></button>
        <button className="icon-button" onClick={() => setCompact(!compact)} aria-pressed={compact} title={compact ? "Comfortable cards" : "Compact cards"}><Icon name="menu"/></button>
      </div>
    </div>
    {list.length > 0 ? <div className={`card-grid ${compact ? "is-compact" : ""}`}>{list.map((draft) => <AssertionCard key={draft.localId} draft={draft} templates={templates} replay={replay} compact={compact} selected={selectedId === draft.localId} onOpen={() => onOpen(draft.localId)} onMeaningChange={(fieldId, value) => onMeaningChange(draft, fieldId, value)}/>)}</div> : <EmptyState title="Nothing in this view">Try another filter or clear the search.</EmptyState>}
  </main>;
}

function TraceTimeline({ trace, draft, activeField, onActiveField }: {
  readonly trace: readonly MonitorTraceItem[];
  readonly draft: AssertionDraft;
  readonly activeField?: string;
  readonly onActiveField: (fieldId: string) => void;
}) {
  const linkedKinds = draft.meaning === undefined || activeField === undefined
    ? []
    : eventKindsForField(draft.meaning.templateId, activeField);
  return <ol className="trace-timeline">
    {trace.map((item) => {
      const eventField = item.type === "observation" && draft.meaning !== undefined
        ? fieldForEventKind(draft.meaning.templateId, item.source.kind)
        : undefined;
      const eventFieldLabel = eventField === undefined || draft.meaning === undefined
        ? undefined
        : meaningTemplates[draft.meaning.templateId].fields.find((field) => field.id === eventField)?.accessibleLabel;
      const highlighted = item.type === "observation" && linkedKinds.includes(item.source.kind);
      return <li key={`${item.type}-${item.inputId}`} className={highlighted ? "is-meaning-linked" : ""}>
      <span className={`timeline-mark timeline-mark--${item.type}`}>{item.position}</span>
      <div className="trace-main">
        <div><strong>{item.type === "observation" ? providerNames[item.source.provider] : item.type === "tick" ? "Clock tick" : "Finalization"}</strong><time dateTime={item.at}>{formatDateTime(item.at)} UTC</time></div>
        {item.type === "observation" ? <>
          <p>{item.source.subject.name ?? item.source.subject.id}</p>
          <div className="trace-links">
            {eventField !== undefined ? <button type="button" onClick={() => onActiveField(eventField)}>Highlight {eventFieldLabel?.toLowerCase() ?? "its role"} in the rule</button> : null}
            {item.source.links[0] !== undefined ? <a href={item.source.links[0].url} target="_blank" rel="noreferrer">Synthetic source ↗</a> : null}
          </div>
          <details className="advanced-evidence"><summary>Advanced event details</summary>
            <code>{item.source.kind}</code>
            <div className="valuation">{Object.entries(item.valuation).map(([name, value]) => <span className={value ? "is-true" : "is-false"} key={name}>{name}: {String(value)}</span>)}</div>
            <div className="predicate-explanations">{Object.entries(item.evaluations).map(([name, evaluation]) => <p key={name}><b>{name}</b> — {evaluation.explanation}</p>)}</div>
          </details>
        </> : <p>Explicit demo clock input; silence alone never advances deadlines.</p>}
      </div>
    </li>})}
  </ol>;
}

function CounterexampleView({ violation, draft, activeField, onActiveField }: {
  readonly violation: CounterexampleRecord;
  readonly draft: AssertionDraft;
  readonly activeField?: string;
  readonly onActiveField: (fieldId: string) => void;
}) {
  return <article className="counterexample">
    <header><div><span className="eyebrow">Counterexample · observed rule break</span><h3>{meaningViolationText(draft) ?? "The observed event sequence broke this rule."}</h3></div><Pill tone="violated">Detected {formatTime(violation.detectedAt)} UTC</Pill></header>
    <div className="binding-row">{Object.entries(violation.scope).map(([key, value]) => <span key={key}><small>{key}</small>{value}</span>)}</div>
    <TraceTimeline trace={violation.trace} draft={draft} activeField={activeField} onActiveField={onActiveField}/>
    <details className="advanced-evidence counterexample-engine-details"><summary>Advanced engine details</summary><dl><div><dt>Technical cause</dt><dd><code>{violation.cause}</code></dd></div><div><dt>Engine explanation</dt><dd>{violation.explanation}</dd></div></dl></details>
    <p className="evidence-note">This is a sufficient engine trace, not a minimality claim. Source references are synthetic fixture evidence.</p>
  </article>;
}

function violationSummary(draft: AssertionDraft): string {
  return meaningViolationText(draft) ?? "The observed event sequence broke this rule.";
}

function AssertionDetail({ draft, templates, replay, investigations, investigationReady, onLaunchInvestigation, onRefreshInvestigation, onClose, onToggle, onEdit, onCopy, onMeaningChange }: {
  readonly draft: AssertionDraft;
  readonly templates: readonly AuthoringTemplate[];
  readonly replay: DemoReplay | null;
  readonly investigations: readonly InvestigationRecord[];
  readonly investigationReady: boolean;
  readonly onLaunchInvestigation: (violationId: string) => void;
  readonly onRefreshInvestigation: (id: string) => void;
  readonly onClose: () => void;
  readonly onToggle: () => void;
  readonly onEdit: () => void;
  readonly onCopy: () => void;
  readonly onMeaningChange: (fieldId: string, value: string) => void;
}) {
  const [tab, setTab] = useState<DetailTab>("overview");
  const [activeField, setActiveField] = useState<string | undefined>(draft.meaning === undefined ? undefined : meaningTemplates[draft.meaning.templateId].fields[0]?.id);
  const tone = assertionTone(draft, replay);
  const violations = replay?.violations.filter((item) => item.assertionId === draft.definition.id) ?? [];
  const checkpoint = replay?.checkpoints.find((item) => item.assertionId === draft.definition.id);
  const relatedEvents = replay?.events.filter((item) => providersFor(draft, templates).includes(item.provider)) ?? [];
  const outbox = replay?.outbox.find((item) => item.assertionId === draft.definition.id);
  const latestViolation = violations.at(-1);
  const investigation = latestViolation === undefined ? undefined : investigations.find((item) => item.violationId === latestViolation.id);
  const refreshable = investigation !== undefined && investigation.workflowId !== undefined && !["completed", "failed", "stopped"].includes(investigation.status);
  const style = { viewTransitionName: `assertion-${draft.localId.replace(/[^a-z0-9-]/gi, "-")}` } as CSSProperties;
  return <aside className={`detail detail--${tone}`} style={style} aria-label={`${draft.definition.name} detail`}>
    <div className="detail-scroll">
      <header className="detail-header">
        <button className="icon-button detail-back" onClick={onClose} aria-label="Back to assertion board"><Icon name="back"/></button>
        <div className="detail-title"><span className="eyebrow">Assertion · v{draft.definition.version}</span><h2>{draft.definition.name}</h2><MeaningRule draft={draft} activeField={activeField} onActiveField={setActiveField} onChange={onMeaningChange}/></div>
        <Pill tone={tone}>{statusLabel(tone)}</Pill>
        <div className="detail-actions">
          <button onClick={onToggle} disabled={draft.status === "needs-review"} title={draft.status === "needs-review" ? "Choose a supported safety rule before enabling" : undefined}><Icon name={draft.status === "paused" ? "play" : "pause"}/>{draft.status === "paused" ? "Enable" : draft.status === "needs-review" ? "Review required" : "Pause"}</button>
          <button onClick={onEdit}><Icon name="edit"/>Edit wording</button>
        </div>
      </header>
      <div className="detail-meta">
        <span><small>Environment</small>Production</span>
        <span><small>Rule version</small>v{draft.definition.version}</span>
        <span><small>Evidence</small>{checkpoint?.processedCount ?? 0} inputs</span>
      </div>
      <nav className="detail-tabs" aria-label="Assertion detail sections">
        {(["overview", "counterexamples", "activity"] as const).map((item) => <button key={item} className={tab === item ? "is-active" : ""} onClick={() => setTab(item)}>{item[0]!.toUpperCase() + item.slice(1)}{item === "counterexamples" && violations.length ? ` (${violations.length})` : ""}</button>)}
      </nav>
      <div className="detail-content">
        {tab === "overview" ? <>
          <section className="detail-section expectation-section"><span className="section-index">01</span><div><h3>What Needl watches</h3><MeaningRule draft={draft} activeField={activeField} onActiveField={setActiveField} onChange={onMeaningChange}/><p>Each underlined phrase is part of the stored monitor. Change one to create a new version and replay the evidence.</p></div></section>
          <section className="detail-section"><span className="section-index">02</span><div><h3>Observed scope</h3><p>Events are correlated by {draft.definition.scope.keys.map((key) => key.name.replaceAll("_", " ")).join(" and ")}.</p><div className="provider-list">{providersFor(draft, templates).map((provider) => <ProviderBadge provider={provider} key={provider}/>)}</div></div></section>
          <section className="detail-section"><span className="section-index">03</span><div><h3>Investigation state</h3><div className="investigation-card"><span className="simulated-mark">{investigation?.status.toUpperCase() ?? (outbox === undefined ? "NOT REQUESTED" : "READY")}</span><div><strong>{investigation === undefined ? (outbox === undefined ? "No investigation requested" : "Counterexample ready for review") : `GitLab investigation ${investigation.status.replaceAll("_", " ")}`}</strong><p>{investigation === undefined ? (outbox === undefined ? "Needl only offers an investigation after a counterexample." : investigationReady ? "A configured, read-only GitLab flow can be started explicitly. Needl never retries an ambiguous launch." : "The durable outbox is ready, but no scoped GitLab investigation credential is configured.") : investigation.resultMessage ?? (investigation.workflowId === undefined ? "No workflow id was returned." : `Workflow ${investigation.workflowId}`)}</p>{investigation?.webUrl ? <a href={investigation.webUrl} target="_blank" rel="noreferrer">Open in GitLab</a> : null}</div><button disabled={investigation === undefined ? latestViolation === undefined || !investigationReady : !refreshable} onClick={() => investigation !== undefined ? onRefreshInvestigation(investigation.id) : latestViolation === undefined ? undefined : onLaunchInvestigation(latestViolation.id)} title={!investigationReady ? "Configure a scoped GitLab investigation integration on the backend" : investigation !== undefined && !refreshable ? "This attempt has no refreshable workflow" : undefined}>{investigation === undefined ? "Start investigation" : refreshable ? "Refresh status" : "Attempt recorded"}</button></div></div></section>
          {draft.status === "needs-review" ? <section className="review-panel"><Icon name="warning"/><div><h3>Preserved for review</h3><p>{draft.reviewReason} Your wording and advanced specification remain stored, but this rule cannot be enabled.</p></div></section> : null}
          {violations.length > 0 ? <section className="detail-section"><span className="section-index">04</span><div><h3>{violationSummary(draft)}</h3><p>Select a phrase above or an evidence link below to see how the trace supports that part of the rule.</p><CounterexampleView violation={violations.at(-1)!} draft={draft} activeField={activeField} onActiveField={setActiveField}/></div></section> : <section className="quiet-panel"><Icon name="check"/><div><h3>{tone === "unavailable" ? "No matching evidence" : "Watching · No violations observed"}</h3><p>{tone === "unavailable" ? "The selected meaning has no matching fixture evidence. This is unavailable evidence, not proof that the rule holds." : "The current fixture produced no breaking event for this assertion. Quiet sources are not treated as proof."}</p></div></section>}
        </> : null}
        {tab === "counterexamples" ? violations.length > 0 ? violations.map((violation) => <CounterexampleView key={violation.id} violation={violation} draft={draft} activeField={activeField} onActiveField={setActiveField}/>) : <EmptyState title="No counterexamples">Replay the violating fixture to exercise the monitor, or inspect the current evidence in Activity.</EmptyState> : null}
        {tab === "activity" ? <EventTable events={relatedEvents}/> : null}
      </div>
    </div>
    <footer className="detail-footer">
      <div><span>Violations · current replay</span><strong>{violations.length}</strong></div>
      <div><span>Last observed</span><strong>{checkpoint?.lastLogicalTime ? `${formatTime(checkpoint.lastLogicalTime)} UTC` : "Unavailable"}</strong></div>
      <button onClick={onCopy}><Icon name="copy"/>Copy local link</button>
    </footer>
  </aside>;
}

function EventTable({ events }: { readonly events: DemoReplay["events"] }) {
  if (events.length === 0) return <EmptyState title="No matching activity">This assertion has no provider-matched fixture events.</EmptyState>;
  return <div className="event-table">{events.map((event) => <article key={event.id}>
    <span className={`provider-icon provider-icon--${event.provider}`}>{providerGlyphs[event.provider]}</span>
    <div><strong>{event.subject.name ?? event.subject.id}</strong><p>{event.kind}</p><span>{event.relationships.map((item) => `${item.type}: ${item.id}`).join(" · ")}</span></div>
    <time dateTime={event.occurredAt}>{formatDateTime(event.occurredAt ?? event.receivedAt)} UTC</time>
  </article>)}</div>;
}

function ActivityPage({ replay }: { readonly replay: DemoReplay | null }) {
  return <main className="page" id="main-content"><div className="page-heading"><span className="eyebrow">Engine evidence log</span><h1>Activity</h1><p>Every row below comes from the currently replayed synthetic fixture.</p></div>
    <div className="page-summary"><div><span>Normalized events</span><strong>{replay?.events.length ?? 0}</strong></div><div><span>Counterexamples</span><strong>{replay?.violations.length ?? 0}</strong></div><div><span>Outbox requests</span><strong>{replay?.outbox.length ?? 0}</strong></div><div><span>Scenario</span><strong>{replay?.scenario ?? "loading"}</strong></div></div>
    <section className="page-panel"><div className="panel-heading"><div><h2>Observation timeline</h2><p>Times are fixed in UTC so replay results stay deterministic.</p></div><Pill tone="demo">Synthetic</Pill></div><EventTable events={replay?.events ?? []}/></section>
  </main>;
}

function ConnectionsPage({ replay, integrations }: { readonly replay: DemoReplay | null; readonly integrations: WorkspaceBootstrap["integrations"] }) {
  const count = (provider: Provider) => replay?.events.filter((event) => event.provider === provider).length ?? 0;
  const connected = (provider: Provider) => integrations.find((item) => item.provider === provider && item.purpose === "ingestion" && item.enabled);
  return <main className="page" id="main-content"><div className="page-heading"><span className="eyebrow">Signed evidence routes</span><h1>Connections</h1><p>Enabled routes verify provider signatures on exact request bytes before durable processing.</p></div>
    {integrations.length === 0 ? <div className="notice"><Icon name="warning"/><div><strong>Demo sources are not live connections</strong><p>No server-managed integration is configured. The visible activity remains deterministic fixture evidence and no browser secret can enable a route.</p></div></div> : <div className="notice"><Icon name="check"/><div><strong>{integrations.filter((item) => item.enabled).length} server-managed integration{integrations.filter((item) => item.enabled).length === 1 ? "" : "s"}</strong><p>Credentials remain server-side; disabled routes return not found.</p></div></div>}
    <div className="connection-grid">{providers.map((provider) => <article key={provider}><span className={`provider-icon provider-icon--${provider}`}>{providerGlyphs[provider]}</span><div><h2>{providerNames[provider]}</h2><p>{count(provider)} event{count(provider) === 1 ? "" : "s"} in current fixture</p></div><Pill tone={connected(provider) ? "monitoring" : count(provider) > 0 ? "fixture" : "unavailable"}>{connected(provider) ? "Signed route ready" : count(provider) > 0 ? "Fixture ready" : "No event"}</Pill><dl><div><dt>Mode</dt><dd>{connected(provider) ? "Durable signed ingestion" : "Read-only replay"}</dd></div><div><dt>Credentials</dt><dd>{connected(provider) ? "Server-managed" : "Not configured"}</dd></div></dl></article>)}</div>
  </main>;
}

function SettingsPage({ assertions, templates, user, onRestore, onClear, onSignOut }: {
  readonly assertions: readonly AssertionDraft[];
  readonly templates: readonly AuthoringTemplate[];
  readonly user: WorkspaceBootstrap["user"];
  readonly onRestore: () => void;
  readonly onClear: () => void;
  readonly onSignOut: () => void;
}) {
  const localCount = assertions.filter((draft) => !templates.some((template) => template.definition.id === draft.localId)).length;
  return <main className="page" id="main-content"><div className="page-heading"><span className="eyebrow">Workspace preferences</span><h1>Settings</h1><p>Signed in as {user.email}. Assertion changes are stored server-side and cached in this browser.</p></div>
    <section className="settings-panel"><div><h2>Account session</h2><p>Signing out revokes this browser session without deleting workspace data.</p></div><button onClick={onSignOut}>Sign out</button></section>
    <section className="settings-panel"><div><h2>Demo workspace</h2><p>Restore the three reviewed sample assertions. Your {localCount} locally authored assertion{localCount === 1 ? "" : "s"} will be preserved.</p></div><button onClick={onRestore}>Restore sample rules</button></section>
    <section className="settings-panel"><div><h2>Locally authored assertions</h2><p>Remove custom assertions from browser storage. This action requires confirmation and does not change engine fixtures.</p></div><button className="danger-button" onClick={onClear} disabled={localCount === 0} title={localCount === 0 ? "There are no local assertions to remove" : undefined}>Remove local assertions</button></section>
    <section className="settings-panel is-muted"><div><h2>Live provider and GitLab setup</h2><p>Unavailable in this frontend. Configure credentials, webhook routes, durable production storage, and a dispatcher on a backend before enabling live controls.</p></div><button disabled title="Live provider setup is outside this local demo">Configure live services</button></section>
  </main>;
}

function AuthoringDialog({ expectation, templates, translation, onClose, onChoose }: {
  readonly expectation: string;
  readonly templates: readonly AuthoringTemplate[];
  readonly translation: TranslationProposalResponse | null;
  readonly onClose: () => void;
  readonly onChoose: (template: AuthoringTemplate) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);
  return <div className="modal-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal authoring-modal" role="dialog" aria-modal="true" aria-labelledby="authoring-title">
      <header><div><span className="eyebrow">New assertion</span><h2 id="authoring-title">Choose an interpretation template</h2></div><button ref={closeRef} className="icon-button" onClick={onClose} aria-label="Close authoring"><Icon name="close"/></button></header>
      <div className="honesty-note"><Icon name="warning"/><p><strong>{translation === null ? "Reviewed interpretation" : "OpenAI proposal — confirmation required"}</strong>{translation === null ? <span>Natural-language AI translation is not configured.</span> : translation.proposal.explanation}{translation === null ? " Your text stays as the expectation; choose one reviewed safety meaning below." : null}</p></div>
      <blockquote>{expectation}</blockquote>
      <div className="template-list">{templates.map((template, index) => <button className={translation?.proposal.templateId === template.id ? "is-suggested" : ""} key={template.id} onClick={() => onChoose(template)}>
        <span className="template-index">0{index + 1}</span><div><strong>{template.shortLabel}</strong><p>{template.description}</p><span>{template.providers.map((provider) => providerNames[provider]).join(" · ")}</span></div><Icon name="arrow"/>
      </button>)}</div>
    </section>
  </div>;
}

function UnsupportedIntentDialog({ expectation, onClose, onAcceptAlternative }: {
  readonly expectation: string;
  readonly onClose: () => void;
  readonly onAcceptAlternative: () => void;
}) {
  return <div className="modal-layer">
    <section className="modal unsupported-modal" role="dialog" aria-modal="true" aria-labelledby="unsupported-title">
      <header><div><span className="eyebrow">Not supported as written</span><h2 id="unsupported-title">Need a breakable condition</h2></div><button className="icon-button" onClick={onClose} aria-label="Close unsupported feedback"><Icon name="close"/></button></header>
      <div className="unsupported-copy"><blockquote>{expectation}</blockquote><h3>{EVENTUALITY_EXPLANATION}</h3><p>Needl will not silently rewrite this intent. You can explicitly choose a safety alternative, or go back and describe an event that must never occur.</p></div>
      <div className="alternative-card"><span>Suggested safety alternative</span><strong>Once a customer cancels, they must never be charged again.</strong><p>This can be broken by one observed charge for that customer after their cancellation.</p></div>
      <footer><button type="button" onClick={onClose}>Go back</button><button type="button" className="primary-button" onClick={onAcceptAlternative}>Use this alternative</button></footer>
    </section>
  </div>;
}

function EditDialog({ draft, onClose, onSave }: {
  readonly draft: AssertionDraft;
  readonly onClose: () => void;
  readonly onSave: (draft: AssertionDraft) => void;
}) {
  const [expectation, setExpectation] = useState(draft.expectation);
  const [formula, setFormula] = useState(formulaText(draft));
  const [definitionJson, setDefinitionJson] = useState(JSON.stringify(draft.definition, null, 2));
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    try { onSave(updateDraft(draft, { expectation, formula, definitionJson })); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : "";
      setError(/eventually happen|deadline|supported safety shape/i.test(message)
        ? message
        : "Needl couldn’t validate this advanced specification. Check its structure and use one of the supported safety shapes.");
    }
  };
  return <div className="modal-layer"><form className="modal edit-modal" role="dialog" aria-modal="true" aria-labelledby="edit-title" onSubmit={submit}>
    <header><div><span className="eyebrow">Structured editor</span><h2 id="edit-title">Edit assertion v{draft.definition.version}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close editor"><Icon name="close"/></button></header>
    <label>Wording<textarea aria-label="Expectation" rows={2} value={expectation} onChange={(event) => setExpectation(event.target.value)}/></label>
    <details className="advanced-editor">
      <summary>Advanced specification</summary>
      <p>Expert inspection only. Product rules support global “must not” conditions and reviewed “after this, never again” conditions. Eventuality and deadline formulas are rejected.</p>
      <label>Safety formula<textarea aria-label="Formula" className="code-input" rows={3} value={formula} onChange={(event) => setFormula(event.target.value)} spellCheck={false}/></label>
      <label>Structured assertion JSON <span>Predicates use the engine’s closed JSON language; executable JavaScript is rejected.</span><textarea aria-label="Structured assertion JSON" className="code-input json-input" rows={12} value={definitionJson} onChange={(event) => setDefinitionJson(event.target.value)} spellCheck={false}/></label>
    </details>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <footer><button type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit">Validate & save v{draft.definition.version + 1}</button></footer>
  </form></div>;
}

export function App() {
  const { section, selectedId, previousSelected, navigate } = useRoute();
  const [workspace, setWorkspace] = useState<WorkspaceBootstrap | null>(null);
  const [signupAllowed, setSignupAllowed] = useState(false);
  const [durableMonitor, setDurableMonitor] = useState<MonitorSnapshot | null>(null);
  const [authGeneration, setAuthGeneration] = useState(0);
  const [templates, setTemplates] = useState<readonly AuthoringTemplate[]>([]);
  const [assertions, setAssertions] = useState<AssertionDraft[]>([]);
  const [replay, setReplay] = useState<DemoReplay | null>(null);
  const [loading, setLoading] = useState(true);
  const [replaying, setReplaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [authoringText, setAuthoringText] = useState<string | null>(null);
  const [translation, setTranslation] = useState<TranslationProposalResponse | null>(null);
  const [translating, setTranslating] = useState(false);
  const [unsupportedText, setUnsupportedText] = useState<string | null>(null);
  const [editing, setEditing] = useState<AssertionDraft | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const boardScroll = useRef(0);
  const replayGeneration = useRef(0);

  useEffect(() => { void fetchPublicConfig().then((config) => setSignupAllowed(config.signupEnabled)).catch(() => setSignupAllowed(false)); }, []);

  const runReplay = async (nextAssertions: readonly AssertionDraft[], scenario: DemoReplayRequest["scenario"] = replay?.scenario ?? "violating") => {
    const generation = ++replayGeneration.current;
    setReplaying(true);
    setError(null);
    try {
      const replayable = nextAssertions.filter((draft) => draft.status !== "needs-review");
      const nextReplay = await replayDemo({ assertions: replayable, scenario });
      if (generation === replayGeneration.current) setReplay(nextReplay);
    } catch (cause) {
      if (generation === replayGeneration.current) setError(cause instanceof Error ? cause.message : "Demo replay failed");
    } finally {
      if (generation === replayGeneration.current) setReplaying(false);
    }
  };

  useEffect(() => {
    let active = true;
    Promise.all([fetchWorkspace(), fetchBootstrap(), fetchMonitor()]).then(async ([nextWorkspace, bootstrap, monitor]) => {
      if (!active) return;
      setWorkspace(nextWorkspace);
      setDurableMonitor(monitor);
      const storageKey = storageKeyForTenant(nextWorkspace.tenantId);
      const cached = parseStoredAssertions(localStorage.getItem(storageKey) ?? localStorage.getItem("needl.assertions.v1"));
      const initial = nextWorkspace.assertions.length > 0 ? [...nextWorkspace.assertions] : mergeRestored(defaultDrafts(bootstrap.templates), cached);
      setTemplates(bootstrap.templates);
      setAssertions(initial);
      if (nextWorkspace.assertions.length === 0) {
        await Promise.all(initial.map((draft) => saveAssertion(draft)));
      }
      const generation = ++replayGeneration.current;
      try {
        const initialReplay = await replayDemo({ assertions: initial.filter((draft) => draft.status !== "needs-review"), scenario: "violating" });
        if (active && generation === replayGeneration.current) setReplay(initialReplay);
      }
      catch (cause) {
        if (active && generation === replayGeneration.current) setError(cause instanceof Error ? cause.message : "Demo replay failed");
      }
      finally { if (active) setLoading(false); }
    }).catch((cause) => { if (active) { const message = cause instanceof Error ? cause.message : "Unable to load workspace"; if (!/Authentication required/i.test(message)) setError(message); setWorkspace(null); setLoading(false); } });
    return () => { active = false; replayGeneration.current += 1; };
  }, [authGeneration]);

  useEffect(() => {
    if (!loading && workspace !== null && assertions.length > 0) localStorage.setItem(storageKeyForTenant(workspace.tenantId), serializeAssertions(assertions));
  }, [assertions, loading, workspace]);

  useEffect(() => {
    if (selectedId === undefined && previousSelected.current !== undefined) {
      requestAnimationFrame(() => {
        window.scrollTo({ top: boardScroll.current });
        document.querySelector<HTMLElement>(`[data-testid="assertion-card-${CSS.escape(previousSelected.current!)}"] .card-open`)?.focus();
        previousSelected.current = undefined;
      });
    }
  }, [previousSelected, selectedId]);

  useEffect(() => {
    if (toast === null) return;
    const timeout = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const selected = assertions.find((draft) => draft.localId === selectedId);
  const openDetail = (id: string) => { boardScroll.current = window.scrollY; navigate("assertions", id); };
  const closeDetail = () => {
    if (window.history.state?.detail === true) window.history.back();
    else navigate("assertions", undefined, true);
  };
  const updateAssertions = (next: AssertionDraft[], replayNow = true) => {
    try {
      const accepted = validateAssertionCollection(next);
      if (workspace === null) throw new Error("Authentication required");
      localStorage.setItem(storageKeyForTenant(workspace.tenantId), serializeAssertions(accepted));
      const previous = assertions;
      setAssertions(accepted);
      const writes = accepted.filter((draft) => {
        const prior = previous.find((item) => item.localId === draft.localId);
        return prior === undefined || JSON.stringify(prior) !== JSON.stringify(draft);
      }).map((draft) => saveAssertion(draft, previous.find((item) => item.localId === draft.localId)?.definition.version));
      const removals = previous.filter((draft) => !accepted.some((item) => item.localId === draft.localId)).map((draft) => removeAssertion(draft.localId));
      void Promise.all([...writes, ...removals]).catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to persist assertion changes"));
      if (replayNow) void runReplay(accepted);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invalid assertion collection");
      return false;
    }
  };
  const beginAuthoring = (text: string): string | undefined => {
    try {
      assertAssertionCapacity(assertions.length);
      if (unsupportedAuthoringIntent(text)) setUnsupportedText(text);
      else if (workspace?.translator === "available") {
        setTranslating(true);
        void translateAssertion(text).then((proposal) => { setTranslation(proposal); setAuthoringText(text); }).catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to translate assertion")).finally(() => setTranslating(false));
      } else { setTranslation(null); setAuthoringText(text); }
      return undefined;
    } catch (cause) {
      return cause instanceof Error ? cause.message : "Assertion capacity reached";
    }
  };
  const chooseTemplate = async (template: AuthoringTemplate) => {
    if (authoringText === null) return;
    if (translation?.proposal.templateId === template.id) {
      try { await confirmTranslation(translation.proposalId); }
      catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to confirm translation"); return; }
    }
    const draft = createDraftFromTemplate(authoringText, template, assertions.map((item) => item.localId));
    const next = [...assertions, draft];
    setAuthoringText(null);
    setTranslation(null);
    updateAssertions(next);
    openDetail(draft.localId);
    setToast("Draft created paused — inspect it, then enable monitoring");
  };
  const endSession = async () => {
    try { await signOut(); }
    finally {
      setWorkspace(null);
      setAssertions([]);
      setReplay(null);
      setDurableMonitor(null);
      setLoading(false);
      navigate("assertions", undefined, true);
    }
  };
  const toggleSelected = () => {
    if (selected === undefined || selected.status === "needs-review") return;
    const next = assertions.map((draft) => draft.localId === selected.localId ? { ...draft, status: draft.status === "paused" ? "monitoring" as const : "paused" as const, updatedAt: new Date().toISOString() } : draft);
    updateAssertions(next);
    setToast(selected.status === "paused" ? "Monitoring enabled for local replay" : "Assertion paused");
  };
  const saveEdit = (draft: AssertionDraft) => {
    const next = assertions.map((item) => item.localId === draft.localId ? draft : item);
    if (updateAssertions(next)) {
      setEditing(null);
      setToast(`Saved and replayed assertion v${draft.definition.version}`);
    }
  };
  const changeMeaning = (draft: AssertionDraft, fieldId: string, value: string) => {
    try {
      const edited = updateMeaningChoice(draft, fieldId, value);
      const next = assertions.map((item) => item.localId === edited.localId ? edited : item);
      if (updateAssertions(next)) setToast(`Meaning updated · now v${edited.definition.version}`);
    } catch {
      setError("That meaning choice could not be applied to the monitor.");
    }
  };
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(window.location.href); setToast("Local link copied"); }
    catch { setToast("Copy unavailable — use the address bar"); }
  };
  const restoreSamples = () => {
    const custom = assertions.filter((draft) => !templates.some((template) => template.definition.id === draft.localId));
    const next = [...defaultDrafts(templates), ...custom];
    updateAssertions(next);
    setToast("Sample assertions restored; local assertions preserved");
  };
  const clearLocal = () => {
    const localCount = assertions.filter((draft) => !templates.some((template) => template.definition.id === draft.localId)).length;
    if (localCount === 0 || !window.confirm(`Remove ${localCount} locally authored assertion${localCount === 1 ? "" : "s"}? Sample assertions will remain.`)) return;
    const next = assertions.filter((draft) => templates.some((template) => template.definition.id === draft.localId));
    updateAssertions(next);
    navigate("settings");
    setToast("Locally authored assertions removed");
  };
  const startInvestigation = async (violationId: string) => {
    try {
      const next = await launchInvestigation(violationId);
      setDurableMonitor((current) => current === null ? current : { ...current, investigations: [next, ...current.investigations.filter((item) => item.id !== next.id)] });
      setToast(next.status === "running" ? "GitLab investigation started" : `Investigation recorded as ${next.status.replaceAll("_", " ")}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to start investigation"); }
  };
  const refreshGitLabInvestigation = async (id: string) => {
    try {
      const next = await refreshInvestigation(id);
      setDurableMonitor((current) => current === null ? current : { ...current, investigations: [next, ...current.investigations.filter((item) => item.id !== next.id)] });
      setToast(`GitLab status: ${next.status.replaceAll("_", " ")}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to refresh investigation"); }
  };

  // Live webhook results (e.g. from the simulator) are recorded under the workspace tenant; sample replay data is not.
  const evidence = useMemo<DemoReplay | null>(() => {
    if (replay === null || durableMonitor === null || workspace === null) return replay;
    const tenantId = workspace.tenantId;
    const liveViolations = durableMonitor.counterexamples.filter((item) => item.tenantId === tenantId);
    return {
      ...replay,
      events: [...replay.events, ...durableMonitor.events.filter((item) => item.tenantId === tenantId)],
      checkpoints: [...durableMonitor.checkpoints.filter((item) => item.tenantId === tenantId), ...replay.checkpoints],
      violations: [...replay.violations, ...liveViolations].sort((a, b) => a.detectedAt.localeCompare(b.detectedAt)),
      outbox: [...replay.outbox, ...durableMonitor.outbox.filter((item) => item.tenantId === tenantId)],
    };
  }, [replay, durableMonitor, workspace]);

  useEffect(() => {
    if (loading || workspace === null) return;
    const interval = window.setInterval(() => { void fetchMonitor().then(setDurableMonitor).catch(() => undefined); }, 2500);
    return () => window.clearInterval(interval);
  }, [loading, workspace]);

  if (loading) return <AppSkeleton/>;
  if (workspace === null) return <AuthScreen signupEnabled={signupAllowed} onAuthenticated={() => { setLoading(true); setError(null); setAuthGeneration((value) => value + 1); }}/>;
  return <div className={`app-shell ${selected !== undefined ? "detail-open" : ""}`}>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <Sidebar section={section} replay={evidence} onNavigate={(next) => navigate(next)}/>
    <Topbar search={search} onSearch={setSearch} onConnections={() => navigate("connections")} onSettings={() => navigate("settings")}/>
    <div className="workspace">
      {section === "assertions" ? <AssertionBoard assertions={assertions} templates={templates} replay={evidence} selectedId={selected?.localId} search={search} onCreate={beginAuthoring} onOpen={openDetail} onReplay={(scenario) => void runReplay(assertions, scenario)} onMeaningChange={changeMeaning}/> : null}
      {section === "activity" ? <ActivityPage replay={evidence}/> : null}
      {section === "connections" ? <ConnectionsPage replay={evidence} integrations={workspace.integrations}/> : null}
      {section === "settings" ? <SettingsPage assertions={assertions} templates={templates} user={workspace.user} onRestore={restoreSamples} onClear={clearLocal} onSignOut={() => void endSession()}/> : null}
      {selected !== undefined && section === "assertions" ? <AssertionDetail draft={selected} templates={templates} replay={evidence} investigations={durableMonitor?.investigations ?? []} investigationReady={workspace.integrations.some((item) => item.provider === "gitlab" && item.purpose === "investigation" && item.enabled)} onLaunchInvestigation={(violationId) => void startInvestigation(violationId)} onRefreshInvestigation={(id) => void refreshGitLabInvestigation(id)} onClose={closeDetail} onToggle={toggleSelected} onEdit={() => setEditing(selected)} onCopy={() => void copyLink()} onMeaningChange={(fieldId, value) => changeMeaning(selected, fieldId, value)}/> : null}
    </div>
    {replaying || translating ? <div className="replaying" role="status"><span/>{translating ? "Translating into a reviewed safety shape…" : "Replaying through engine…"}</div> : null}
    {error ? <div className="error-banner" role="alert"><strong>Needl error</strong>{error}<button onClick={() => setError(null)} aria-label="Dismiss error"><Icon name="close"/></button></div> : null}
    {toast ? <div className="toast" role="status">{toast}</div> : null}
    {authoringText !== null ? <AuthoringDialog expectation={authoringText} templates={templates} translation={translation} onClose={() => { setAuthoringText(null); setTranslation(null); }} onChoose={(template) => void chooseTemplate(template)}/> : null}
    {unsupportedText !== null ? <UnsupportedIntentDialog expectation={unsupportedText} onClose={() => setUnsupportedText(null)} onAcceptAlternative={() => { setUnsupportedText(null); setAuthoringText("Once a customer cancels, they must never be charged again"); }}/> : null}
    {editing !== null ? <EditDialog draft={editing} onClose={() => setEditing(null)} onSave={saveEdit}/> : null}
  </div>;
}
