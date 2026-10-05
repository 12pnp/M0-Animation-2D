import { beforeEach, describe, expect, it } from "vitest";
import { reseed } from "@/core/doc/ids";
import { Store } from "@/app/Store";
import { AgentApi } from "@/app/agent/AgentApi";
import { AgentError } from "@/app/agent/agentArgs";
import { unityWriteOrder } from "@/io/export/UnityExport";
import { loadStickman } from "./fixtures/stickman";

/**
 * File › Export to Unity and the AI's `export_to_unity` (docs/BONEBURST-PIPELINE-PLAN.md
 * R4). Writing into the folder needs the browser's File System Access; checked in the app.
 */

beforeEach(() => reseed());

describe("the order an export is written into Unity", () => {
  it.each<[string[], string[]]>([
    [["a.json", "a.atlas.txt", "a.png"], ["a.png", "a.atlas.txt", "a.json"]],
    [["a.json", "a2.png", "audio/step.ogg", "a.atlas.txt", "a.png"], ["a.png", "a2.png", "audio/step.ogg", "a.atlas.txt", "a.json"]],
    [["a.atlas", "a.json", "a.png"], ["a.png", "a.atlas", "a.json"]],
  ])("%j: pages and sounds, then the atlas, the skeleton last", (names, order) => {
    expect(unityWriteOrder(names)).toEqual(order);
  });
});

describe("export_to_unity", () => {
  const api = async (unity?: ConstructorParameters<typeof AgentApi>[4]) => {
    const { project } = await loadStickman();
    return new AgentApi(new Store(project), undefined, undefined, undefined, unity);
  };

  it("says it needs the page where there is none", async () => {
    await expect((await api()).call("export_to_unity")).rejects.toThrow(/needs the editor page/);
  });

  it("writes through the page and says what Unity does next", async () => {
    const out = await (await api({ export: async () => ({ folder: "stickman", files: ["stickman.png", "stickman.atlas.txt", "stickman.json"] }) }))
      .call("export_to_unity") as { folder: string; files: string[]; note: string };
    expect(out.folder).toBe("stickman");
    expect(out.files.at(-1)).toBe("stickman.json");
    expect(out.note).toMatch(/rebakes/);
  });

  it("passes on the page's refusal as the model's error", async () => {
    const refused = (await api({ export: async () => { throw new Error("No Unity folder is set for this document"); } })).call("export_to_unity");
    await expect(refused).rejects.toBeInstanceOf(AgentError);
    await expect(refused).rejects.toThrow(/No Unity folder/);
  });
});
