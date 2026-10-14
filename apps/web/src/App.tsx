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
import { createDraftFromTemplate, formulaText, updateDraft } from "./authoring.js";
import { fetchBootstrap, replayDemo } from "./api.js";
import type {
  AssertionDraft,
  AuthoringTemplate,
  DemoReplay,
  DemoReplayRequest,
} from "./domain.js";
import { STORAGE_KEY } from "./domain.js";
import { Icon } from "./icons.js";
import { parseStoredAssertions, serializeAssertions } from "./storage.js";

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
    createdAt: "2026-02-18T10:39:00.000Z",
    updatedAt: "2026-02-18T10:39:00.000Z",
  }));
}

function mergeRestored(defaults: readonly AssertionDraft[], restored: readonly AssertionDraft[]): AssertionDraft[] {
  const saved = new Map(restored.map((draft) => [draft.localId, draft]));
  const merged = defaults.map((draft) => saved.get(draft.localId) ?? draft);
  for (const draft of restored) if (!defaults.some((item) => item.localId === draft.localId)) merged.push(draft);
  return merged;
}

function routeFromLocation(): { section: Section; selectedId?: string } {
  const parts = window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const section = (["assertions", "activity", "connections", "settings"] as const).includes(parts[0] as Section)
    ? parts[0] as Section
    : "assertions";
  return { section, ...(section === "assertions" && parts[1] !== undefined ? { selectedId: decodeURIComponent(parts[1]) } : {}) };
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
  return <div className="boot-screen"><span className="brand">needl<span className="brand-dot">.</span></span><div className="boot-line"/><p>Preparing deterministic demo…</p></div>;
}

function EmptyState({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return <div className="empty-state"><div className="empty-orbit" aria-hidden="true"><span/></div><h3>{title}</h3><p>{children}</p></div>;
}

function assertionTone(draft: AssertionDraft, replay: DemoReplay | null): string {
  if (draft.status === "paused") return "paused";
  if (replay?.unavailableAssertionIds.includes(draft.localId)) return "unavailable";
  if (replay?.violations.some((violation) => violation.assertionId === draft.definition.id)) return "violated";
  const checkpoint = replay?.checkpoints.find((item) => item.assertionId === draft.definition.id);
  if (checkpoint?.pendingObligations.length) return "pending";
  return "monitoring";
}

function statusLabel(tone: string): string {
  return ({ violated: "Needs attention", monitoring: "Monitoring", paused: "Paused", pending: "Pending response", unavailable: "No matching evidence" })[tone] ?? tone;
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

function AssertionCard({ draft, templates, replay, compact, onOpen }: {
  readonly draft: AssertionDraft;
  readonly templates: readonly AuthoringTemplate[];
  readonly replay: DemoReplay | null;
  readonly compact: boolean;
  readonly onOpen: () => void;
}) {
  const tone = assertionTone(draft, replay);
  const violationCount = replay?.violations.filter((item) => item.assertionId === draft.definition.id).length ?? 0;
  const cardStyle = { viewTransitionName: `assertion-${draft.localId.replace(/[^a-z0-9-]/gi, "-")}` } as CSSProperties;
  const template = templates.find((item) => item.id === draft.templateId);
  return <article className={`assertion-card assertion-card--${tone} ${compact ? "is-compact" : ""}`} style={cardStyle} data-testid={`assertion-card-${draft.localId}`}>
    <button className="card-hit" onClick={onOpen} aria-label={`Open ${draft.definition.name}`}>
      <span className="card-topline"><Pill tone={tone}>{statusLabel(tone)}</Pill><Icon name="arrow"/></span>
      <h3>{draft.definition.name}</h3>
      <p>{draft.expectation}</p>
      {!compact ? <div className="rule-preview">
        <span>{draft.definition.formula.kind === "deadline" ? "WITHIN" : "RULE"}</span>
        <code>{formulaText(draft)}</code>
      </div> : null}
      <div className="card-footer">
        <span className="provider-list">{providersFor(draft, templates).map((provider) => <ProviderBadge provider={provider} key={provider}/>)}</span>
        {violationCount > 0 ? <span className="violation-count">{violationCount} counterexample{violationCount === 1 ? "" : "s"}</span> : template === undefined ? <span className="custom-label">Custom</span> : null}
      </div>
    </button>
  </article>;
}

function AssertionBoard({ assertions, templates, replay, selectedId, search, onCreate, onOpen, onReplay }: {
  readonly assertions: readonly AssertionDraft[];
  readonly templates: readonly AuthoringTemplate[];
  readonly replay: DemoReplay | null;
  readonly selectedId?: string;
  readonly search: string;
  readonly onCreate: (text: string) => void;
  readonly onOpen: (id: string) => void;
  readonly onReplay: (scenario: DemoReplayRequest["scenario"]) => void;
}) {
  const [input, setInput] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<SortMode>("attention");
  const [compact, setCompact] = useState(false);
  const list = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const score = (draft: AssertionDraft) => ({ violated: 0, pending: 1, unavailable: 2, monitoring: 3, paused: 4 })[assertionTone(draft, replay)] ?? 5;
    return assertions
      .filter((draft) => needle.length === 0 || `${draft.definition.name} ${draft.expectation} ${formulaText(draft)}`.toLowerCase().includes(needle))
      .filter((draft) => filter === "all" || (filter === "attention" ? ["violated", "pending", "unavailable"].includes(assertionTone(draft, replay)) : assertionTone(draft, replay) === filter))
      .sort((a, b) => sort === "name" ? a.definition.name.localeCompare(b.definition.name) : sort === "recent" ? b.updatedAt.localeCompare(a.updatedAt) : score(a) - score(b));
  }, [assertions, filter, replay, search, sort]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (input.trim().length === 0) return;
    onCreate(input.trim());
    setInput("");
  };
  return <main className={`board ${selectedId === undefined ? "" : "has-detail"}`} id="main-content">
    <div className="board-heading">
      <div><span className="eyebrow">Acme / Production</span><h1>Assertions</h1><p>What should stay true?</p></div>
      <div className="replay-control">
        <span>Deterministic demo</span>
        <button onClick={() => onReplay(replay?.scenario === "healthy" ? "violating" : "healthy")} title="Switch and replay the fixture scenario"><Icon name="replay"/>Replay {replay?.scenario === "healthy" ? "violations" : "healthy path"}</button>
      </div>
    </div>
    <form className="composer" onSubmit={submit}>
      <label htmlFor="assertion-input">Describe an expectation</label>
      <div><input id="assertion-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder="When a fix is deployed, the linked issue should not recur"/><button type="submit" disabled={input.trim().length === 0}><Icon name="arrow"/><span className="sr-only">Continue authoring</span></button></div>
      <span>Template-guided local authoring · arbitrary rules use the structured editor</span>
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
    {list.length > 0 ? <div className={`card-grid ${compact ? "is-compact" : ""}`}>{list.map((draft) => <AssertionCard key={draft.localId} draft={draft} templates={templates} replay={replay} compact={compact} onOpen={() => onOpen(draft.localId)}/>)}</div> : <EmptyState title="Nothing in this view">Try another filter or clear the search.</EmptyState>}
  </main>;
}

function TraceTimeline({ trace }: { readonly trace: readonly MonitorTraceItem[] }) {
  return <ol className="trace-timeline">
    {trace.map((item) => <li key={`${item.type}-${item.inputId}`}>
      <span className={`timeline-mark timeline-mark--${item.type}`}>{item.position}</span>
      <div className="trace-main">
        <div><strong>{item.type === "observation" ? providerNames[item.source.provider] : item.type === "tick" ? "Clock tick" : "Finalization"}</strong><time dateTime={item.at}>{formatDateTime(item.at)} UTC</time></div>
        {item.type === "observation" ? <>
          <p>{item.source.subject.name ?? item.source.subject.id}</p>
          <code>{item.source.kind}</code>
          <div className="valuation">{Object.entries(item.valuation).map(([name, value]) => <span className={value ? "is-true" : "is-false"} key={name}>{name}: {String(value)}</span>)}</div>
          <details><summary>Predicate explanations</summary>{Object.entries(item.evaluations).map(([name, evaluation]) => <p key={name}><b>{name}</b> — {evaluation.explanation}</p>)}</details>
        </> : <p>Explicit demo clock input; silence alone never advances deadlines.</p>}
      </div>
    </li>)}
  </ol>;
}

function CounterexampleView({ violation }: { readonly violation: CounterexampleRecord }) {
  return <article className="counterexample">
    <header><div><span className="eyebrow">Counterexample · {violation.cause.replaceAll("_", " ")}</span><h3>{violation.explanation}</h3></div><Pill tone="violated">Detected {formatTime(violation.detectedAt)} UTC</Pill></header>
    <div className="binding-row">{Object.entries(violation.scope).map(([key, value]) => <span key={key}><small>{key}</small>{value}</span>)}</div>
    <TraceTimeline trace={violation.trace}/>
    <p className="evidence-note">This is a sufficient engine trace, not a minimality claim. Source references are synthetic fixture evidence.</p>
  </article>;
}

function AssertionDetail({ draft, templates, replay, onClose, onToggle, onEdit, onCopy }: {
  readonly draft: AssertionDraft;
  readonly templates: readonly AuthoringTemplate[];
  readonly replay: DemoReplay | null;
  readonly onClose: () => void;
  readonly onToggle: () => void;
  readonly onEdit: () => void;
  readonly onCopy: () => void;
}) {
  const [tab, setTab] = useState<DetailTab>("overview");
  const tone = assertionTone(draft, replay);
  const violations = replay?.violations.filter((item) => item.assertionId === draft.definition.id) ?? [];
  const checkpoint = replay?.checkpoints.find((item) => item.assertionId === draft.definition.id);
  const relatedEvents = replay?.events.filter((item) => providersFor(draft, templates).includes(item.provider)) ?? [];
  const style = { viewTransitionName: `assertion-${draft.localId.replace(/[^a-z0-9-]/gi, "-")}` } as CSSProperties;
  return <aside className={`detail detail--${tone}`} style={style} aria-label={`${draft.definition.name} detail`}>
    <div className="detail-scroll">
      <header className="detail-header">
        <button className="icon-button detail-back" onClick={onClose} aria-label="Back to assertion board"><Icon name="back"/></button>
        <div className="detail-title"><span className="eyebrow">Assertion · v{draft.definition.version}</span><h2>{draft.definition.name}</h2><p>{draft.expectation}</p></div>
        <Pill tone={tone}>{statusLabel(tone)}</Pill>
        <div className="detail-actions">
          <button onClick={onToggle}><Icon name={draft.status === "paused" ? "play" : "pause"}/>{draft.status === "paused" ? "Enable" : "Pause"}</button>
          <button onClick={onEdit}><Icon name="edit"/>Edit rule</button>
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
          <section className="detail-section expectation-section"><span className="section-index">01</span><div><h3>Interpreted rule</h3><p>{draft.expectation}</p><code className="formula-block">{formulaText(draft)}</code></div></section>
          <section className="detail-section"><span className="section-index">02</span><div><h3>Scope & signals</h3><div className="scope-grid">{draft.definition.scope.keys.map((key) => <span key={key.name}><small>Bind by</small>{key.name}</span>)}{draft.definition.propositions.map((proposition) => <span key={proposition.name}><small>Predicate</small>{proposition.name}</span>)}</div></div></section>
          <section className="detail-section"><span className="section-index">03</span><div><h3>Response policy</h3><div className="investigation-card"><span className="simulated-mark">SIMULATED</span><div><strong>GitLab investigation request</strong><p>A real counterexample creates a durable outbox item. Live dispatch is not configured in this local demo.</p></div><button disabled title="Configure a live GitLab dispatcher on the backend to launch investigations">Launch unavailable</button></div></div></section>
          {violations.length > 0 ? <section className="detail-section"><span className="section-index">04</span><div><h3>Latest counterexample</h3><CounterexampleView violation={violations.at(-1)!}/></div></section> : <section className="quiet-panel"><Icon name="check"/><div><h3>No violation in this replay</h3><p>{tone === "unavailable" ? "The fixture did not bind this custom scope. This is unavailable evidence, not proof of satisfaction." : "The active fixture produced no bad prefix for this assertion. Quiet sources are not treated as proof."}</p></div></section>}
        </> : null}
        {tab === "counterexamples" ? violations.length > 0 ? violations.map((violation) => <CounterexampleView key={violation.id} violation={violation}/>) : <EmptyState title="No counterexamples">Replay the violating fixture to exercise the monitor, or inspect the current evidence in Activity.</EmptyState> : null}
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

function ConnectionsPage({ replay }: { readonly replay: DemoReplay | null }) {
  const count = (provider: Provider) => replay?.events.filter((event) => event.provider === provider).length ?? 0;
  return <main className="page" id="main-content"><div className="page-heading"><span className="eyebrow">Local fixture catalog</span><h1>Connections</h1><p>No provider account is connected. These sources are deterministic event fixtures only.</p></div>
    <div className="notice"><Icon name="warning"/><div><strong>Demo sources are not live connections</strong><p>Webhook authentication and normalization live in the engine package; this browser journey sends no provider requests and uses no secrets.</p></div></div>
    <div className="connection-grid">{providers.map((provider) => <article key={provider}><span className={`provider-icon provider-icon--${provider}`}>{providerGlyphs[provider]}</span><div><h2>{providerNames[provider]}</h2><p>{count(provider)} event{count(provider) === 1 ? "" : "s"} in current fixture</p></div><Pill tone={count(provider) > 0 ? "fixture" : "unavailable"}>{count(provider) > 0 ? "Fixture ready" : "No event"}</Pill><dl><div><dt>Mode</dt><dd>Read-only replay</dd></div><div><dt>Credentials</dt><dd>Not configured</dd></div></dl></article>)}</div>
  </main>;
}

function SettingsPage({ assertions, templates, onRestore, onClear }: {
  readonly assertions: readonly AssertionDraft[];
  readonly templates: readonly AuthoringTemplate[];
  readonly onRestore: () => void;
  readonly onClear: () => void;
}) {
  const localCount = assertions.filter((draft) => !templates.some((template) => template.definition.id === draft.localId)).length;
  return <main className="page" id="main-content"><div className="page-heading"><span className="eyebrow">Browser-local preferences</span><h1>Settings</h1><p>Local demo state is kept in this browser only.</p></div>
    <section className="settings-panel"><div><h2>Demo workspace</h2><p>Restore the three reviewed sample assertions. Your {localCount} locally authored assertion{localCount === 1 ? "" : "s"} will be preserved.</p></div><button onClick={onRestore}>Restore sample rules</button></section>
    <section className="settings-panel"><div><h2>Locally authored assertions</h2><p>Remove custom assertions from browser storage. This action requires confirmation and does not change engine fixtures.</p></div><button className="danger-button" onClick={onClear} disabled={localCount === 0} title={localCount === 0 ? "There are no local assertions to remove" : undefined}>Remove local assertions</button></section>
    <section className="settings-panel is-muted"><div><h2>Live provider and GitLab setup</h2><p>Unavailable in this frontend. Configure credentials, webhook routes, durable production storage, and a dispatcher on a backend before enabling live controls.</p></div><button disabled title="Live provider setup is outside this local demo">Configure live services</button></section>
  </main>;
}

function AuthoringDialog({ expectation, templates, onClose, onChoose }: {
  readonly expectation: string;
  readonly templates: readonly AuthoringTemplate[];
  readonly onClose: () => void;
  readonly onChoose: (template: AuthoringTemplate) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);
  return <div className="modal-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal authoring-modal" role="dialog" aria-modal="true" aria-labelledby="authoring-title">
      <header><div><span className="eyebrow">New assertion</span><h2 id="authoring-title">Choose an interpretation template</h2></div><button ref={closeRef} className="icon-button" onClick={onClose} aria-label="Close authoring"><Icon name="close"/></button></header>
      <div className="honesty-note"><Icon name="warning"/><p><strong>Template-guided authoring</strong>Natural-language AI translation is not configured. Your text stays as the expectation; you choose an explicit, reviewed rule shape below and can edit its formula and JSON next.</p></div>
      <blockquote>{expectation}</blockquote>
      <div className="template-list">{templates.map((template, index) => <button key={template.id} onClick={() => onChoose(template)}>
        <span className="template-index">0{index + 1}</span><div><strong>{template.shortLabel}</strong><p>{template.description}</p><span>{template.providers.map((provider) => providerNames[provider]).join(" · ")}</span></div><Icon name="arrow"/>
      </button>)}</div>
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
    catch (cause) { setError(cause instanceof Error ? cause.message : "Invalid structured assertion"); }
  };
  return <div className="modal-layer"><form className="modal edit-modal" role="dialog" aria-modal="true" aria-labelledby="edit-title" onSubmit={submit}>
    <header><div><span className="eyebrow">Structured editor</span><h2 id="edit-title">Edit assertion v{draft.definition.version}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close editor"><Icon name="close"/></button></header>
    <label>Expectation<textarea rows={2} value={expectation} onChange={(event) => setExpectation(event.target.value)}/></label>
    <label>Formula <span>ordinary LTL text, or JSON for a deadline</span><textarea className="code-input" rows={3} value={formula} onChange={(event) => setFormula(event.target.value)} spellCheck={false}/></label>
    <label>Structured assertion JSON <span>predicates use the engine’s closed JSON language; executable JavaScript is rejected</span><textarea className="code-input json-input" rows={12} value={definitionJson} onChange={(event) => setDefinitionJson(event.target.value)} spellCheck={false}/></label>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <footer><button type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit">Validate & save v{draft.definition.version + 1}</button></footer>
  </form></div>;
}

export function App() {
  const { section, selectedId, previousSelected, navigate } = useRoute();
  const [templates, setTemplates] = useState<readonly AuthoringTemplate[]>([]);
  const [assertions, setAssertions] = useState<AssertionDraft[]>([]);
  const [replay, setReplay] = useState<DemoReplay | null>(null);
  const [loading, setLoading] = useState(true);
  const [replaying, setReplaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [authoringText, setAuthoringText] = useState<string | null>(null);
  const [editing, setEditing] = useState<AssertionDraft | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const boardScroll = useRef(0);

  const runReplay = async (nextAssertions: readonly AssertionDraft[], scenario: DemoReplayRequest["scenario"] = replay?.scenario ?? "violating") => {
    setReplaying(true);
    setError(null);
    try { setReplay(await replayDemo({ assertions: nextAssertions, scenario })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Demo replay failed"); }
    finally { setReplaying(false); }
  };

  useEffect(() => {
    let active = true;
    fetchBootstrap().then(async (bootstrap) => {
      if (!active) return;
      const initial = mergeRestored(defaultDrafts(bootstrap.templates), parseStoredAssertions(localStorage.getItem(STORAGE_KEY)));
      setTemplates(bootstrap.templates);
      setAssertions(initial);
      try { setReplay(await replayDemo({ assertions: initial, scenario: "violating" })); }
      catch (cause) { if (active) setError(cause instanceof Error ? cause.message : "Demo replay failed"); }
      finally { if (active) setLoading(false); }
    }).catch((cause) => { if (active) { setError(cause instanceof Error ? cause.message : "Unable to load demo"); setLoading(false); } });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!loading && assertions.length > 0) localStorage.setItem(STORAGE_KEY, serializeAssertions(assertions));
  }, [assertions, loading]);

  useEffect(() => {
    if (selectedId === undefined && previousSelected.current !== undefined) {
      requestAnimationFrame(() => {
        window.scrollTo({ top: boardScroll.current });
        document.querySelector<HTMLElement>(`[data-testid="assertion-card-${CSS.escape(previousSelected.current!)}"] .card-hit`)?.focus();
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
    setAssertions(next);
    if (replayNow) void runReplay(next);
  };
  const chooseTemplate = (template: AuthoringTemplate) => {
    if (authoringText === null) return;
    const draft = createDraftFromTemplate(authoringText, template, assertions.map((item) => item.localId));
    const next = [...assertions, draft];
    setAuthoringText(null);
    updateAssertions(next);
    openDetail(draft.localId);
    setToast("Draft created paused — inspect it, then enable monitoring");
  };
  const toggleSelected = () => {
    if (selected === undefined) return;
    const next = assertions.map((draft) => draft.localId === selected.localId ? { ...draft, status: draft.status === "paused" ? "monitoring" as const : "paused" as const, updatedAt: new Date().toISOString() } : draft);
    updateAssertions(next);
    setToast(selected.status === "paused" ? "Monitoring enabled for local replay" : "Assertion paused");
  };
  const saveEdit = (draft: AssertionDraft) => {
    const next = assertions.map((item) => item.localId === draft.localId ? draft : item);
    setEditing(null);
    updateAssertions(next);
    setToast(`Saved and replayed assertion v${draft.definition.version}`);
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

  if (loading) return <AppSkeleton/>;
  return <div className={`app-shell ${selected !== undefined ? "detail-open" : ""}`}>
    <a className="skip-link" href="#main-content">Skip to content</a>
    <Sidebar section={section} replay={replay} onNavigate={(next) => navigate(next)}/>
    <Topbar search={search} onSearch={setSearch} onConnections={() => navigate("connections")} onSettings={() => navigate("settings")}/>
    <div className="workspace">
      {section === "assertions" ? <AssertionBoard assertions={assertions} templates={templates} replay={replay} selectedId={selected?.localId} search={search} onCreate={setAuthoringText} onOpen={openDetail} onReplay={(scenario) => void runReplay(assertions, scenario)}/> : null}
      {section === "activity" ? <ActivityPage replay={replay}/> : null}
      {section === "connections" ? <ConnectionsPage replay={replay}/> : null}
      {section === "settings" ? <SettingsPage assertions={assertions} templates={templates} onRestore={restoreSamples} onClear={clearLocal}/> : null}
      {selected !== undefined && section === "assertions" ? <AssertionDetail draft={selected} templates={templates} replay={replay} onClose={closeDetail} onToggle={toggleSelected} onEdit={() => setEditing(selected)} onCopy={() => void copyLink()}/> : null}
    </div>
    {replaying ? <div className="replaying" role="status"><span/>Replaying through engine…</div> : null}
    {error ? <div className="error-banner" role="alert"><strong>Local demo error</strong>{error}<button onClick={() => setError(null)} aria-label="Dismiss error"><Icon name="close"/></button></div> : null}
    {toast ? <div className="toast" role="status">{toast}</div> : null}
    {authoringText !== null ? <AuthoringDialog expectation={authoringText} templates={templates} onClose={() => setAuthoringText(null)} onChoose={chooseTemplate}/> : null}
    {editing !== null ? <EditDialog draft={editing} onClose={() => setEditing(null)} onSave={saveEdit}/> : null}
  </div>;
}
