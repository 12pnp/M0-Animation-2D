import type { NodeId } from "./ids";
import { runtimeSolved } from "./constraints";
import type { Animation, InheritKey, Node, SymbolItem } from "./types";
import type { SpineInherit } from "@/core/spine/types";
import { keyTime } from "@/core/spine/transform";

/**
 * Inherit modes (ARCHITECTURE ▸ Inherit modes), pure: what a bone takes from
 * its parent (`Node.inherit`) and the keys that change it in an animation
 * (`Animation.inherits`, Spine's stepped `inherit` timeline).
 */

export const INHERIT_MODES: readonly SpineInherit[] = ["normal", "onlyTranslation", "noRotationOrReflection", "noScale", "noScaleOrReflection"];

export const INHERIT_LABELS: Record<SpineInherit, string> = {
  normal: "Everything",
  onlyTranslation: "Position only",
  noRotationOrReflection: "No rotation or reflection",
  noScale: "No scale",
  noScaleOrReflection: "No scale or reflection",
};

export function isInherit(v: unknown): v is SpineInherit {
  return typeof v === "string" && (INHERIT_MODES as readonly string[]).includes(v);
}

/** The bone's mode at `frame`: the last key at or before it, else its own. */
export function inheritAt(node: Node, anim: Animation | null | undefined, frame: number): SpineInherit {
  let mode = node.inherit ?? "normal";
  for (const k of anim?.inherits?.[node.id] ?? []) if (k.frame <= frame) mode = k.inherit;
  return mode;
}

/** A symbol the stage cannot compose itself: some bone takes less than its
 *  whole parent, now or in a key, a constraint only the runtime solves, a
 *  turned region (`DisplayRef.region`) or a tinted attachment (`DisplayRef.tint`). */
export function runtimePosed(sym: SymbolItem): boolean {
  if (runtimeSolved(sym)) return true;
  if (Object.values(sym.nodes).some((n) => n.region || n.tint || n.extraDisplays?.some((d) => d.region || d.tint))) return true;
  if (sym.skins?.some((def) => Object.values(def.displays ?? {}).some((by) => Object.values(by).some((d) => d.tint || d.region)))) return true;
  if (Object.values(sym.nodes).some((n) => n.inherit && n.inherit !== "normal")) return true;
  return sym.animations.some((a) => Object.values(a.inherits ?? {}).some((keys) => keys.length > 0));
}

/** `keys` with `mode` keyed at `frame`, replacing a key there. */
export function withInheritKey(keys: readonly InheritKey[], frame: number, mode: SpineInherit): InheritKey[] {
  return [...keys.filter((k) => k.frame !== frame), { frame, inherit: mode }].sort((a, b) => a.frame - b.frame);
}

/** Spine's timeline for a bone's keys. */
export function inheritTimeline(keys: readonly InheritKey[], fps: number): Array<Record<string, unknown>> {
  return keys.map((k) => {
    const out: Record<string, unknown> = {};
    if (k.frame > 0) out.time = keyTime(k.frame, fps);
    if (k.inherit !== "normal") out.inherit = k.inherit;
    return out;
  });
}

/** A file's `inherit` timeline as keys, each on the first whole frame it
 *  shows on; null when a key names no mode (then it stays carried). */
export function inheritKeysFromSpine(raw: unknown, fps: number): InheritKey[] | null {
  if (!Array.isArray(raw)) return null;
  const keys: InheritKey[] = [];
  for (const k of raw) {
    if (!k || typeof k !== "object") return null;
    const r = k as Record<string, unknown>;
    const time = typeof r.time === "number" ? r.time : 0;
    // A key between frames takes the next whole frame: the first it shows on.
    const at = time * fps, frame = Math.abs(at - Math.round(at)) <= 1e-3 ? Math.round(at) : Math.ceil(at);
    const mode = r.inherit === undefined ? "normal" : r.inherit;
    if (!isInherit(mode)) return null;
    // Two keys before one frame: the later shows there.
    const same = keys.findIndex((k) => k.frame === frame);
    if (same >= 0) keys.splice(same, 1);
    keys.push({ frame, inherit: mode });
  }
  return keys.sort((a, b) => a.frame - b.frame);
}

/** Every bone's keys, cleaned: known modes, whole frames, one per frame. */
export function sanitizeInherits(raw: unknown, nodes: Record<NodeId, Node>): Record<NodeId, InheritKey[]> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<NodeId, InheritKey[]> = {};
  for (const [id, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!nodes[id as NodeId] || !Array.isArray(list)) continue;
    const byFrame = new Map<number, InheritKey>();
    for (const k of list) {
      const r = k as Record<string, unknown>;
      if (typeof r?.frame !== "number" || !Number.isFinite(r.frame) || r.frame < 0 || !isInherit(r.inherit)) continue;
      byFrame.set(Math.round(r.frame), { frame: Math.round(r.frame), inherit: r.inherit });
    }
    if (byFrame.size) out[id as NodeId] = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
  }
  return Object.keys(out).length ? out : undefined;
}
