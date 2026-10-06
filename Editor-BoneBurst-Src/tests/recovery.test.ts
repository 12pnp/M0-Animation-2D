import { describe, expect, it } from "vitest";
import { pickFiles } from "@/ui/files";
import { type RecoveryRecord, sourcesOf } from "@/ui/recovery";

/** Autosave and recovery (E6 step 4a): a kept copy opens through the same path as files. */

const record = (o: Partial<RecoveryRecord> = {}): RecoveryRecord => ({
  version: 1, name: "hero", savedAt: 0, skeleton: "{\"skeleton\":{}}", atlas: "hero.png\nsize: 4, 4\n", pages: [{ name: "hero.png", png: new Uint8Array([1, 2]) }],
  sidecar: "{\"format\":\"boneburst-sidecar\"}", generated: false, ...o,
});

describe("recovery (E6 step 4a)", () => {
  it("a record's files are picked as an opened rig's: skeleton, atlas, pages, its own sidecar", async () => {
    const picked = pickFiles(sourcesOf(record()));
    expect(picked.skeleton?.name).toBe("hero.json");
    expect(picked.atlas?.name).toBe("hero.atlas.txt");
    expect([...picked.images.keys()]).toEqual(["hero.png"]);
    expect(picked.sidecar?.name).toBe("hero.bb.json");
    expect(picked.ignored).toEqual([]);
    expect(await picked.skeleton!.text()).toBe("{\"skeleton\":{}}");
    expect(new Uint8Array(await (await picked.images.get("hero.png")!.blob()).arrayBuffer())).toEqual(new Uint8Array([1, 2]));
  });
  it("without an atlas or a sidecar, only the skeleton", () => {
    const picked = pickFiles(sourcesOf(record({ atlas: null, pages: [], sidecar: null })));
    expect([picked.skeleton?.name, picked.atlas, picked.sidecar, picked.images.size]).toEqual(["hero.json", null, null, 0]);
  });
});
