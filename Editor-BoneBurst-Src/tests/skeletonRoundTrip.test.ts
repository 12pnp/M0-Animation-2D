import { describe, expect, it } from "vitest";
import { jsonEqual, parseJson } from "@/io/json";
import { readSkeleton } from "@/io/skeletonRead";
import { writeSkeleton } from "@/io/skeletonWrite";
import { sampleFiles } from "./fixtures/samples";

/**
 * Whether key order matters in the object at `path`: in name → value maps (animations, events,
 * timelines, attachments, a transform's property map) it is document order and Spine reads it;
 * in fixed-key objects (a bone, a key) it means nothing.
 */
export function namedMap(path: readonly string[]): boolean {
  const p = path.join("/");
  return /^(events|animations)$/.test(p)
    || /^animations\/[^/]+\/(slots|bones|path|physics|slider|ik|transform|attachments)(\/[^/]+)?$/.test(p)
    || /^animations\/[^/]+\/attachments\/[^/]+\/[^/]+(\/[^/]+)?$/.test(p)
    || /^skins\/\d+\/attachments(\/[^/]+)?$/.test(p)
    || /^constraints\/\d+\/properties(\/[^/]+\/to)?$/.test(p);
}

const files = sampleFiles(".json");

describe("every sample skeleton reads and writes back unchanged", () => {
  it("has samples", () => expect(files.length).toBeGreaterThanOrEqual(10));
  it.each(files.map((f) => [f.name, f.text]))("%s", (_name, text) => {
    const { skeleton } = readSkeleton(text);
    let diff = "";
    const same = jsonEqual(parseJson(text), parseJson(writeSkeleton(skeleton)), namedMap, (d) => { diff = d; });
    expect(diff).toBe("");
    expect(same).toBe(true);
  });
  it.each(files.map((f) => [f.name, f.text]))("%s holds every section in the model", (_name, text) => {
    const { skeleton, issues } = readSkeleton(text);
    expect(issues).toEqual([]);
    expect([...skeleton.extra.keys()]).toEqual([]);
  });
});
