import type { Store } from "./Store";
import type { AssetStore } from "./AssetStore";
import type { AnimationReference } from "@/core/doc/types";
import type { AssetId } from "@/core/doc/ids";
import { fitReference, referenceSpacing, sheetCells } from "@/core/doc/reference";
import { symbolBounds } from "@/core/doc/pose";
import { boneburstBounds } from "@/core/boneburst/boneburstPose";
import { SetAnimationReference } from "@/core/history/timelineCommands";
import { cutSheet, naturalOrder, type ReferenceImages, sequenceImages } from "@/io/import/spriteSheet";

/** How a sheet divides, and when its frames play. */
export interface SheetLayout { columns: number; rows: number; count: number; hold: number; start: number }

/**
 * Reference art for the animation being edited (`Animation.reference`):
 * images in, one undo step out. Every change goes through
 * `SetAnimationReference`; the images join the asset store (and so the
 * project file) as they are added.
 */
export class ReferenceService {
  constructor(private readonly store: Store, private readonly assets: AssetStore) {}

  get current(): AnimationReference | undefined { return this.store.currentAnimation?.reference; }

  /** A sprite sheet, cut by `layout`, frames from `layout.start`. */
  async addSheet(file: Blob, layout: SheetLayout): Promise<void> {
    const bitmap = await createImageBitmap(file);
    const cells = sheetCells(bitmap.width, bitmap.height, layout.columns, layout.rows, layout.count);
    bitmap.close();
    await this.add(await cutSheet(file, cells), layout.hold, layout.start, "Add Reference");
  }

  /** Separate images, in their names' number order. */
  async addImages(files: File[], hold: number, start: number): Promise<void> {
    await this.add(await sequenceImages(naturalOrder(files)), hold, start, "Add Reference");
  }

  /** Placement, timing: whatever `patch` names, the rest kept. */
  update(patch: Partial<Omit<AnimationReference, "frames" | "width" | "height">>, label = "Change Reference"): void {
    const ref = this.current;
    const anim = this.store.currentAnimation;
    if (!ref || !anim) return;
    this.store.apply(new SetAnimationReference(this.store.currentSymbolId, anim.id, { ...ref, ...patch }, label));
  }

  /** One picture moved to `frame`; the others keep theirs. */
  setFrameAt(index: number, frame: number): void {
    const ref = this.current;
    if (!ref || index < 0 || index >= ref.at.length) return;
    const at = ref.at.map((v, i) => (i === index ? Math.max(0, Math.round(frame)) : v));
    this.update({ at }, "Set Reference Frame");
  }

  /** Every picture re-spaced `hold` apart from `start` — the panel's two
   * bulk fields, which replace per-picture placements. */
  respace(start: number, hold: number): void {
    const ref = this.current;
    if (!ref) return;
    const s = Math.max(0, Math.round(start)), each = Math.max(1, Math.round(hold));
    this.update({ start: s, hold: each, at: referenceSpacing(ref.frames.length, s, each) });
  }

  /** Stand the reference over what the rig draws now. */
  fitToRig(): void {
    const ref = this.current;
    if (!ref) return;
    this.update(fitReference(ref.width, ref.height, this.rigBox()), "Fit Reference");
  }

  remove(): void {
    const anim = this.store.currentAnimation;
    if (!anim?.reference) return;
    this.store.apply(new SetAnimationReference(this.store.currentSymbolId, anim.id, undefined, "Delete Reference"));
  }

  private async add(images: ReferenceImages, hold: number, start: number, label: string): Promise<void> {
    const anim = this.store.currentAnimation;
    if (!anim) throw new Error("There is no animation to add a reference to.");
    const ids: AssetId[] = [];
    for (let i = 0; i < images.blobs.length; i++) ids.push((await this.assets.addFromBlob(images.blobs[i]!, `reference ${i + 1}`)).id);
    const each = Math.max(1, Math.round(hold)), from = Math.max(0, Math.round(start));
    const ref: AnimationReference = {
      frames: ids, width: images.width, height: images.height,
      at: ids.map((_, i) => from + i * each),
      hold: each, start: from,
      ...fitReference(images.width, images.height, this.rigBox()),
    };
    this.store.apply(new SetAnimationReference(this.store.currentSymbolId, anim.id, ref, label));
  }

  /** What the symbol draws in its setup pose, in its own space. */
  private rigBox() {
    const project = this.store.project;
    const sym = this.store.currentSymbol;
    const b = (sym.spine ? boneburstBounds(project, sym) : null) ?? symbolBounds(project, sym.id);
    return b && b.w > 0 && b.h > 0 ? { x: b.x, y: b.y, w: b.w, h: b.h } : null;
  }
}
