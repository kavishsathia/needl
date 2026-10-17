import type { SVGProps } from "react";

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { readonly name: string }) {
  const paths: Record<string, React.ReactNode> = {
    assertions: <><circle cx="12" cy="12" r="7"/><path d="M9 12.2l2 2 4-4.5"/></>,
    activity: <><path d="M4 13h3l2.2-6 3.4 10L15 11h5"/></>,
    connections: <><circle cx="6" cy="6" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="8" cy="18" r="2"/><path d="M8 7l8 0M7 8l1 8M10 17l6-8"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19 12l2-1-2-4-2 .5-1.5-1L15 4h-5L9 6.5l-1.5 1L5 7l-2 4 2 1v2l-2 1 2 4 2.5-.5 1.5 1L10 22h5l1-2.5 1.5-1L20 19l2-4-3-1z"/></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></>,
    arrow: <><path d="M5 12h14M14 7l5 5-5 5"/></>,
    back: <><path d="M19 12H5M10 7l-5 5 5 5"/></>,
    replay: <><path d="M20 11a8 8 0 10-2.3 5.7"/><path d="M20 5v6h-6"/></>,
    pause: <><path d="M8 5v14M16 5v14"/></>,
    play: <path d="M8 5l11 7-11 7z"/>,
    close: <><path d="M6 6l12 12M18 6L6 18"/></>,
    edit: <><path d="M4 20l4-1 10-10-3-3L5 16zM13.5 7.5l3 3"/></>,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/></>,
    menu: <><path d="M4 7h16M4 12h16M4 17h16"/></>,
    check: <path d="M5 12l4 4L19 6"/>,
    warning: <><path d="M12 3l10 18H2z"/><path d="M12 9v5M12 17v.1"/></>,
    clock: <><circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/></>,
    chevron: <path d="M9 6l6 6-6 6"/>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...props}>{paths[name]}</svg>;
}

/** Pipeline-style status mark: a filled circle with a white glyph, as GitLab shows job and pipeline states. */
export function StatusIcon({ tone }: { readonly tone: string }) {
  const glyph: Record<string, React.ReactNode> = {
    violated: <path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/>,
    monitoring: <path d="M4.8 8.3l2.2 2.2 4.2-4.6"/>,
    paused: <path d="M6.3 5.2v5.6M9.7 5.2v5.6"/>,
    pending: <><path d="M8 4.6V8l2.2 1.5"/></>,
    "needs-review": <path d="M8 4.5v4.2M8 11.2v.1"/>,
    unavailable: <path d="M5 8h6"/>,
  };
  return <svg className="status-icon" viewBox="0 0 16 16" aria-hidden="true">
    <circle cx="8" cy="8" r="8" fill="currentColor"/>
    <g fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{glyph[tone] ?? glyph.unavailable}</g>
  </svg>;
}
