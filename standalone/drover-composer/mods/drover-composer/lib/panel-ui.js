// panel-ui.js: the shared look of the drover-* side panels (header, buttons, empty state, type).
// Vendored byte-identical into each mod's lib/ (see SPEC.md "Sync"). Do not edit a copy; edit the
// canonical file and re-vendor. Sans (the layout's ui_font, inherited) is the UI voice; mono is
// only for data: paths, hashes, numbers, ports, branch names, token counts, code.
// Every helper takes the theme `t` (theme()) so nothing here reads Herdr state but settings().
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { settings } from "herdr";

// ---------- type and spacing ----------

/** The only text sizes a panel uses: 11 meta, 12 body, 13 title, 15 stat. */
export const TYPE = Object.freeze({ xs: 11, sm: 12, md: 13, lg: 15 });
/** Shared metrics. HEADER_H/PX are the panel header; ROW_H a list row; ICON a glyph in a 24 px hit box. */
export const SPACE = Object.freeze({ HEADER_H: 36, PX: 12, ROW_H: 26, GAP: 8, ICON: 14, HIT: 24 });
/** The typographic minus for diff counts (never ASCII "-"). */
export const MINUS = "−";

/** The data font: the terminals' family (settings().font_family), else JetBrains Mono, which ships with Herdr. */
export const monoFamily = () => {
  try { return settings()?.font_family || "JetBrains Mono"; } catch { return "JetBrains Mono"; }
};
/** Marks one element as data text. Never call on a panel root: chrome stays sans. */
export const mono = (el) => el.font_family(monoFamily());

// ---------- color ----------

const hex = (c) => {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(c || "").trim());
  return m ? [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : null;
};
const lum = (rgb) => {
  const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
/** WCAG contrast ratio of two #rrggbb colors, or null when either is not hex. */
export function contrast(a, b) {
  const x = hex(a), y = hex(b);
  if (!x || !y) return null;
  const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}
const mix = (a, b, k) => "#" + a.map((v, i) => Math.round(v * k + b[i] * (1 - k)).toString(16).padStart(2, "0")).join("");
const metaCache = new Map();
/**
 * The color for meta text that must be read (counts, timestamps, hints): t.muted when it reaches
 * 4.5:1 on `on`, else t.foreground blended toward `on` just enough to reach 4.5:1.
 * t.dim is never used for readable text (it measures ~2.8-3.5:1 on graphite).
 */
export function metaColor(t, on = t.background) {
  const key = `${t.muted}|${t.foreground}|${on}`;
  if (metaCache.has(key)) return metaCache.get(key);
  let out = t.muted;
  const r = contrast(t.muted, on);
  if (r !== null && r < 4.5) {
    const fg = hex(t.foreground), bg = hex(on);
    if (fg && bg) for (let k = 0.55; k <= 1.0001; k += 0.05) { out = mix(fg, bg, Math.min(k, 1)); if (contrast(out, on) >= 4.5) break; }
  }
  metaCache.set(key, out);
  return out;
}

// ---------- numbers ----------

/** "+3", "−2", "0": a count that carries its own sign, so it never relies on color. */
export const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `${MINUS}${-n}` : "0");

/** "+12 −3" in mono, green/red as a second cue; the accessible label says it in words. */
export function diffStat({ added = 0, removed = 0, id }, t) {
  return mono(h_flex().id(id ?? `diff-${added}-${removed}`).flex_none().gap(4).text_size(TYPE.xs)
    .accessibility_label(`${added} added, ${removed} removed`)
    .child(div().text_color(added ? t.ansi2 : metaColor(t)).child(`+${added}`))
    .child(div().text_color(removed ? t.ansi1 : metaColor(t)).child(`${MINUS}${removed}`)));
}

// ---------- controls ----------

// Enter / Space on a focused control runs its click, so a tab_index'd div is a real button.
const keyable = (el, onClick) => el.on_key_down((e, cx) => {
  if (e.key === "enter" || e.key === "space") { cx.stop_propagation(); onClick(cx); cx.notify(); }
});
const glyph = (icon, size, color) => (/\.svg$/i.test(String(icon))
  ? svg(icon).size(size).flex_none().text_color(color)
  : div().text_size(size).text_color(color).child(String(icon)));

/**
 * The one icon-only control: a 24 px box, 14 px svg, hover/focus = t.hover, tooltip + screen-reader
 * label from the same `label`. `icon` is an app-home path ("mods/<mod>/ui/refresh.svg"); a non-.svg
 * string is drawn as a text glyph (fallback only). onClick receives `cx` only, not `(e, cx)`.
 */
export function iconButton({ id, icon, label, onClick, active = false, disabled = false }, t) {
  const run = (cx) => { if (!disabled) onClick?.(cx); };
  return keyable(div().id(id).size(SPACE.HIT).flex_none().flex().items_center().justify_center().rounded(6)
    .role("button").accessibility_label(label).tooltip(label).tab_index(0).when(disabled, (el) => el.disabled(true))
    .when(active, (el) => el.bg(t.selected))
    .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).focus((s) => s.bg(t.hover).border_1().border_color(t.accent)))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); run(cx); cx.notify(); })
    .child(glyph(icon, SPACE.ICON, disabled ? t.dim : active ? t.foreground : t.muted)), run);
}

/**
 * The text button. kind: "primary" (t.solid fill; at most one per view), "secondary" (outline,
 * the default), "danger" (outline in t.blocked; only for the armed second step of a two-step
 * destructive action, never the first click). onClick receives `cx` only, not `(e, cx)`.
 */
export function button({ id, label, onClick, kind = "secondary", disabled = false, tooltip }, t) {
  const primary = kind === "primary", danger = kind === "danger";
  const run = (cx) => { if (!disabled) onClick?.(cx); };
  return keyable(h_flex().id(id).h(SPACE.HIT).px(10).flex_none().items_center().rounded(6).border_1()
    .role("button").accessibility_label(label).tab_index(0).when(disabled, (el) => el.disabled(true))
    .text_size(TYPE.sm).font_medium()
    .border_color(primary ? t.solid : danger ? t.blocked : t.input)
    .when(primary, (el) => el.bg(t.solid))
    .text_color(disabled ? t.dim : primary ? t.solid_foreground : danger ? t.blocked : t.foreground)
    .when(Boolean(tooltip), (el) => el.tooltip(tooltip))
    .when(disabled, (el) => el.opacity(0.6))
    .when(!disabled, (el) => el.cursor_pointer()
      .hover((s) => (primary ? s.opacity(0.88) : s.bg(t.hover)))
      .focus((s) => s.border_color(t.accent)))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); run(cx); cx.notify(); })
    .child(label), run);
}

/** A small muted pill (counts, states). `data: true` sets it in mono. */
export function chip(text, t, { color, data = false } = {}) {
  const el = div().flex_none().max_w("100%").truncate().px(6).py(1).rounded(4).bg(t.raised)
    .text_size(TYPE.xs).text_color(color ?? metaColor(t, t.raised)).child(String(text));
  return data ? mono(el) : el;
}

// ---------- structure ----------

/**
 * The panel header: 36 px tall, 12 px side padding, a bottom border; title 13 semibold sans,
 * an optional meta chip (11, muted; string or number), then the actions right-aligned, icon-only.
 * No traffic-light inset: panels live in the right panel-body, never under the window buttons.
 * actions: [{ id, icon, label, onClick, active?, disabled? }]. `busy` shows a spinner before them.
 */
export function panelHeader({ title, meta, actions = [], busy = false, id = "panel-header" }, t) {
  return h_flex().id(id).h(SPACE.HEADER_H).flex_none().px(SPACE.PX).gap(SPACE.GAP).items_center()
    .border_b_1().border_color(t.border).role("toolbar").accessibility_label(String(title))
    .child(div().flex_none().text_size(TYPE.md).font_semibold().text_color(t.foreground).child(String(title)))
    .when(meta !== undefined && meta !== null && meta !== "", (el) => el.child(chip(meta, t, { data: typeof meta === "number" })))
    .child(div().flex_1().min_w(0))
    .when(busy, (el) => el.child(div().text_size(TYPE.xs).text_color(metaColor(t))
      .accessibility_label("Loading").frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)))
    .child(h_flex().flex_none().gap(2).items_center().children(actions.map((a) => iconButton(a, t))));
}

/** A section label inside a panel body: 11 semibold sans, muted, sentence case (no ALL CAPS). */
export function sectionLabel(text, t, { id } = {}) {
  return div().when(Boolean(id), (el) => el.id(id)).flex_none().pt(SPACE.GAP).pb(4).text_size(TYPE.xs).font_semibold()
    .text_color(metaColor(t)).child(String(text));
}

/**
 * The one empty / error state: centered column, optional 20 px icon (muted), title 13 semibold,
 * body 12 muted (one or two sentences: what is wrong, then what to do), optional single action
 * (a secondary button; primary only when it is the view's only way forward). `tone: "error"` tints
 * the icon with t.blocked; text stays foreground/muted for contrast.
 */
export function emptyState({ icon, title, body, action, tone, id = "empty" }, t) {
  return v_flex().id(id).w_full().flex_none().px(SPACE.PX).py(24).gap(6).items_center()
    .role("status").accessibility_label([title, body].filter(Boolean).join(". "))
    .when(Boolean(icon), (el) => el.child(div().pb(2).child(glyph(icon, 20, tone === "error" ? t.blocked : metaColor(t)))))
    .child(div().text_size(TYPE.md).font_semibold().text_color(t.foreground).child(String(title)))
    .when(Boolean(body), (el) => el.child(div().max_w(320).text_center().text_size(TYPE.sm).text_color(metaColor(t)).child(String(body))))
    .when(Boolean(action), (el) => el.child(div().pt(6).child(button({ id: action.id ?? `${id}-action`, label: action.label,
      onClick: action.onClick, kind: action.kind ?? "secondary" }, t))));
}

/** The shared "no repository" empty state wording (see SPEC.md "Copy"). `icon`: the mod's own svg path. */
export function noRepoState({ folder, action, icon, id = "no-repo" }, t) {
  return emptyState({ id, icon, title: "Not a git repository",
    body: folder ? `${folder} isn't inside a git repository.` : "This space's folder isn't inside a git repository.", action }, t);
}
