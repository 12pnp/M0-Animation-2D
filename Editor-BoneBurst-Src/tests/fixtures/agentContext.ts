import type { AgentContext, AgentReference, AgentView, RenderRequest } from "@/agent/context";
import type { History } from "@/edit/history";
import { NO_IMAGES, type AtlasImages } from "@/engine/regions";
import type { Skeleton } from "@/model/skeleton";
import { posedBones, poserCache } from "@/ui/agent/context";

/**
 * An agent context for tests (E5 step 3): the document's history, poses from the stage's own
 * `Poser`, the view kept in memory, references as given, and render requests recorded (the
 * picture itself needs a browser: the on-screen check draws it).
 */
export type TestContext = AgentContext & { told: number; shown: AgentView[]; renders: RenderRequest[] };

export function testContext(history: History<Skeleton> | null, images: AtlasImages = NO_IMAGES, references: AgentReference[] = []): TestContext {
  const poser = poserCache();
  let view: AgentView = { animation: null, frame: 0, skin: null };
  const c: TestContext = {
    history, told: 0, shown: [], renders: [], images,
    changed() { c.told++; },
    view: () => view,
    show: (v) => { view = v; c.shown.push(v); },
    pose: (skin, animation, time) => posedBones(poser(history!.doc, images).pose(skin, animation, time)),
    references: () => references,
    referencePicture: async (path) => (references.some((r) => r.path === path && r.width !== null) ? `png-of-${path}` : null),
    render: async (req) => {
      c.renders.push(req);
      return { png: "png", width: 400, height: 300, scale: 0.5, origin: [200, 250] as const, bones: [{ name: "root", joint: [200, 250] as const, tip: [200, 250] as const }] };
    },
  };
  return c;
}
