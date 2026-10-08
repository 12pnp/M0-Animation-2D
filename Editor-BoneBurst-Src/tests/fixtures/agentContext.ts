import type { AgentContext, AgentReference, AgentView, RenderRequest } from "@/agent/context";
import type { History } from "@/edit/history";
import { NO_IMAGES, type AtlasImages, regionAlpha } from "@/engine/regions";
import type { Page } from "@/io/pack";
import type { Skeleton } from "@/model/skeleton";
import { posedBones, poserCache } from "@/ui/agent/context";
import { constraintNow } from "@/ui/stage/posed";

/**
 * An agent context for tests (E5 step 3): the document's history, poses from the stage's own
 * `Poser`, the view kept in memory, references as given, and render requests recorded (the
 * picture itself needs a browser: the on-screen check draws it).
 */
export type TestContext = AgentContext & { told: number; shown: AgentView[]; renders: RenderRequest[]; exports: number; exportMode?: string };

/** `pages`: the atlas's pages with their pixels (a PSD import's), for `pixels`; without them every image has none. */
export function testContext(history: History<Skeleton> | null, images: AtlasImages = NO_IMAGES, references: AgentReference[] = [], pages: readonly Page[] = []): TestContext {
  const poser = poserCache(), other = poserCache();
  let view: AgentView = { animation: null, frame: 0, skin: null };
  const c: TestContext = {
    history, told: 0, shown: [], renders: [], exports: 0, images,
    changed() { c.told++; },
    view: () => view,
    show: (v) => { view = v; c.shown.push(v); },
    // At the float32 time, as the editor's context poses (keys are stored as float32).
    pose: (skin, animation, time) => posedBones(poser(history!.doc, images).pose(skin, animation, Math.fround(time))),
    poseOf: (doc, skin, animation, time) => posedBones(other(doc, images).pose(skin, animation, Math.fround(time))),
    constraintNow: (skin, animation, time, type, name) => {
      const p = poser(history!.doc, images).pose(skin, animation, Math.fround(time)), i = p.rig.data.constraints.findIndex((k) => k.kind === type && k.name === name);
      return i < 0 ? null : constraintNow(p, i);
    },
    references: () => references,
    referencePicture: async (path) => (references.some((r) => r.path === path && r.width !== null) ? `png-of-${path}` : null),
    render: async (req) => {
      c.renders.push(req);
      return { png: "png", width: 400, height: 300, scale: 0.5, origin: [200, 250] as const, bones: [{ name: "root", joint: [200, 250] as const, tip: [200, 250] as const }] };
    },
    pixels: async (image) => {
      const r = images.regions.find((x) => x.name === image), page = r && pages.find((p) => p.name === r.page.name);
      return r && page ? regionAlpha(r, page) : null;
    },
    // The folder and its writing are the browser's (tests/unityExport.test.ts, e2e): here only the call is counted.
    exportToUnity: async (mode) => { c.exports++; c.exportMode = mode; return { folder: "Unity", files: ["rig.json"] }; },
  };
  return c;
}
