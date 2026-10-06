import { beforeEach, describe, expect, it } from "vitest";
import { type RecentHandle, readRecent, recent } from "@/ui/recent";

/** The list's rules; IndexedDB is absent here, and its writes fail soft, so the list lives in memory. */

const handle = (name: string, same = false, permission: PermissionState = "granted"): RecentHandle => ({
  name,
  createWritable: async () => { throw new Error("not used"); },
  getFile: async () => new File(["x"], name),
  isSameEntry: async () => same,
  queryPermission: async () => permission,
  requestPermission: async () => permission,
});

describe("recent projects", () => {
  beforeEach(async () => { await recent.clear(); });

  it("lists newest first, one entry for the same file", async () => {
    const a = handle("a.bbdata"), b = handle("b.bbdata");
    await recent.add(a);
    await recent.add(b);
    await recent.add(a);
    expect(recent.list.map((r) => r.name)).toEqual(["a.bbdata", "b.bbdata"]);
  });

  it("treats two handles to one file as one entry, and same-named files elsewhere as two", async () => {
    await recent.add(handle("a.bbdata"));
    await recent.add(handle("a.bbdata", true));
    expect(recent.list.length).toBe(1);
    await recent.add(handle("a.bbdata", false));
    expect(recent.list.length).toBe(2);
  });

  it("keeps eight", async () => {
    for (let i = 0; i < 12; i++) await recent.add(handle(`p${i}.bbdata`));
    expect(recent.list.length).toBe(8);
    expect(recent.list[0]!.name).toBe("p11.bbdata");
  });

  it("removes one and clears all", async () => {
    await recent.add(handle("a.bbdata"));
    await recent.add(handle("b.bbdata"));
    await recent.remove(recent.list[0]!);
    expect(recent.list.map((r) => r.name)).toEqual(["a.bbdata"]);
    await recent.clear();
    expect(recent.list.length).toBe(0);
  });

  it("reading one asks again for access, and says when it is refused", async () => {
    await recent.add(handle("a.bbdata"));
    expect((await readRecent(recent.list[0]!)).name).toBe("a.bbdata");
    await recent.add(handle("n.bbdata", false, "denied"));
    await expect(readRecent(recent.list[0]!)).rejects.toThrow(/did not allow n\.bbdata/);
  });
});
