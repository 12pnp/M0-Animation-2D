import { addBone, updateBone } from "@/edit/bones";
import { type Edit, EditRefused } from "@/edit/history";
import type { Skeleton } from "@/model/skeleton";
import { DIVIDER, type MenuItem } from "./menubar";
import type { Session } from "./session";
import { type Point, toLocal } from "./stage/gizmo";
import { parentMatrix, Poser } from "./stage/posed";

/** `base`, or `base2`, `base3`… the first not in `taken`. */
export function uniqueName(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}${n}`)) n++;
  return `${base}${n}`;
}

/** What the stage's right-click menu needs of the app around it. */
export interface StageMenuHost {
  readonly session: Session;
  readonly status: (message: string) => void;
  readonly keySelected: () => void;
  readonly deleteSelected: () => void;
  readonly copyPose: () => void;
  readonly pastePose: () => void;
  readonly canPastePose: () => boolean;
  readonly fit: () => void;
  readonly toggles: ReadonlyArray<{ label: string; checked: boolean; run: () => void }>;
}

/**
 * The stage's right-click menu: what acts on the bone under the pointer (it is selected first),
 * a bone added where the pointer is, the pose copy and paste, and the view's switches.
 */
export function stageMenu(host: StageMenuHost, world: Point, boneName: string | null): MenuItem[] {
  const s = host.session, doc = s.doc;
  if (!doc) return [{ label: "Open a skeleton first", disabled: true, run: () => {} }];
  if (boneName) s.select({ kind: "bone", name: boneName });
  const name = s.selectedBone, bone = doc.bones?.find((b) => b.name === name);
  const child = bone ? doc.bones?.find((b) => b.parent === bone.name) : undefined;
  const apply = (label: string, edit: Edit<Skeleton>): boolean => {
    const h = s.history;
    if (!h) return false;
    try { const ok = h.apply(label, edit); s.changed(); return ok; } catch (err) {
      if (!(err instanceof EditRefused)) throw err;
      host.status(err.message);
      return false;
    }
  };
  const items: MenuItem[] = [];
  if (bone) {
    items.push(
      { label: `Select Parent${bone.parent ? ` (${bone.parent})` : ""}`, disabled: bone.parent === undefined, run: () => s.select({ kind: "bone", name: bone.parent! }) },
      { label: `Select Child${child ? ` (${child.name})` : ""}`, disabled: !child, run: () => s.select({ kind: "bone", name: child!.name }) },
      { label: "Key Bone", disabled: !s.animation, run: host.keySelected },
      { label: "Reset Rotation, Scale and Shear", run: () => apply(`Reset the rotation, scale and shear of bone ${bone.name}`, updateBone(bone.name, { rotation: undefined, scaleX: undefined, scaleY: undefined, shearX: undefined, shearY: undefined })) },
      { label: "Delete Bone", run: host.deleteSelected },
      DIVIDER,
    );
  }
  items.push({
    label: bone ? `Add Bone Here (under ${bone.name})` : doc.bones?.length ? "Add Bone Here" : "Add Root Bone Here",
    // Without a bone selected and with bones already, a new bone goes under the first (the root).
    run: () => {
      const bones = doc.bones ?? [], parent = bone?.name ?? bones[0]?.name ?? null;
      const newName = uniqueName("bone", bones.map((b) => b.name));
      let patch: { x: number; y: number } | Record<string, never> = {};
      if (parent !== null) {
        const setup = new Poser(doc, s.images).pose(s.skin, null, 0), i = setup.bones.get(parent);
        if (i !== undefined) { const [x, y] = toLocal(parentMatrix(setup, i), world); patch = { x, y }; }
      } else patch = { x: Math.round(world[0] * 100) / 100, y: Math.round(world[1] * 100) / 100 };
      if (apply(`Add bone ${newName}`, addBone(newName, parent, { ...patch, length: 50 }))) s.select({ kind: "bone", name: newName });
    },
  });
  items.push(
    DIVIDER,
    { label: "Copy Pose", run: host.copyPose },
    { label: "Paste Pose", disabled: !host.canPastePose(), run: host.pastePose },
    DIVIDER,
    { label: "Fit to Skeleton", run: host.fit },
    ...host.toggles.map((t) => ({ label: t.label, checked: t.checked, run: t.run })),
  );
  return items;
}
