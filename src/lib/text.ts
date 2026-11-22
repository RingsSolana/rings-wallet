// Outside text made safe to show: characters that hide or reorder words are made visible.

// Characters that hide or reorder text (bidi controls, zero-width, separators, controls), as code-point ranges so
// none of them can end up raw in this file.
const HIDDEN: [number, number][] = [
  [0x0000, 0x0008], [0x000b, 0x000c], [0x000e, 0x001f], [0x007f, 0x009f], [0x00ad, 0x00ad], [0x061c, 0x061c],
  [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f],
  [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff0, 0xfffb],
];
const hidden = (cp: number) => HIDDEN.some(([a, b]) => cp >= a && cp <= b);

export const hasHiddenCharacters = (text: string) => [...text].some((c) => hidden(c.codePointAt(0)!));

/** Hidden characters shown as "<U+202E>"; long runs of empty lines folded. */
export function visible(text: string): string {
  return [...text]
    .map((c) => {
      const cp = c.codePointAt(0)!;
      return hidden(cp) ? `<U+${cp.toString(16).toUpperCase().padStart(4, "0")}>` : c;
    })
    .join("")
    .replace(/\n{4,}/g, (m) => `\n\n<${m.length - 1} empty lines>\n`);
}

/** visible() text on one line, cut to `max` characters. */
export function oneLine(text: string, max = 160): string {
  const t = visible(String(text)).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** A plain hostname, with an optional port. */
export const isHostname = (s: string) => s.length <= 253 && /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(:\d{1,5})?$/i.test(s);

/** A long host keeps its right-hand end, where the real domain is. */
export function shownHost(host: string, max = 40): string {
  return host.length <= max ? host : `…${host.slice(-(max - 1))}`;
}
