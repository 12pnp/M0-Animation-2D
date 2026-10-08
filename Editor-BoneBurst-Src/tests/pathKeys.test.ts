import { describe, expect, it } from "vitest";
import { deleteTranslateKeys, translateKeyCount } from "@/edit/pathKeys";
import type { Animation, Key, Skeleton } from "@/model/skeleton";
import { keyLists } from "@/model/timelines";

/** FramePath's ⋮ ▸ Delete FramePath data (docs/FRAMEPATH-SPEED-PLAN.md): a bone's translate keys counted and deleted. */
describe("a bone's translate keys", () => {
  const FPS = 30;
  const key = (frame: number, f: Partial<Key> = {}): Key => ({ ...(frame ? { time: frame / FPS } : {}), ...f, extra: new Map() }) as Key;
  const doc = (a: Animation): Skeleton => ({ header: { fps: FPS }, bones: [{ name: "b", x: 5, y: -3 }], animations: [a] }) as unknown as Skeleton;
  it("are counted on every translate timeline, and deleted with no other key", () => {
    const a = { name: "a", bones: [{ name: "b", timelines: [{ name: "rotate", keys: [key(0, { value: 1 })] }, { name: "translatex", keys: [key(0, { value: 4 }), key(3, { value: 5 })] }, { name: "translatey", keys: [key(0, { value: 4 })] }, { name: "translate", keys: [key(0, { x: 1, y: 1 })] }] }, { name: "c", timelines: [{ name: "translate", keys: [key(0, { x: 1, y: 1 })] }] }], extra: new Map() } as unknown as Animation;
    expect(translateKeyCount(a, "b")).toBe(4);
    expect(translateKeyCount(a, "c")).toBe(1);
    expect(translateKeyCount(a, "nobody")).toBe(0);
    const out = deleteTranslateKeys("a", "b")(doc(a)).animations![0]!;
    expect(translateKeyCount(out, "b")).toBe(0);
    expect(translateKeyCount(out, "c")).toBe(1);
    expect(keyLists(out).find((l) => "timeline" in l.path && l.path.timeline === "rotate")!.keys).toHaveLength(1);
    expect(() => deleteTranslateKeys("a", "nobody")(doc(a))).toThrow();
  });
});
