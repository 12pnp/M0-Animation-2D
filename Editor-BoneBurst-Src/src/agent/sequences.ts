import { findAttachment, replaceAttachment } from "@/edit/attachments";
import { deleteKeys, sameTime, setKey } from "@/edit/keys";
import type { Attachment, Skeleton } from "@/model/skeleton";
import { attachmentType } from "@/model/skeleton";
import { frameTime, keysAt, keyTime, shortFloat, type TimelinePath } from "@/model/timelines";
import { applyEdit } from "./apply";
import { type AgentContext, AgentRefused } from "./context";
import { animationOf, docOf, fpsOf } from "./read";
import { displaysOf, imageOf, shownEntry, slotNamed } from "./where";

/**
 * Frame-by-frame images (E5-PLAN step 8; Spine's region sequences): a slot's image becomes the
 * run of atlas images numbered like it, and sequence keys say which plays and how.
 */

type Args = Record<string, unknown>;

/** The slot's image to make a sequence of, or the one that is one: its setup image, else its first. */
function sequenceSlot(doc: Skeleton, ctx: AgentContext, layer: unknown) {
  const slot = slotNamed(doc, layer), keys = displaysOf(doc, slot.name);
  const key = slot.attachment !== undefined && keys.includes(slot.attachment) ? slot.attachment : keys[0];
  if (key === undefined) throw new AgentRefused(`The slot "${slot.name}" has no image.`);
  const r = shownEntry(doc, ctx, slot.name, key);
  return { r, a: findAttachment(doc, r)! };
}

/** The numbered run around `image` among `names`: `fire_02` in fire_01…fire_05 gives prefix "fire_", start 1, count 5, digits 2, at 1. */
export function numberedRun(image: string, names: readonly string[]): { prefix: string; start: number; count: number; digits: number; at: number } | null {
  const m = /^(.*?)(\d+)$/.exec(image);
  if (!m) return null;
  const prefix = m[1]!, padded = m[2]!.length > 1 && m[2]!.startsWith("0");
  const numbers = new Map<number, string>();
  for (const n of names) {
    if (!n.startsWith(prefix)) continue;
    const d = n.slice(prefix.length);
    if (!/^\d+$/.test(d)) continue;
    // Padded names all have the image's digit count; plain ones none padded.
    if (padded ? d.length !== m[2]!.length : d !== String(Number(d))) continue;
    numbers.set(Number(d), n);
  }
  const at = Number(m[2]);
  let start = at, end = at;
  while (numbers.has(start - 1)) start--;
  while (numbers.has(end + 1)) end++;
  return { prefix, start, count: end - start + 1, digits: padded ? m[2]!.length : 0, at };
}

function makeSequence(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), { r, a } = sequenceSlot(doc, ctx, args.layer);
  if (a.sequence) throw new AgentRefused(`"${r.key}" in "${r.slot}" is already a sequence; key_sequence plays it.`);
  const type = attachmentType(a);
  if (type !== "region" && type !== "mesh") throw new AgentRefused(`"${r.key}" is a ${type}: only a region or a mesh can be a sequence.`);
  const image = imageOf(a, r.key), names = ctx.images.regions.map((x) => x.name);
  const run = numberedRun(image, names);
  if (!run || run.count < 2) throw new AgentRefused(`There are no atlas images numbered like "${image}" (as fire_01, fire_02, …) to make a sequence of.`);
  const frames = Array.from({ length: run.count }, (_, i) => run.prefix + String(run.start + i).padStart(run.digits, "0"));
  const sized = frames.map((n) => ctx.images.regions.find((x) => x.name === n)!);
  const odd = sized.find((x) => x.originalWidth !== sized[0]!.originalWidth || x.originalHeight !== sized[0]!.originalHeight);
  if (odd) throw new AgentRefused(`A sequence's images are all one size: "${odd.name}" is ${odd.originalWidth}×${odd.originalHeight}, "${sized[0]!.name}" ${sized[0]!.originalWidth}×${sized[0]!.originalHeight}.`);
  const sequence = {
    count: run.count, ...(run.start !== 1 ? { start: run.start } : {}), ...(run.digits ? { digits: run.digits } : {}),
    ...(run.at !== run.start ? { setup: run.at - run.start } : {}), extra: new Map(),
  };
  const next = { ...a, path: run.prefix, sequence } as Attachment;
  applyEdit(ctx, `make_sequence ${r.slot}`, (s) => replaceAttachment(s, r, next));
  return { layer: r.slot, attachment: r.key, skin: r.skin, images: frames, setup: run.at - run.start };
}

const MODES = ["hold", "once", "loop", "pingpong", "onceReverse", "loopReverse", "pingpongReverse"] as const;

function keySequence(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), anim = animationOf(doc, args.animation).name, fps = fpsOf(doc), frame = args.frame as number;
  const { r, a } = sequenceSlot(doc, ctx, args.layer);
  if (!a.sequence) throw new AgentRefused(`"${r.key}" in "${r.slot}" is not a sequence: make_sequence first.`);
  const path: TimelinePath = { section: "attachments", skin: r.skin, slot: r.slot, attachment: r.key, timeline: "sequence" };
  const time = frameTime(frame, fps);
  if (args.delete === true) {
    const keys = keysAt(doc.animations!.find((x) => x.name === anim)!, path) ?? [];
    if (!keys.some((k) => sameTime(keyTime(k), time))) throw new AgentRefused(`"${r.slot}" has no sequence key at frame ${frame} of "${anim}".`);
    applyEdit(ctx, `key_sequence ${r.slot} delete ${frame}`, deleteKeys(anim, [{ path, time }]));
    return { animation: anim, layer: r.slot, frame, deleted: true };
  }
  const mode = (args.mode as (typeof MODES)[number] | undefined) ?? "hold", index = (args.index as number | undefined) ?? 0;
  const count = a.sequence.count ?? 1;
  if (index >= count) throw new AgentRefused(`The sequence has ${count} images (0 to ${count - 1}); index ${index} is not one.`);
  // Delay in frames, stored in seconds; a playing mode steps every frame unless told otherwise.
  const delayFrames = (args.delay as number | undefined) ?? (mode === "hold" ? 0 : 1);
  const delay = shortFloat(delayFrames / fps);
  const fields = { ...(mode !== "hold" ? { mode } : {}), ...(index ? { index } : {}), ...(delay ? { delay } : {}) };
  applyEdit(ctx, `key_sequence ${r.slot} at ${frame}`, setKey(anim, path, time, fields, ["mode", "index", "delay"]));
  return { animation: anim, layer: r.slot, frame, mode, index, delay: delayFrames };
}

export const SEQUENCE_TOOLS = { make_sequence: makeSequence, key_sequence: keySequence } as const;
