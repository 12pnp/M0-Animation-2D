import type { Animation } from "@/core/doc/types";
import { entryBox, type FrameContext } from "@/core/doc/pose";
import { imageFrame, referenceEnd, referenceFrameOf, referenceIndexAt, referenceRect } from "@/core/doc/reference";
import { apply } from "@/core/math/Matrix2D";
import { pt, type Rect, transformCorners } from "@/core/math/geom";
import { seamFrame } from "@/core/doc/cycle";
import { posedSymbol } from "@/core/boneburst/boneburstPose";
import { AgentError, mark, round } from "./agentArgs";
import type { AgentApi, AgentImage, PathMark, PoseStyle } from "./AgentApi";
import { pathOf } from "./agentPaths";

/** A tool's value carries its pictures under this key; the bridge lifts
 *  them out into image blocks (MCP, Claude, GLM's vision models). */
export const IMAGES_KEY = "__images";

/** Longest side of a rendered frame and of a reference image, in pixels:
 *  enough to see a pose, few enough tokens to look at many. */
const RENDER_SIDE = 768, REFERENCE_SIDE = 512, MAX_IMAGES = 6;

/**
 * The AI's pictures: reference images, rendered frames, poses side by side.
 */

/* ── looking ── */

/** The animation's reference: how its images sit in time and space, and
 *  the images at the frames asked for. */
export async function getReference(api: AgentApi, animName: string, framesArg: unknown) {
  const anim = api.animation(animName);
  const ref = anim.reference;
  if (!ref) throw new AgentError(`"${anim.name}" has no reference. The user adds one in the Reference panel.`);
  const frames = framesArg === undefined ? [] : Array.isArray(framesArg) ? framesArg : [framesArg];
  if (!frames.every((f) => typeof f === "number" && Number.isInteger(f) && f >= 0)) throw new AgentError("frames is a list of whole frame numbers.");
  if (frames.length > MAX_IMAGES) throw new AgentError(`At most ${MAX_IMAGES} frames at a time.`);
  const images: AgentImage[] = [];
  const shown: Array<{ frame: number; image: number | null }> = [];
  for (const f of frames as number[]) {
    const i = referenceIndexAt(ref, f);
    shown.push({ frame: f, image: i === null ? null : i + 1 });
    if (i !== null) images.push(await api.needVision().image(ref.frames[i]!, REFERENCE_SIDE));
  }
  const r = referenceRect(ref);
  return {
    animation: anim.name,
    images: ref.frames.length,
    size: [ref.width, ref.height],
    timing: `image n (1-based) is keyed at keyFrames[n-1] and holds until the next image's keyFrame; the last holds ${ref.hold} frame(s); the reference ends at frame ${referenceEnd(ref)}`,
    keyFrames: ref.frames.map((_, i) => referenceFrameOf(ref, i)),
    // Spine conventions, as get_pose reports worlds: y up.
    placement: `image pixel (u, v) from its top-left sits at x = ${round(r.x, 3)} + u*${round(ref.scale, 6)}, y = ${round(-r.y, 3)} - v*${round(ref.scale, 6)} in the skeleton's space (the space get_pose reports)`,
    ...(shown.length ? { shown } : {}),
    [IMAGES_KEY]: images,
  };
}

/** The skeleton at a frame as the stage draws it, over its reference, with
 *  every bone drawn and named; and where each bone lands in the picture. */
export async function renderFrame(api: AgentApi, animName: string | null, frame: number, withReference: boolean, withBones: boolean, pathsArg?: unknown) {
  const anim = animName === null ? null : api.animation(animName);
  const { boxes, bones } = frameView(api, anim, frame);
  if (pathsArg !== undefined && (!Array.isArray(pathsArg) || !pathsArg.every((n) => typeof n === "string"))) throw new AgentError("paths is a list of bone names.");
  if (pathsArg && !anim) throw new AgentError("paths needs an animation: a path is where a bone goes over it.");
  const paths = anim ? ((pathsArg as string[] | undefined) ?? []).map((name) => ({ name, path: pathOf(api, anim, api.bone(name), "tip") })) : [];
  // Framed to hold the paths whole.
  for (const { path } of paths) for (const q of path.points) boxes.push({ x: q.x, y: q.y, w: 1e-3, h: 1e-3 });
  // Framed on what is drawn: helper bones far from the artwork (an aim
  // target, a crosshair) would shrink the body to a corner. A rig that
  // draws nothing is framed on its bones.
  if (boxes.length === 0) for (const b of bones) boxes.push({ x: Math.min(b.from[0], b.to[0]), y: Math.min(b.from[1], b.to[1]), w: Math.abs(b.to[0] - b.from[0]) || 1e-3, h: Math.abs(b.to[1] - b.from[1]) || 1e-3 });
  const ref = withReference && anim?.reference && referenceIndexAt(anim.reference, frame) !== null ? anim.reference : undefined;
  if (ref) boxes.push(referenceRect(ref));
  const view = imageFrame(boxes, RENDER_SIDE);
  const marks = bones.map((b) => mark(b, view));
  const inside = (p: [number, number]) => p[0] >= 0 && p[1] >= 0 && p[0] <= view.width && p[1] <= view.height;
  const join = anim ? seamFrame(anim) : null;
  const shownFrame = frame === join ? 0 : frame;
  const pathMarks: PathMark[] = paths.map(({ name, path }) => ({
    name, closed: path.closed,
    points: path.points.map((q) => view.toPixel(q.x, q.y)),
    keys: path.points.map((q) => q.key),
    current: path.points.findIndex((q) => q.frame === shownFrame),
  }));
  const image = await api.needVision().render({ symbol: api.sym, animation: anim, frame, view, reference: !!ref, bones: withBones ? marks : [], ...(pathMarks.length ? { paths: pathMarks } : {}) });
  const [lx, ly] = view.fromPixel(0, 0);
  return {
    animation: anim?.name ?? null, frame,
    size: [view.width, view.height],
    reference: ref ? `image ${referenceIndexAt(ref, frame)! + 1} behind the skeleton, half transparent` : "none",
    // Pixel (px, py) from the top-left of the picture, in the skeleton's
    // space as get_pose reports it (y up).
    mapping: `x = ${round(lx, 3)} + px/${round(view.scale, 6)}, y = ${round(-ly, 3)} - py/${round(view.scale, 6)}`,
    bones: Object.fromEntries(marks.map((m) => [m.name, {
      origin: m.from.map((v) => round(v, 1)), tip: m.to.map((v) => round(v, 1)), ...(inside(m.from) ? {} : { outside: true }),
    }])),
    ...(pathMarks.length ? { paths: Object.fromEntries(pathMarks.map((m) => [m.name, { frames: m.points.length, closed: m.closed, keyedFrames: paths.find((p) => p.name === m.name)!.path.points.filter((q) => q.key).map((q) => q.frame) }])) } : {}),
    note: "Bones named far or right are drawn blue, the others magenta. Names that would overlap are left off the picture; every bone is listed here. Bones marked outside are beyond the picture's edges." + (pathMarks.length ? " Each path is an orange line through the tip at every frame, a ring on each keyed frame, a filled dot on this frame." : ""),
    [IMAGES_KEY]: [image],
  };
}

/** The pose at `frame`: what it draws (the framing boxes) and every bone
 *  as a line, in the symbol's own space. */
export function frameView(api: AgentApi, anim: Animation | null, frame: number): { boxes: Rect[]; bones: Array<{ name: string; from: [number, number]; to: [number, number] }> } {
  const mode = anim ? "animate" : "setup";
  const pose = posedSymbol(api.store.project, api.sym, anim, frame, mode);
  const when: FrameContext = { animationName: anim?.name ?? null, frame, mode };
  const boxes: Rect[] = [];
  for (const e of pose.entries) {
    if (!e.visible || !(e.display || e.spine)) continue;
    const b = entryBox(api.store.project, e, when);
    if (!b) continue;
    const c = transformCorners(e.world, b);
    const xs = c.map((p) => p.x), ys = c.map((p) => p.y);
    boxes.push({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
  }
  const bones = api.bones().map((n) => {
    const m = pose.byNode.get(n.id)?.world;
    if (!m) return null;
    const tip = apply(pt(), m, n.boneLength ?? 0, 0);
    return { name: n.name, from: [m.tx, m.ty] as [number, number], to: [tip.x, tip.y] as [number, number] };
  }).filter((b): b is NonNullable<typeof b> => !!b);
  return { boxes, bones };
}

/** Frames rendered in ONE shared framing, so the pictures compare —
 *  per-frame framing would zoom each pose to itself. Not an AI tool: the
 *  Poses panel's thumbnails and its Ask AI handoff. `each` sees every
 *  picture as it is done — a strip shows itself progressively. */
export async function renderPoses(api: AgentApi, animName: string, frames: number[], style: PoseStyle = "both", each?: (image: AgentImage, index: number) => void, withReference = false): Promise<AgentImage[]> {
  const anim = api.animation(animName);
  const views = frames.map((f) => frameView(api, anim, f));
  const boxes = views.flatMap((v) => v.boxes);
  if (boxes.length === 0) for (const v of views) for (const b of v.bones) {
    boxes.push({ x: Math.min(b.from[0], b.to[0]), y: Math.min(b.from[1], b.to[1]), w: Math.abs(b.to[0] - b.from[0]) || 1e-3, h: Math.abs(b.to[1] - b.from[1]) || 1e-3 });
  }
  const ref = withReference ? anim.reference : undefined;
  const over = frames.map((f) => !!ref && referenceIndexAt(ref, f) !== null);
  // The reference in the shared framing too, or a pose drawn over it would crop it.
  if (ref && over.some(Boolean)) boxes.push(referenceRect(ref));
  const view = imageFrame(boxes, RENDER_SIDE);
  const images: AgentImage[] = [];
  for (let i = 0; i < frames.length; i++) {
    const marks = views[i]!.bones.map((b) => mark(b, view));
    const image = await api.needVision().render({
      symbol: api.sym, animation: anim, frame: frames[i]!, view, reference: over[i]!,
      bones: style === "artwork" ? [] : marks,
      artwork: style !== "bones",
    });
    images.push(image);
    each?.(image, i);
  }
  return images;
}
