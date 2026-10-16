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
import { createPortal } from "react-dom";
import type { Provider } from "../../../src/core/types.js";
import type { CounterexampleRecord, MonitorTraceItem } from "../../../src/ltl/runtime-types.js";
import { checkRule, type CheckedRule, type RuleIssue } from "../../../src/rules/check.js";
import { choiceIssues, type ParamValue, type ParamValues } from "../../../src/rules/compile.js";
import { choiceText, readRule, readingText, type ReadingMode, type ReadingSegment } from "../../../src/rules/render.js";
import { parseDuration } from "../../../src/rules/syntax.js";
import { formulaText } from "./authoring.js";
import { confirmTranslation, fetchBootstrap, fetchChoiceSuggestions, fetchMonitor, fetchPublicConfig, fetchWorkspace, launchInvestigation, refreshInvestigation, removeAssertion, replayDemo, saveAssertion, signIn, signOut, signUp, translateAssertion } from "./api.js";
import { assertAssertionCapacity, validateAssertionCollection } from "./collection.js";
import type {
  AssertionDraft,
  ChoiceSuggestions,
  DemoReplay,
  DemoReplayRequest,
  InvestigationRecord,
  MonitorSnapshot,
  TranslationProposalResponse,
  WorkspaceBootstrap,
} from "./domain.js";
import { DEMO_TENANT_ID, MAX_ASSERTIONS } from "./domain.js";
import { Icon } from "./icons.js";
import { parseStoredAssertions, serializeAssertions, storageKeyForTenant } from "./storage.js";
import type { ExampleRule } from "./examples.js";
import { checkedRule, createDraftFromRule, exampleDraft, ruleProviders, updateRuleChoice, updateRuleSource } from "./ruleDrafts.js";

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

function defaultDrafts(examples: readonly ExampleRule[]): AssertionDraft[] {
  return examples.map((example) => exampleDraft(example));
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

function providersFor(draft: AssertionDraft): readonly Provider[] {
  return ruleProviders(draft);
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

function choiceValueFromText(type: ChoiceSuggestions["type"], text: string): ParamValue | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (type === "number") return Number.isFinite(Number(trimmed)) ? Number(trimmed) : undefined;
  if (type === "boolean") return trimmed === "true" ? true : trimmed === "false" ? false : undefined;
  if (type === "duration") return parseDuration(trimmed) === undefined ? undefined : trimmed;
  return trimmed;
}

/** One `$` choice inside a reading: a dropdown of suggestions from this workspace's events, plus free text when allowed. */
function ChoiceChip({ segment, source, value, onChoose }: {
  readonly segment: Extract<ReadingSegment, { kind: "choice" }>;
  readonly source: string;
  readonly value: ParamValue | undefined;
  readonly onChoose?: (value: ParamValue) => void;
}) {
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<ChoiceSuggestions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [picked, setPicked] = useState<readonly (string | number | boolean)[]>(Array.isArray(value) ? value : []);
  const chipRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<{ readonly top: number; readonly left: number } | null>(null);
  // The list floats above the page (portal + fixed position), so it never pushes text around or gets clipped by a scrolling panel.
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = chipRef.current?.getBoundingClientRect();
      if (rect === undefined) return;
      const width = Math.min(300, window.innerWidth * 0.8);
      const height = popoverRef.current?.offsetHeight ?? 0;
      const below = rect.bottom + 8;
      const top = below + height > window.innerHeight - 8 && rect.top - 8 - height > 8 ? rect.top - 8 - height : below;
      setPosition({ top, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) });
    };
    place();
    const frame = requestAnimationFrame(place);
    const close = (event: Event) => {
      const target = event.target as Node | null;
      if (target !== null && (popoverRef.current?.contains(target) || chipRef.current?.contains(target))) return;
      setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); chipRef.current?.focus(); } };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open, suggestions]);
  useEffect(() => {
    if (!open || suggestions !== null) return;
    let active = true;
    void fetchChoiceSuggestions(source)
      .then((result) => { if (active) setSuggestions(result.suggestions.find((item) => item.param === segment.param) ?? null); })
      .catch((cause) => { if (active) setLoadError(cause instanceof Error ? cause.message : "Suggestions unavailable"); });
    return () => { active = false; };
  }, [open, suggestions, source, segment.param]);
  const label = segment.text ?? `choose ${segment.label}`;
  const editable = onChoose !== undefined;
  const choose = (next: ParamValue) => { setOpen(false); onChoose?.(next); };
  return <span className="meaning-chip-wrap">
    <button
      ref={chipRef}
      type="button"
      className={`meaning-chip choice-chip ${segment.text === undefined ? "is-empty" : ""}`}
      aria-label={`${segment.label}: ${segment.text ?? "not chosen"}`}
      aria-haspopup={editable ? "listbox" : undefined}
      aria-expanded={editable ? open : undefined}
      disabled={!editable}
      onClick={(event) => { event.stopPropagation(); setOpen(!open); }}
    >{label}</button>
    {open ? createPortal(<span ref={popoverRef} className="meaning-popover choice-popover" role="listbox" aria-label={`${segment.label} choices`} aria-multiselectable={suggestions?.list ? true : undefined} style={{ top: position?.top ?? -9999, left: position?.left ?? -9999 }} onClick={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
      {loadError !== null ? <small className="choice-note">{loadError}</small> : null}
      {suggestions === null && loadError === null ? <small className="choice-note">Looking at your events…</small> : null}
      {suggestions?.values.map((option) => {
        const selected = suggestions.list ? picked.includes(option.value) : value === option.value;
        const seen = option.counts.flatMap((count, place) => count > 0 ? [`${count} × ${suggestions.usages[place]!.split(".").slice(0, -1).join(".")}`] : []);
        const evidence = suggestions.type === "duration" ? undefined : seen.length === 0
          ? option.fixed ? "Allowed by the provider · no events yet" : "No events yet"
          : seen.join(" · ");
        return <button type="button" role="option" aria-selected={selected} key={String(option.value)} onClick={() => {
          if (!suggestions.list) { choose(option.value); return; }
          setPicked(selected ? picked.filter((item) => item !== option.value) : [...picked, option.value]);
        }}><span>{option.label}</span>{evidence === undefined ? null : <small>{evidence}</small>}</button>;
      })}
      {suggestions?.values.length === 0 ? <small className="choice-note">No {segment.label} values seen yet. Type one below.</small> : null}
      {suggestions?.freeText ? <form className="choice-free" onSubmit={(event) => {
        event.preventDefault();
        const next = choiceValueFromText(suggestions.type, typed);
        if (next === undefined) return;
        if (suggestions.list) { setPicked([...picked, next as string | number | boolean]); setTyped(""); }
        else choose(next);
      }}><input aria-label={`Type a ${segment.label}`} value={typed} onChange={(event) => setTyped(event.target.value)} placeholder={suggestions.type === "duration" ? "e.g. 2m, 45m, 3h" : `Type a ${segment.label}`}/><button type="submit">Use</button></form> : null}
      {suggestions?.list ? <button type="button" className="choice-apply" disabled={picked.length === 0} onClick={() => choose(picked)}>Apply {picked.length} value{picked.length === 1 ? "" : "s"}</button> : null}
    </span>, document.body) : null}
  </span>;
}

function ReadingView({ segments, source, values, onChoose }: {
  readonly segments: readonly ReadingSegment[];
  readonly source: string;
  readonly values: ParamValues;
  readonly onChoose?: (param: string, value: ParamValue) => void;
}) {
  return <>{segments.map((segment, index) => {
    switch (segment.kind) {
      case "text": return <Fragment key={index}>{segment.text}</Fragment>;
      case "value": return <span className="rule-value" key={index}>{segment.text}</span>;
      case "duration": return <span className="rule-duration" key={index}>{segment.text}</span>;
      case "bound": return <span className="rule-bound" key={index}>{segment.text}</span>;
      case "choice": return <ChoiceChip key={index} segment={segment} source={source} value={values[segment.param]} onChoose={onChoose === undefined ? undefined : (value) => onChoose(segment.param, value)}/>;
    }
  })}</>;
}

/** The assertion's rule read back as English; `$` choices are dropdowns when `onChoose` is given. */
function RuleReading({ draft, mode = "notes", onChoose }: {
  readonly draft: AssertionDraft;
  readonly mode?: ReadingMode;
  readonly onChoose?: (param: string, value: ParamValue) => void;
}) {
  const reading = useMemo(() => {
    if (draft.rule === undefined) return undefined;
    try { return readRule(checkedRule(draft.rule.source), draft.rule.values, mode); } catch { return undefined; }
  }, [draft.rule, mode]);
  if (draft.rule === undefined || reading === undefined) return <p className="meaning-sentence meaning-sentence--plain">{draft.expectation}</p>;
  return <p className="meaning-sentence" data-testid={`reading-${draft.localId}`}>
    <ReadingView segments={reading} source={draft.rule.source} values={draft.rule.values} onChoose={onChoose}/>
  </p>;
}

function ruleReadingText(draft: AssertionDraft): string {
  if (draft.rule === undefined) return draft.expectation;
  try { return readingText(readRule(checkedRule(draft.rule.source), draft.rule.values, "notes")); } catch { return draft.expectation; }
}

function Sidebar({ section, replay, liveSources, onNavigate }: {
  readonly section: Section;
  readonly replay: DemoReplay | null;
  readonly liveSources: number;
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
      <div className="connection-summary"><span className="live-dot"/>{liveSources > 0 ? `${liveSources} live source${liveSources === 1 ? "" : "s"}` : "Sample data only"}</div>
      <span>{liveSources > 0 ? "Signed webhooks + sample replay" : "No live connections"}</span>
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

function AssertionCard({ draft, replay, compact, selected, onOpen, onChoose }: {
  readonly draft: AssertionDraft;
  readonly replay: DemoReplay | null;
  readonly compact: boolean;
  readonly selected?: boolean;
  readonly onOpen: () => void;
  readonly onChoose?: (param: string, value: ParamValue) => void;
}) {
  const tone = assertionTone(draft, replay);
  const violationCount = replay?.violations.filter((item) => item.assertionId === draft.definition.id).length ?? 0;
  return <article className={`assertion-card assertion-card--${tone} ${compact ? "is-compact" : ""} ${selected ? "is-selected" : ""}`} data-testid={`assertion-card-${draft.localId}`}>
    <div className="card-hit">
      <span className="card-topline"><Pill tone={tone}>{statusLabel(tone)}</Pill><button className="card-open" onClick={onOpen} aria-label={`Open ${draft.definition.name}`}><Icon name="arrow"/></button></span>
      <h3>{draft.definition.name}</h3>
      {!compact ? <RuleReading draft={draft} onChoose={onChoose}/> : <p className="compact-meaning">{draft.expectation}</p>}
      {draft.status === "needs-review" ? <p className="review-note">Preserved but disabled · {draft.reviewReason}</p> : null}
      <div className="card-footer">
        <span className="provider-list">{providersFor(draft).map((provider) => <ProviderBadge provider={provider} key={provider}/>)}</span>
        {violationCount > 0 ? <span className="violation-count">{violationCount} counterexample{violationCount === 1 ? "" : "s"}</span> : draft.exampleId === undefined ? <span className="custom-label">Custom</span> : null}
      </div>
    </div>
  </article>;
}

function AssertionBoard({ assertions, replay, selectedId, search, onCreate, onOpen, onReplay, onChoose }: {
  readonly assertions: readonly AssertionDraft[];
  readonly replay: DemoReplay | null;
  readonly selectedId?: string;
  readonly search: string;
  readonly onCreate: (text: string) => string | undefined;
  readonly onOpen: (id: string) => void;
  readonly onReplay: (scenario: DemoReplayRequest["scenario"]) => void;
  readonly onChoose: (draft: AssertionDraft, param: string, value: ParamValue) => void;
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
      .filter((draft) => needle.length === 0 || `${draft.definition.name} ${draft.expectation} ${ruleReadingText(draft)} ${draft.rule?.source ?? ""} ${formulaText(draft)}`.toLowerCase().includes(needle))
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
        <span>Sample replay</span>
        <button onClick={() => onReplay(replay?.scenario === "healthy" ? "violating" : "healthy")} title="Switch and replay the sample scenario"><Icon name="replay"/>Replay {replay?.scenario === "healthy" ? "violations" : "healthy path"}</button>
      </div>
    </div>
    <form className="composer" onSubmit={submit}>
      <label htmlFor="assertion-input">What should never happen?</label>
      <div><input id="assertion-input" value={input} onChange={(event) => { setInput(event.target.value); setAuthoringError(null); }} placeholder="What should never happen?"/><button type="submit" disabled={input.trim().length === 0} aria-label="Continue authoring"><Icon name="arrow"/></button></div>
      <div className="composer-suggestions" aria-label="Safety rule suggestions">
        {["A shipped fix must not come back as the same error", "A resolved issue must never come back", "A canceled customer must never be charged again"].map((suggestion) => <button type="button" key={suggestion} onClick={() => setInput(suggestion)}>{suggestion}</button>)}
      </div>
      <span>Written as a checked Needl rule · safety conditions only</span>
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
    {list.length > 0 ? <div className={`card-grid ${compact ? "is-compact" : ""}`}>{list.map((draft) => <AssertionCard key={draft.localId} draft={draft} replay={replay} compact={compact} selected={selectedId === draft.localId} onOpen={() => onOpen(draft.localId)} onChoose={(param, value) => onChoose(draft, param, value)}/>)}</div> : <EmptyState title="Nothing in this view">Try another filter or clear the search.</EmptyState>}
  </main>;
}

function TraceTimeline({ trace, sample }: {
  readonly trace: readonly MonitorTraceItem[];
  readonly sample: boolean;
}) {
  return <ol className="trace-timeline">
    {trace.map((item) => <li key={`${item.type}-${item.inputId}`}>
      <span className={`timeline-mark timeline-mark--${item.type}`}>{item.position}</span>
      <div className="trace-main">
        <div><strong>{item.type === "observation" ? providerNames[item.source.provider] : item.type === "tick" ? "Clock tick" : "Finalization"}</strong><time dateTime={item.at}>{formatDateTime(item.at)} UTC</time></div>
        {item.type === "observation" ? <>
          <p>{item.source.subject.name ?? item.source.subject.id}</p>
          <div className="trace-links">
            {item.captured !== undefined ? <span className="trace-captured">{Object.entries(item.captured).map(([name, value]) => `${name.replaceAll("_", " ")} = ${value ?? "not found"}`).join(" · ")}</span> : null}
            {item.source.links[0] !== undefined ? <a href={item.source.links[0].url} target="_blank" rel="noreferrer">{sample ? "Sample source" : "Source"} ↗</a> : null}
          </div>
          <details className="advanced-evidence"><summary>Advanced event details</summary>
            <code>{item.source.providerEventType}</code>
            <div className="valuation">{Object.entries(item.valuation).map(([name, value]) => <span className={value ? "is-true" : "is-false"} key={name}>{name}: {String(value)}</span>)}</div>
            <div className="predicate-explanations">{Object.entries(item.evaluations).map(([name, evaluation]) => <p key={name}><b>{name}</b> — {evaluation.explanation}</p>)}</div>
          </details>
        </> : <p>{item.type === "tick" ? "Time passed with no event; a time limit in the rule ran out." : "The trace was explicitly completed."}</p>}
      </div>
    </li>)}
  </ol>;
}

function CounterexampleView({ violation, draft }: {
  readonly violation: CounterexampleRecord;
  readonly draft: AssertionDraft;
}) {
  return <article className="counterexample">
    <header><div><span className="eyebrow">Counterexample · observed rule break</span><h3>{violationSummary(draft, violation)}</h3></div>{violation.tenantId === DEMO_TENANT_ID ? null : <Pill tone="monitoring">Live</Pill>}<Pill tone="violated">Detected {formatTime(violation.detectedAt)} UTC</Pill></header>
    <div className="binding-row">{Object.entries(violation.scope).filter(([key]) => key !== "rule").map(([key, value]) => <span key={key}><small>{key.replaceAll("_", " ")}</small>{value}</span>)}</div>
    <TraceTimeline trace={violation.trace} sample={violation.tenantId === DEMO_TENANT_ID}/>
    <details className="advanced-evidence counterexample-engine-details"><summary>Advanced engine details</summary><dl><div><dt>Technical cause</dt><dd><code>{violation.cause}</code></dd></div><div><dt>Engine explanation</dt><dd>{violation.explanation}</dd></div></dl></details>
    <p className="evidence-note">This is a sufficient engine trace, not a minimality claim. {violation.tenantId === DEMO_TENANT_ID ? "Source references are sample evidence." : "Built from signed webhooks received by this workspace."}</p>
  </article>;
}

function violationSummary(draft: AssertionDraft, violation?: CounterexampleRecord): string {
  if (violation?.cause === "deadline_expired") return `${draft.definition.name}: a time limit ran out`;
  return `${draft.definition.name} was broken`;
}

function AssertionDetail({ draft, replay, investigations, investigationReady, onLaunchInvestigation, onRefreshInvestigation, onClose, onToggle, onEdit, onCopy, onChoose }: {
  readonly draft: AssertionDraft;
  readonly replay: DemoReplay | null;
  readonly investigations: readonly InvestigationRecord[];
  readonly investigationReady: boolean;
  readonly onLaunchInvestigation: (violationId: string) => void;
  readonly onRefreshInvestigation: (id: string) => void;
  readonly onClose: () => void;
  readonly onToggle: () => void;
  readonly onEdit: () => void;
  readonly onCopy: () => void;
  readonly onChoose: (param: string, value: ParamValue) => void;
}) {
  const [tab, setTab] = useState<DetailTab>("overview");
  const [exact, setExact] = useState(false);
  const tone = assertionTone(draft, replay);
  const violations = replay?.violations.filter((item) => item.assertionId === draft.definition.id) ?? [];
  const checkpoint = replay?.checkpoints.find((item) => item.assertionId === draft.definition.id);
  const relatedEvents = replay?.events.filter((item) => providersFor(draft).includes(item.provider)) ?? [];
  const choices = draft.rule === undefined ? [] : (() => {
    try { return checkedRule(draft.rule.source).params; } catch { return []; }
  })();
  const outbox = replay?.outbox.find((item) => item.assertionId === draft.definition.id);
  const latestViolation = violations.at(-1);
  const investigation = latestViolation === undefined ? undefined : investigations.find((item) => item.violationId === latestViolation.id);
  const refreshable = investigation !== undefined && investigation.workflowId !== undefined && !["completed", "failed", "stopped"].includes(investigation.status);
  // The panel is its own element that slides in and out; it is not the card morphing into a sidebar.
  const style = { viewTransitionName: "assertion-detail" } as CSSProperties;
  return <aside className={`detail detail--${tone}`} style={style} aria-label={`${draft.definition.name} detail`}>
    <div className="detail-scroll">
      <header className="detail-header">
        <button className="icon-button detail-back" onClick={onClose} aria-label="Back to assertion board"><Icon name="back"/></button>
        <div className="detail-title"><span className="eyebrow">Assertion · v{draft.definition.version}</span><h2>{draft.definition.name}</h2><p className="detail-expectation">“{draft.expectation}”</p></div>
        <Pill tone={tone}>{statusLabel(tone)}</Pill>
        <div className="detail-actions">
          <button onClick={onToggle} disabled={draft.status === "needs-review"} title={draft.status === "needs-review" ? "Choose a supported safety rule before enabling" : undefined}><Icon name={draft.status === "paused" ? "play" : "pause"}/>{draft.status === "paused" ? "Enable" : draft.status === "needs-review" ? "Review required" : "Pause"}</button>
          <button onClick={onEdit}><Icon name="edit"/>Edit rule</button>
        </div>
      </header>
      <div className="detail-meta">
        {choices.map((param) => <span key={param.name}><small>{param.label}</small>{choiceText(param, draft.rule?.values[param.name]) ?? "Not chosen"}</span>)}
        <span><small>Rule version</small>v{draft.definition.version}</span>
        <span><small>Evidence</small>{checkpoint?.processedCount ?? 0} inputs</span>
      </div>
      <nav className="detail-tabs" aria-label="Assertion detail sections">
        {(["overview", "counterexamples", "activity"] as const).map((item) => <button key={item} className={tab === item ? "is-active" : ""} onClick={() => setTab(item)}>{item[0]!.toUpperCase() + item.slice(1)}{item === "counterexamples" && violations.length ? ` (${violations.length})` : ""}</button>)}
      </nav>
      <div className="detail-content">
        {tab === "overview" ? <>
          <section className="detail-section expectation-section"><span className="section-index">01</span><div>
            <div className="reading-heading"><h3>What Needl watches</h3>{draft.rule !== undefined ? <button type="button" className="reading-toggle" aria-pressed={exact} onClick={() => setExact(!exact)}>{exact ? "Show plain reading" : "Show exact reading"}</button> : null}</div>
            <RuleReading draft={draft} mode={exact ? "mechanical" : "notes"} onChoose={onChoose}/>
            <p>{exact ? "The exact reading is generated from the rule itself, word for word." : "Underlined phrases are your choices; changing one saves a new version."}{draft.rule !== undefined && !exact ? " The exact reading shows precisely what the rule checks." : ""}</p>
            {draft.rule !== undefined ? <details className="rule-source"><summary>Rule</summary><pre>{draft.rule.source}</pre></details> : null}
          </div></section>
          <section className="detail-section"><span className="section-index">02</span><div><h3>Observed scope</h3><p>{draft.definition.scope.keys.some((key) => key.name !== "rule") ? `Each ${draft.definition.scope.keys.map((key) => key.name.replaceAll("_", " ")).join(" and ")} is watched separately.` : "One shared monitor watches every matching event."}</p><div className="provider-list">{providersFor(draft).map((provider) => <ProviderBadge provider={provider} key={provider}/>)}</div></div></section>
          <section className="detail-section"><span className="section-index">03</span><div><h3>Investigation state</h3><div className="investigation-card"><span className="simulated-mark">{investigation?.status.toUpperCase() ?? (outbox === undefined ? "NOT REQUESTED" : "READY")}</span><div><strong>{investigation === undefined ? (outbox === undefined ? "No investigation requested" : "Counterexample ready for review") : `GitLab investigation ${investigation.status.replaceAll("_", " ")}`}</strong><p>{investigation === undefined ? (outbox === undefined ? "Needl only offers an investigation after a counterexample." : investigationReady ? "A configured, read-only GitLab flow can be started explicitly. Needl never retries an ambiguous launch." : "The durable outbox is ready, but no scoped GitLab investigation credential is configured.") : investigation.resultMessage ?? (investigation.workflowId === undefined ? "No workflow id was returned." : `Workflow ${investigation.workflowId}`)}</p>{investigation?.webUrl ? <a href={investigation.webUrl} target="_blank" rel="noreferrer">Open in GitLab</a> : null}</div><button disabled={investigation === undefined ? latestViolation === undefined || !investigationReady : !refreshable} onClick={() => investigation !== undefined ? onRefreshInvestigation(investigation.id) : latestViolation === undefined ? undefined : onLaunchInvestigation(latestViolation.id)} title={!investigationReady ? "Configure a scoped GitLab investigation integration on the backend" : investigation !== undefined && !refreshable ? "This attempt has no refreshable workflow" : undefined}>{investigation === undefined ? "Start investigation" : refreshable ? "Refresh status" : "Attempt recorded"}</button></div></div></section>
          {draft.status === "needs-review" ? <section className="review-panel"><Icon name="warning"/><div><h3>Preserved for review</h3><p>{draft.reviewReason} Your wording and advanced specification remain stored, but this rule cannot be enabled.</p></div></section> : null}
          {violations.length > 0 ? <section className="detail-section"><span className="section-index">04</span><div><h3>Latest counterexample</h3><p>The events below are the evidence: in this order, they break the rule above.</p><CounterexampleView violation={violations.at(-1)!} draft={draft}/></div></section> : <section className="quiet-panel"><Icon name="check"/><div><h3>{tone === "unavailable" ? "No matching evidence" : "Watching · No violations observed"}</h3><p>{tone === "unavailable" ? "The selected meaning has no matching evidence yet. This is unavailable evidence, not proof that the rule holds." : "No breaking event has been observed for this assertion. Quiet sources are not treated as proof."}</p></div></section>}
        </> : null}
        {tab === "counterexamples" ? violations.length > 0 ? violations.map((violation) => <CounterexampleView key={violation.id} violation={violation} draft={draft}/>) : <EmptyState title="No counterexamples">Replay the violating sample, send a breaking event through a connected source, or inspect the current evidence in Activity.</EmptyState> : null}
        {tab === "activity" ? <EventTable events={relatedEvents}/> : null}
      </div>
    </div>
    <footer className="detail-footer">
      <div><span>Counterexamples</span><strong>{violations.length}</strong></div>
      <div><span>Last observed</span><strong>{checkpoint?.lastLogicalTime ? `${formatTime(checkpoint.lastLogicalTime)} UTC` : "Unavailable"}</strong></div>
      <button onClick={onCopy}><Icon name="copy"/>Copy local link</button>
    </footer>
  </aside>;
}

function EventTable({ events }: { readonly events: DemoReplay["events"] }) {
  if (events.length === 0) return <EmptyState title="No matching activity">This assertion has no provider-matched events yet.</EmptyState>;
  return <div className="event-table">{events.map((event) => <article key={event.id}>
    <span className={`provider-icon provider-icon--${event.provider}`}>{providerGlyphs[event.provider]}</span>
    <div><strong>{event.subject.name ?? event.subject.id}</strong><p>{event.kind}</p><span>{event.relationships.map((item) => `${item.type}: ${item.id}`).join(" · ")}</span></div>
    <time dateTime={event.occurredAt}>{formatDateTime(event.occurredAt ?? event.receivedAt)} UTC</time>
  </article>)}</div>;
}

function ActivityPage({ replay }: { readonly replay: DemoReplay | null }) {
  return <main className="page" id="main-content"><div className="page-heading"><span className="eyebrow">Engine evidence log</span><h1>Activity</h1><p>Sample replay events plus signed webhooks received by this workspace.</p></div>
    <div className="page-summary"><div><span>Normalized events</span><strong>{replay?.events.length ?? 0}</strong></div><div><span>Counterexamples</span><strong>{replay?.violations.length ?? 0}</strong></div><div><span>Outbox requests</span><strong>{replay?.outbox.length ?? 0}</strong></div><div><span>Scenario</span><strong>{replay?.scenario ?? "loading"}</strong></div></div>
    <section className="page-panel"><div className="panel-heading"><div><h2>Observation timeline</h2><p>All times are UTC.</p></div></div><EventTable events={replay?.events ?? []}/></section>
  </main>;
}

function ConnectionsPage({ replay, integrations }: { readonly replay: DemoReplay | null; readonly integrations: WorkspaceBootstrap["integrations"] }) {
  const count = (provider: Provider) => replay?.events.filter((event) => event.provider === provider).length ?? 0;
  const connected = (provider: Provider) => integrations.find((item) => item.provider === provider && item.purpose === "ingestion" && item.enabled);
  return <main className="page" id="main-content"><div className="page-heading"><span className="eyebrow">Signed evidence routes</span><h1>Connections</h1><p>Enabled routes verify provider signatures on exact request bytes before durable processing.</p></div>
    {integrations.length === 0 ? <div className="notice"><Icon name="warning"/><div><strong>Demo sources are not live connections</strong><p>No server-managed integration is configured. Activity shows sample replay data only, and no browser secret can enable a route.</p></div></div> : <div className="notice"><Icon name="check"/><div><strong>{integrations.filter((item) => item.enabled).length} server-managed integration{integrations.filter((item) => item.enabled).length === 1 ? "" : "s"}</strong><p>Credentials remain server-side; disabled routes return not found.</p></div></div>}
    <div className="connection-grid">{providers.map((provider) => <article key={provider}><span className={`provider-icon provider-icon--${provider}`}>{providerGlyphs[provider]}</span><div><h2>{providerNames[provider]}</h2><p>{count(provider)} event{count(provider) === 1 ? "" : "s"} received</p></div><Pill tone={connected(provider) ? "monitoring" : count(provider) > 0 ? "fixture" : "unavailable"}>{connected(provider) ? "Signed route ready" : count(provider) > 0 ? "Sample only" : "No event"}</Pill><dl><div><dt>Mode</dt><dd>{connected(provider) ? "Durable signed ingestion" : "Sample replay"}</dd></div><div><dt>Credentials</dt><dd>{connected(provider) ? "Server-managed" : "Not configured"}</dd></div></dl></article>)}</div>
  </main>;
}

function SettingsPage({ assertions, examples, user, onRestore, onClear, onSignOut }: {
  readonly assertions: readonly AssertionDraft[];
  readonly examples: readonly ExampleRule[];
  readonly user: WorkspaceBootstrap["user"];
  readonly onRestore: () => void;
  readonly onClear: () => void;
  readonly onSignOut: () => void;
}) {
  const localCount = assertions.filter((draft) => !examples.some((example) => example.id === draft.localId)).length;
  return <main className="page" id="main-content"><div className="page-heading"><span className="eyebrow">Workspace preferences</span><h1>Settings</h1><p>Signed in as {user.email}. Assertion changes are stored server-side and cached in this browser.</p></div>
    <section className="settings-panel"><div><h2>Account session</h2><p>Signing out revokes this browser session without deleting workspace data.</p></div><button onClick={onSignOut}>Sign out</button></section>
    <section className="settings-panel"><div><h2>Demo workspace</h2><p>Restore the three reviewed sample assertions. Your {localCount} locally authored assertion{localCount === 1 ? "" : "s"} will be preserved.</p></div><button onClick={onRestore}>Restore sample rules</button></section>
    <section className="settings-panel"><div><h2>Locally authored assertions</h2><p>Remove custom assertions from browser storage. This action requires confirmation and does not change sample data.</p></div><button className="danger-button" onClick={onClear} disabled={localCount === 0} title={localCount === 0 ? "There are no local assertions to remove" : undefined}>Remove local assertions</button></section>
    <section className="settings-panel is-muted"><div><h2>Live provider and GitLab setup</h2><p>Unavailable in this frontend. Configure credentials, webhook routes, durable production storage, and a dispatcher on a backend before enabling live controls.</p></div><button disabled title="Live provider setup is outside this local demo">Configure live services</button></section>
  </main>;
}

function RuleIssues({ issues }: { readonly issues: readonly RuleIssue[] }) {
  if (issues.length === 0) return null;
  return <ul className="rule-errors" role="alert">{issues.map((issue, index) => <li key={index}><code>{issue.span.line}:{issue.span.column}</code>{issue.message}</li>)}</ul>;
}

/** Live check of rule text being edited: errors, or the checked rule with its choices. */
function useRuleDraft(source: string): { readonly rule?: CheckedRule; readonly issues: readonly RuleIssue[] } {
  return useMemo(() => {
    if (source.trim().length === 0) return { issues: [] };
    const result = checkRule(source);
    return result.ok ? { rule: result.rule, issues: [] } : { issues: result.errors };
  }, [source]);
}

function RuleEditor({ source, values, onSource, onChoose, exact, onExact }: {
  readonly source: string;
  readonly values: ParamValues;
  readonly onSource: (source: string) => void;
  readonly onChoose: (param: string, value: ParamValue) => void;
  readonly exact: boolean;
  readonly onExact: (exact: boolean) => void;
}) {
  const { rule, issues } = useRuleDraft(source);
  const missing = rule === undefined ? [] : choiceIssues(rule, values).filter((issue) => rule.params.some((param) => param.name === issue.param));
  return <div className="rule-editor">
    {rule !== undefined ? <div className="rule-preview">
      <div className="reading-heading"><span className="eyebrow">Needl will watch</span><button type="button" className="reading-toggle" aria-pressed={exact} onClick={() => onExact(!exact)}>{exact ? "Show plain reading" : "Show exact reading"}</button></div>
      <p className="meaning-sentence" data-testid="rule-preview"><ReadingView segments={readRule(rule, values, exact ? "mechanical" : "notes")} source={source} values={values} onChoose={onChoose}/></p>
      {missing.length > 0 ? <p className="choice-missing">{missing.map((issue) => issue.message).join(" · ")}</p> : null}
    </div> : null}
    <RuleIssues issues={issues}/>
    <details className="advanced-editor" open={rule === undefined && source.trim().length > 0 ? true : undefined}>
      <summary>Rule</summary>
      <p>Rules name each integration’s own events, such as <code>gitlab.deployment</code>, and combine them with <code>and</code>, <code>or</code>, <code>-&gt;</code>, <code>never</code>, <code>always</code>, <code>unless</code> and time limits like <code>eventually within 30m</code>. <code>bind</code> keeps a value from one event for later parts; <code>$name</code> is a choice you make. Only rules that can be caught breaking are accepted.</p>
      <label>Rule source<textarea aria-label="Rule source" className="code-input rule-input" rows={10} value={source} onChange={(event) => onSource(event.target.value)} spellCheck={false}/></label>
    </details>
  </div>;
}

function AuthoringDialog({ expectation, examples, translation, translatorAvailable, onClose, onCreate }: {
  readonly expectation: string;
  readonly examples: readonly ExampleRule[];
  readonly translation: TranslationProposalResponse | null;
  readonly translatorAvailable: boolean;
  readonly onClose: () => void;
  readonly onCreate: (input: { readonly source: string; readonly values: ParamValues; readonly name?: string; readonly exampleId?: ExampleRule["id"] }) => void;
}) {
  const proposal = translation?.proposal;
  const [source, setSource] = useState(proposal?.supported ? proposal.source ?? "" : "");
  const [values, setValues] = useState<ParamValues>(proposal?.supported ? proposal.values ?? {} : {});
  const [name, setName] = useState<string | undefined>(proposal?.supported ? proposal.name : undefined);
  const [exampleId, setExampleId] = useState<ExampleRule["id"] | undefined>(undefined);
  const [exact, setExact] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);
  const { rule } = useRuleDraft(source);
  const ready = rule !== undefined && choiceIssues(rule, values).length === 0;
  // Starting from an example keeps the person's own sentence as the rule's name.
  const startFrom = (example: ExampleRule) => { setSource(example.source); setValues(example.values); setName(undefined); setExampleId(example.id); };
  const note = translation === null
    ? { title: translatorAvailable ? "Write the rule" : "AI authoring is not configured", body: "Start from an example below or write the rule yourself; Needl checks it before anything runs." }
    : proposal?.supported
      ? { title: "OpenAI wrote this rule — check it before it runs", body: proposal.explanation }
      : { title: "OpenAI could not write this as a rule", body: `${proposal?.rejectionReason ?? proposal?.explanation ?? ""} Rephrase it, start from an example, or write the rule yourself.` };
  return <div className="modal-layer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal authoring-modal" role="dialog" aria-modal="true" aria-labelledby="authoring-title">
      <header><div><span className="eyebrow">New assertion</span><h2 id="authoring-title">Review the rule</h2></div><button ref={closeRef} className="icon-button" onClick={onClose} aria-label="Close authoring"><Icon name="close"/></button></header>
      <div className="honesty-note"><Icon name="warning"/><p><strong>{note.title}</strong><span>{note.body}</span></p></div>
      <blockquote>{expectation}</blockquote>
      <RuleEditor source={source} values={values} onSource={(next) => { setSource(next); setExampleId(undefined); }} onChoose={(param, value) => setValues({ ...values, [param]: value })} exact={exact} onExact={setExact}/>
      <div className="example-heading"><span className="eyebrow">Start from an example</span></div>
      <div className="template-list">{examples.map((example, index) => <button className={exampleId === example.id ? "is-suggested" : ""} key={example.id} onClick={() => startFrom(example)}>
        <span className="template-index">0{index + 1}</span><div><strong>{example.name}</strong><p>{example.prompt}</p><span>{example.providers.map((provider) => providerNames[provider]).join(" · ")}</span></div><Icon name="arrow"/>
      </button>)}</div>
      <footer className="authoring-footer"><button type="button" onClick={onClose}>Cancel</button><button type="button" className="primary-button" disabled={!ready} onClick={() => onCreate({ source, values, ...(name === undefined ? {} : { name }), ...(exampleId === undefined ? {} : { exampleId }) })}>Create paused rule</button></footer>
    </section>
  </div>;
}

function EditDialog({ draft, onClose, onSave }: {
  readonly draft: AssertionDraft;
  readonly onClose: () => void;
  readonly onSave: (draft: AssertionDraft) => void;
}) {
  const [expectation, setExpectation] = useState(draft.expectation);
  const [name, setName] = useState(draft.definition.name);
  const [source, setSource] = useState(draft.rule?.source ?? "");
  const [values, setValues] = useState<ParamValues>(draft.rule?.values ?? {});
  const [exact, setExact] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    try { onSave(updateRuleSource(draft, { expectation, name, source, values })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Needl couldn’t check this rule."); }
  };
  return <div className="modal-layer"><form className="modal edit-modal" role="dialog" aria-modal="true" aria-labelledby="edit-title" onSubmit={submit}>
    <header><div><span className="eyebrow">Rule editor</span><h2 id="edit-title">Edit assertion v{draft.definition.version}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close editor"><Icon name="close"/></button></header>
    <label>Name<input aria-label="Name" value={name} onChange={(event) => setName(event.target.value)} maxLength={120}/></label>
    <label>Wording<textarea aria-label="Expectation" rows={2} value={expectation} onChange={(event) => setExpectation(event.target.value)}/></label>
    {draft.rule === undefined ? <p className="edit-legacy">This older assertion was saved before rules existed. Write a rule below to replace it.</p> : null}
    <RuleEditor source={source} values={values} onSource={setSource} onChoose={(param, value) => setValues({ ...values, [param]: value })} exact={exact} onExact={setExact}/>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    <footer><button type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit">Check & save v{draft.definition.version + 1}</button></footer>
  </form></div>;
}

export function App() {
  const { section, selectedId, previousSelected, navigate } = useRoute();
  const [workspace, setWorkspace] = useState<WorkspaceBootstrap | null>(null);
  const [signupAllowed, setSignupAllowed] = useState(false);
  const [durableMonitor, setDurableMonitor] = useState<MonitorSnapshot | null>(null);
  const [authGeneration, setAuthGeneration] = useState(0);
  const [examples, setExamples] = useState<readonly ExampleRule[]>([]);
  const [assertions, setAssertions] = useState<AssertionDraft[]>([]);
  const [replay, setReplay] = useState<DemoReplay | null>(null);
  const [loading, setLoading] = useState(true);
  const [replaying, setReplaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [authoringText, setAuthoringText] = useState<string | null>(null);
  const [translation, setTranslation] = useState<TranslationProposalResponse | null>(null);
  const [translating, setTranslating] = useState(false);
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
      const initial = nextWorkspace.assertions.length > 0 ? [...nextWorkspace.assertions] : mergeRestored(defaultDrafts(bootstrap.examples), cached);
      setExamples(bootstrap.examples);
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
      if (workspace?.translator === "available") {
        setTranslating(true);
        void translateAssertion(text).then((proposal) => { setTranslation(proposal); setAuthoringText(text); }).catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to translate assertion")).finally(() => setTranslating(false));
      } else { setTranslation(null); setAuthoringText(text); }
      return undefined;
    } catch (cause) {
      return cause instanceof Error ? cause.message : "Assertion capacity reached";
    }
  };
  const createRule = async (input: { readonly source: string; readonly values: ParamValues; readonly name?: string; readonly exampleId?: ExampleRule["id"] }) => {
    if (authoringText === null) return;
    if (translation?.proposal.supported && translation.proposal.source === input.source) {
      try { await confirmTranslation(translation.proposalId); }
      catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to confirm translation"); return; }
    }
    let draft: AssertionDraft;
    try {
      draft = createDraftFromRule({ expectation: authoringText, ...(input.name === undefined ? {} : { name: input.name }), rule: { source: input.source, values: input.values }, ...(input.exampleId === undefined ? {} : { exampleId: input.exampleId }), existingIds: assertions.map((item) => item.localId) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to create the rule"); return; }
    const next = [...assertions, draft];
    setAuthoringText(null);
    setTranslation(null);
    updateAssertions(next);
    openDetail(draft.localId);
    setToast("Rule created paused — check it, then enable monitoring");
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
  const changeChoice = (draft: AssertionDraft, param: string, value: ParamValue) => {
    try {
      const edited = updateRuleChoice(draft, param, value);
      const next = assertions.map((item) => item.localId === edited.localId ? edited : item);
      if (updateAssertions(next)) setToast(`Choice updated · now v${edited.definition.version}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That choice could not be applied to the monitor.");
    }
  };
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(window.location.href); setToast("Local link copied"); }
    catch { setToast("Copy unavailable — use the address bar"); }
  };
  const restoreSamples = () => {
    const custom = assertions.filter((draft) => !examples.some((example) => example.id === draft.localId));
    const next = [...defaultDrafts(examples), ...custom];
    updateAssertions(next);
    setToast("Sample assertions restored; local assertions preserved");
  };
  const clearLocal = () => {
    const localCount = assertions.filter((draft) => !examples.some((example) => example.id === draft.localId)).length;
    if (localCount === 0 || !window.confirm(`Remove ${localCount} locally authored assertion${localCount === 1 ? "" : "s"}? Sample assertions will remain.`)) return;
    const next = assertions.filter((draft) => examples.some((example) => example.id === draft.localId));
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
    <Sidebar section={section} replay={evidence} liveSources={workspace.integrations.filter((item) => item.purpose === "ingestion" && item.enabled).length} onNavigate={(next) => navigate(next)}/>
    <Topbar search={search} onSearch={setSearch} onConnections={() => navigate("connections")} onSettings={() => navigate("settings")}/>
    <div className="workspace">
      {section === "assertions" ? <AssertionBoard assertions={assertions} replay={evidence} selectedId={selected?.localId} search={search} onCreate={beginAuthoring} onOpen={openDetail} onReplay={(scenario) => void runReplay(assertions, scenario)} onChoose={changeChoice}/> : null}
      {section === "activity" ? <ActivityPage replay={evidence}/> : null}
      {section === "connections" ? <ConnectionsPage replay={evidence} integrations={workspace.integrations}/> : null}
      {section === "settings" ? <SettingsPage assertions={assertions} examples={examples} user={workspace.user} onRestore={restoreSamples} onClear={clearLocal} onSignOut={() => void endSession()}/> : null}
      {selected !== undefined && section === "assertions" ? <AssertionDetail draft={selected} replay={evidence} investigations={durableMonitor?.investigations ?? []} investigationReady={workspace.integrations.some((item) => item.provider === "gitlab" && item.purpose === "investigation" && item.enabled)} onLaunchInvestigation={(violationId) => void startInvestigation(violationId)} onRefreshInvestigation={(id) => void refreshGitLabInvestigation(id)} onClose={closeDetail} onToggle={toggleSelected} onEdit={() => setEditing(selected)} onCopy={() => void copyLink()} onChoose={(param, value) => changeChoice(selected, param, value)}/> : null}
    </div>
    {replaying || translating ? <div className="replaying" role="status"><span/>{translating ? "Writing and checking the rule…" : "Replaying through engine…"}</div> : null}
    {error ? <div className="error-banner" role="alert"><strong>Needl error</strong>{error}<button onClick={() => setError(null)} aria-label="Dismiss error"><Icon name="close"/></button></div> : null}
    {toast ? <div className="toast" role="status">{toast}</div> : null}
    {authoringText !== null ? <AuthoringDialog key={translation?.proposalId ?? authoringText} expectation={authoringText} examples={examples} translation={translation} translatorAvailable={workspace.translator === "available"} onClose={() => { setAuthoringText(null); setTranslation(null); }} onCreate={(input) => void createRule(input)}/> : null}
    {editing !== null ? <EditDialog draft={editing} onClose={() => setEditing(null)} onSave={saveEdit}/> : null}
  </div>;
}
