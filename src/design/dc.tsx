// Minimal runtime for components ported from design exports (scripts/port-design.mjs).
// The export's logic class (`class Component extends DCLogic`) is kept verbatim; DCLogic renders the generated
// template with the values its renderVals() returns, exactly as the design runtime does.
import React from "react";

export class DCLogic<P = Record<string, unknown>, S = Record<string, unknown>> extends React.Component<P, S> {
  renderVals(): Record<string, unknown> {
    return {};
  }
  render() {
    const template = (this.constructor as unknown as { template: (v: Record<string, unknown>) => React.ReactNode }).template;
    return template(this.renderVals());
  }
}

const cache = new Map<string, React.CSSProperties>();

/** Inline CSS string from the export -> React style object (custom properties kept as-is). */
export function css(text: string): React.CSSProperties {
  const hit = cache.get(text);
  if (hit) return hit;
  const out: Record<string, string> = {};
  let depth = 0;
  let start = 0;
  const decls: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === ";" && depth === 0) {
      decls.push(text.slice(start, i));
      start = i + 1;
    }
  }
  decls.push(text.slice(start));
  for (const d of decls) {
    const k = d.indexOf(":");
    if (k < 0) continue;
    const prop = d.slice(0, k).trim();
    const value = d.slice(k + 1).trim();
    if (!prop) continue;
    const key = prop.startsWith("--")
      ? prop
      : prop.replace(/^-(webkit|moz|ms)-/, (_m, v) => `${v === "ms" ? "ms" : v[0].toUpperCase() + v.slice(1)}-`).replace(/-([a-z])/g, (_m, ch) => ch.toUpperCase());
    out[key] = value;
  }
  const style = out as React.CSSProperties;
  if (cache.size < 2000) cache.set(text, style);
  return style;
}

const HOST = new Set(["position", "left", "right", "top", "bottom", "inset", "width", "height", "zIndex", "transform"]);
/** A <dc-import>'s `style` only positions the host element, as in the design runtime. */
export function hostStyle(style: React.CSSProperties | string | null | undefined): React.CSSProperties | undefined {
  const all = typeof style === "string" ? css(style) : style;
  if (!all) return undefined;
  const out = Object.fromEntries(Object.entries(all).filter(([k]) => HOST.has(k)));
  return Object.keys(out).length ? (out as React.CSSProperties) : undefined;
}
