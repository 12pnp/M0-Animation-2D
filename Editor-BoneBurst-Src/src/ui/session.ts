import { readAtlas } from "@/io/atlas";
import { readSidecar, writeSidecar } from "@/io/sidecar";
import { addReference, hasContent, type View, viewOf, withView } from "@/edit/sidecar";
import { EMPTY_SIDECAR, type Sidecar } from "@/model/sidecar";
import type { Page } from "@/io/pack";
import { readSkeleton } from "@/io/skeletonRead";
import { writeSkeleton } from "@/io/skeletonWrite";
import type { LocalPose } from "@/edit/boneKeys";
import { History } from "@/edit/history";
import type { BoneWorlds } from "@/edit/meshLayout";
import { newSkeleton } from "@/edit/newSkeleton";
import type { Atlas } from "@/model/atlas";
import type { Issue } from "@/model/issue";
import { profileIssues } from "@/model/profile";
import type { Animation, ConstraintType, Skeleton } from "@/model/skeleton";
import { animationDuration, DEFAULT_FPS, frameTime, timeFrame } from "@/model/timelines";
import type { PhysicsMode } from "@/engine/physics";
import { atlasImages, NO_IMAGES, type AtlasImages } from "@/engine/regions";
import { baseName, pickFiles } from "./files";
import { importPsd } from "./psdImport";
import { planReimport, rebuildAtlas, ReimportRefused } from "./psdReimport";
import { decodePng, type PngImage } from "@/io/png";
import { readPsdLayers } from "@/io/psd";
import { writeAtlas } from "@/io/atlas";
import { matchReferences, referenceFile } from "./stage/references";
import { boneMatrix, Poser, type Posed } from "./stage/posed";

/** A selection in the rig: what the rig tree, the stage and the properties panel show. */
export type Selection =
  | { readonly kind: "bone"; readonly name: string }
  | { readonly kind: "slot"; readonly name: string }
  | { readonly kind: "attachment"; readonly skin: string; readonly slot: string; readonly key: string }
  | { readonly kind: "skin"; readonly name: string }
  | { readonly kind: "constraint"; readonly type: ConstraintType; readonly name: string }
  /** One of the skeleton's events (E6 step 4b). */
  | { readonly kind: "event"; readonly name: string };

export function sameSelection(a: Selection | null, b: Selection | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A file as the session reads it: a browser `File`, or a fetched fixture. */
export interface Source { name: string; text(): Promise<string>; blob(): Promise<Blob> }

export function fileSource(f: File): Source {
  return { name: f.name, text: () => f.text(), blob: async () => f };
}

/**
 * The open document and what the stage needs beside it: its history, atlas, page images, the
 * shown skin, the selection, the animation shown and its playhead. Listeners hear every change.
 * The rig is built once per document; the pose once per change of what is shown.
 */
export class Session {
  history: History<Skeleton> | null = null;
  name = "";
  atlas: Atlas | null = null;
  images: AtlasImages = NO_IMAGES;
  /** Page image by page name; a page with none draws nothing. */
  pages = new Map<string, ImageBitmap>();
  skin: string | null = null;
  /** What is selected: a bone, slot, attachment (skin, slot, key), skin or constraint. Not in the document, not undone. */
  selected: Selection | null = null;
  /** Mesh mode: the selected vertex of the selected mesh, and the bone whose weights the stage colours. */
  vertex: number | null = null;
  /** The reference image chosen to move on the stage (E4 step 13), by index in the sidecar; null: none. */
  reference: number | null = null;
  weightBone: string | null = null;
  /** The skeleton's sidecar (SPEC §3): view, guides, references, notes. Not the document, not undone. */
  sidecar: Sidecar = EMPTY_SIDECAR;
  /** Whether the sidecar came from a file (then it is saved even when empty), and its text as last read or written. */
  private sidecarFromFile = false;
  private sidecarWritten = "";
  /** Preferences the session takes (E4 step 10): undo steps for the next document, new references' opacity. */
  undoSteps = 500;
  referenceOpacity = 0.5;
  /** Reference pictures by reference path; a reference without one is missing (its file not given). */
  referenceImages = new Map<string, ImageBitmap>();
  /** The camera the opened sidecar asked for, for the stage to take once. */
  openedCamera: View["camera"] | null = null;
  /** An atlas and its pages the editor made (a PSD import), to be written with the next save. */
  generated: { atlasText: string; pages: readonly Page[] } | null = null;
  /** What reading found, and pages the atlas names that were not given. */
  issues: Issue[] = [];
  /** Each page's exact pixels, read when first needed (E4 step 14): from its file, or as the editor made it. */
  private pageData = new Map<string, () => Promise<PngImage>>();
  /** Re-imports (E4 step 14): the atlas before and after each, swapped as undo and redo cross its step. */
  private reimports: { before: Skeleton; after: Skeleton; old: AtlasState; next: AtlasState }[] = [];
  /** The document as last opened or saved: undo returns the very object, so undoing back to it is clean. */
  private saved: Skeleton | null = null;
  /** The animation shown and keyed, or null for the setup pose (see `animation`). */
  private shown: string | null = null;
  /** The playhead in seconds: a frame's float32 time when paused, anything while playing. */
  time = 0;
  playing = false;
  loop = true;
  /** What the next playback step does to physics: start it over, then step it. */
  private physics: "reset" | "update" = "reset";
  /** The last playback step: its number (so each step poses anew) and its physics. */
  private tick = 0;
  private step: PhysicsMode = "none";
  private poser: { doc: Skeleton; value: Poser } | null = null;
  private posed: { key: string; value: Posed } | null = null;
  /** Poses dragged with Auto Key off (by bone): shown over the animation, in no document, until keyed or the playhead moves. */
  private readonly unkeyed = new Map<string, LocalPose>();
  private unkeyedRev = 0;
  private setup: { key: string; value: BoneWorlds } | null = null;
  private readonly listeners = new Set<() => void>();

  get doc(): Skeleton | null { return this.history?.doc ?? null; }

  /** The selected bone's name, when a bone is what is selected. */
  get selectedBone(): string | null { return this.selected?.kind === "bone" ? this.selected.name : null; }

  /** Select (null: nothing) and tell the listeners. */
  select(sel: Selection | null): void {
    if (sameSelection(sel, this.selected)) return;
    this.selected = sel;
    this.vertex = null;
    // Choosing something in the rig lets go of a reference.
    if (sel) this.reference = null;
    this.changed();
  }

  /** Choose a reference to move on the stage (null: none) and tell the listeners. */
  selectReference(i: number | null): void {
    const next = i !== null && this.sidecar.references[i] ? i : null;
    if (next === this.reference) return;
    this.reference = next;
    this.changed();
  }

  /** Select a bone by name (null: nothing). */
  selectBone(name: string | null): void { this.select(name === null ? null : { kind: "bone", name }); }
  get dirty(): boolean { return !!this.history && (this.history.doc !== this.saved || this.sidecarChanged); }

  /** Guides, references or notes changed since the sidecar was read or written (the view does not count). */
  get sidecarChanged(): boolean { return contentText(this.sidecar) !== this.sidecarWritten; }

  /** Replace the sidecar (a guide edit) and tell the listeners. */
  setSidecar(next: Sidecar): void {
    if (next === this.sidecar) return;
    this.sidecar = next;
    this.changed();
  }

  /**
   * The sidecar's text to save beside the skeleton, with `view` taken now; null when there is
   * nothing to save (no content and none was opened) or it is what was last written.
   */
  sidecarToSave(view: View): string | null {
    if (!hasContent(this.sidecar) && !this.sidecarFromFile) return null;
    const next = withView(this.sidecar, view);
    const text = writeSidecar(next);
    if (text === this.lastSidecarText) return null;
    this.sidecar = next;
    this.lastSidecarText = text;
    this.sidecarWritten = contentText(next);
    this.changed();
    return text;
  }
  private lastSidecarText = "";

  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  changed(): void {
    this.followReimports();
    for (const f of this.listeners) f();
  }

  /** A page's exact pixels, or null when its file was not given (or is not a PNG). */
  async pagePixels(name: string): Promise<PngImage | null> {
    const read = this.pageData.get(name);
    if (!read) return null;
    try { return await read(); } catch { return null; }
  }

  /** The atlas as it is now, to keep with a re-import. */
  private atlasState(): AtlasState {
    return { atlas: this.atlas, images: this.images, pages: this.pages, pageData: this.pageData, generated: this.generated };
  }

  private takeAtlas(a: AtlasState): void {
    this.atlas = a.atlas; this.images = a.images; this.pages = a.pages; this.pageData = a.pageData; this.generated = a.generated;
    this.poser = null; this.posed = null; this.setup = null;
  }

  /** Undo or redo crossed a re-import's step: the atlas, pages and files to save go with it. */
  private followReimports(): void {
    const doc = this.history?.doc;
    for (const r of this.reimports) {
      if (doc === r.before && this.atlas !== r.old.atlas) this.takeAtlas(r.old);
      else if (doc === r.after && this.atlas !== r.next.atlas) this.takeAtlas(r.next);
    }
  }

  /**
   * Bring a Photoshop file into the open rig (E4-PLAN step 14): matched layers' new pixels and
   * places, new layers as slots, everything else kept; one undo step. Returns what happened, for
   * the status line; refused (nothing changed) with the reason.
   */
  async reimportPsd(f: Source): Promise<string> {
    const h = this.history, atlas = this.atlas, bones = this.setupBones();
    if (!h || !bones) throw new ReimportRefused("Open the rig first, then drop its PSD on it.");
    if (!atlas) throw new ReimportRefused("The rig has no atlas to bring the layers into; open it with its atlas and pages.");
    const psd = readPsdLayers(new Uint8Array(await (await f.blob()).arrayBuffer()), f.name);
    const plan = planReimport(h.doc, bones, this.images.regions, psd, f.name);
    // Every page, exactly: the kept regions are copied from them, and they are saved again if the step is undone.
    const old = new Map<string, PngImage>();
    for (const p of atlas.pages) {
      const read = this.pageData.get(p.name);
      if (!read) throw new ReimportRefused(`The page "${p.name}" was not opened with the rig; open the rig with all its pages, then re-import.`);
      old.set(p.name, await read());
    }
    const made = rebuildAtlas(plan, atlas, old, this.name);
    const pages = new Map<string, ImageBitmap>(), pageData = new Map<string, () => Promise<PngImage>>();
    for (const p of made.pages) {
      pages.set(p.name, await createImageBitmap(new ImageData(new Uint8ClampedArray(p.pixels), p.width, p.height), { premultiplyAlpha: "premultiply" }));
      pageData.set(p.name, async () => p);
    }
    const before = this.atlasState();
    const was: AtlasState = { ...before, generated: { atlasText: writeAtlas(atlas), pages: atlas.pages.map((p) => ({ name: p.name, ...old.get(p.name)! })) } };
    const next: AtlasState = { atlas: made.atlas, images: atlasImages(made.atlas), pages, pageData, generated: { atlasText: writeAtlas(made.atlas), pages: made.pages } };
    const docBefore = h.doc;
    // Always a step, even when only pixels changed, so undo takes the new pixels back too.
    h.apply(`Re-import ${f.name}`, (d) => ({ ...plan.edit(d) }));
    this.reimports.push({ before: docBefore, after: h.doc, old: was, next });
    this.takeAtlas(next);
    this.issues = [...plan.issues];
    this.changed();
    const parts = [
      `${plan.updated.length} layer${plan.updated.length === 1 ? "" : "s"} updated${plan.moved.length ? ` (${plan.moved.length} moved)` : ""}`,
      ...(plan.added.length ? [`${plan.added.length} added (${plan.added.join(", ")})`] : []),
      ...(plan.kept.length ? [`${plan.kept.length} kept from before`] : []),
    ];
    return `Re-imported ${f.name}: ${parts.join(", ")}. Undo takes it back; Save writes the new atlas and pages.`;
  }

  /** The animation shown, if the document still has it (an undo can take it away). */
  get animation(): Animation | null {
    return this.shown !== null ? this.doc?.animations?.find((a) => a.name === this.shown) ?? null : null;
  }

  get fps(): number {
    const f = this.doc?.header?.fps;
    return f && f > 0 ? f : DEFAULT_FPS;
  }

  /** The frame under the playhead. */
  get frame(): number { return timeFrame(this.time, this.fps); }

  /** The time keys are written at for the playhead's frame. */
  get keyTime(): number { return frameTime(this.frame, this.fps); }

  /** Show an animation (null: the setup pose), from its start. */
  showAnimation(name: string | null): void {
    this.shown = name;
    this.seek(0);
  }

  get hasUnkeyed(): boolean { return this.unkeyed.size > 0; }

  /** Hold `local` as `bone`'s pose over the animation, unkeyed. */
  setUnkeyed(bone: string, local: LocalPose): void {
    this.unkeyed.set(bone, local);
    this.unkeyedRev++;
  }

  /** Drop the unkeyed pose of `bone`, or of every bone. */
  clearUnkeyed(bone?: string): void {
    if (bone === undefined ? this.unkeyed.size > 0 : this.unkeyed.delete(bone)) this.unkeyedRev++;
    if (bone === undefined) this.unkeyed.clear();
  }

  /** Stop and put the playhead on `frame`. */
  seek(frame: number): void {
    this.clearUnkeyed();
    this.playing = false;
    this.step = "none";
    this.time = Math.fround(frameTime(Math.max(0, Math.round(frame)), this.fps));
    this.changed();
  }

  play(): void {
    if (!this.animation) return;
    this.clearUnkeyed();
    const end = animationDuration(this.animation);
    if (!this.loop && this.time >= end) this.time = 0;
    this.playing = true;
    this.physics = "reset";
    this.changed();
  }

  pause(): void {
    if (!this.playing) return;
    this.seek(this.frame);
  }

  /** One step of playback, `dt` seconds on: wraps when looping, stops at the end otherwise. */
  advance(dt: number): void {
    const a = this.animation;
    if (!this.playing || !a) return;
    const end = animationDuration(a);
    this.time += dt;
    if (this.time >= end) {
      if (this.loop && end > 0) this.time %= end;
      else { this.seek(timeFrame(end, this.fps)); return; }
    }
    this.poserFor()?.rig.update(dt);
    this.tick++;
    this.step = this.physics;
    this.physics = "update";
    this.changed();
  }

  private poserFor(): Poser | null {
    const doc = this.doc;
    if (!doc) return null;
    if (this.poser?.doc !== doc) this.poser = { doc, value: new Poser(doc, this.images) };
    return this.poser.value;
  }

  /** The document posed as shown: the setup pose, or the animation at the playhead. */
  pose(): Posed | null {
    const poser = this.poserFor();
    if (!poser) return null;
    const anim = this.animation?.name ?? null;
    const step = this.playing ? this.step : "none";
    const key = `${this.history!.revision}|${this.skin}|${anim}|${this.time}|${this.tick}|${step}|${this.unkeyedRev}`;
    if (this.posed?.key !== key) this.posed = { key, value: poser.pose(this.skin, anim, this.time, step, this.unkeyed) };
    return this.posed.value;
  }

  /**
   * Each bone's world matrix on the setup pose (with the shown skin), by bone index: what binding
   * and weighted mesh edits measure from, whatever the stage is showing. Its own rig, so the
   * shown pose is not disturbed.
   */
  setupBones(): BoneWorlds | null {
    const doc = this.doc;
    if (!doc) return null;
    const key = `${this.history!.revision}|${this.skin}`;
    if (this.setup?.key !== key) {
      const p = new Poser(doc, this.images).pose(this.skin, null, 0);
      this.setup = { key, value: (doc.bones ?? []).map((b) => [...boneMatrix(p, p.bones.get(b.name)!)]) };
    }
    return this.setup.value;
  }

  /** Open a skeleton, its atlas and its pages from the given files. Throws when there is no skeleton. */
  async open(files: readonly Source[]): Promise<void> {
    const picked = pickFiles(files);
    if (picked.psd && !picked.skeleton) { await this.openPsd(picked.psd); return; }
    if (!picked.skeleton && !picked.atlas) throw new Error("Choose a Spine skeleton (.json) with its .atlas and page images, or an atlas with its images to start a new skeleton.");
    // An atlas alone starts a new skeleton (a root bone) to build a rig from its regions.
    const { skeleton, issues } = picked.skeleton ? readSkeleton(await picked.skeleton.text()) : { skeleton: newSkeleton(randomHash()), issues: [] };
    const fileName = picked.skeleton?.name ?? `${picked.atlas!.name.replace(/\.atlas(\.txt)?$/i, "")}.json`;
    const all: Issue[] = [...issues, ...profileIssues(skeleton)];
    let atlas: Atlas | null = null;
    const pages = new Map<string, ImageBitmap>(), pageData = new Map<string, () => Promise<PngImage>>();
    if (picked.atlas) {
      atlas = readAtlas(await picked.atlas.text());
      for (const p of atlas.pages) {
        const img = picked.images.get(p.name);
        if (!img) { all.push({ where: picked.atlas.name, message: `page "${p.name}" was not given; its images are not drawn` }); continue; }
        // Premultiplied on upload unless the atlas says the page already is.
        const pma = p.fields.some((f) => f.key === "pma" && f.values[0] === "true");
        pages.set(p.name, await createImageBitmap(await img.blob(), { premultiplyAlpha: pma ? "none" : "premultiply" }));
        pageData.set(p.name, async () => decodePng(new Uint8Array(await (await img.blob()).arrayBuffer()), p.name));
      }
    } else {
      all.push({ where: fileName, message: "no atlas was given; the bones are shown without images" });
    }
    let sidecar: Sidecar = EMPTY_SIDECAR;
    if (picked.sidecar) {
      const read = readSidecar(await picked.sidecar.text());
      sidecar = read.sidecar;
      all.push(...read.issues.map((i) => ({ where: `${picked.sidecar!.name}: ${i.where}`, message: i.message })));
    }
    this.replace(skeleton, picked.skeleton !== null, baseName(fileName), atlas, pages, all);
    this.pageData = pageData;
    if (picked.sidecar) {
      this.takeSidecar(sidecar);
      // The references' pictures: opened images the atlas does not use, by file name.
      const { found, missing } = matchReferences(sidecar.references.map((r) => r.path), [...picked.images.keys()], atlas?.pages.map((p) => p.name) ?? []);
      for (const [path, image] of found) this.referenceImages.set(path, await createImageBitmap(await picked.images.get(image)!.blob(), { premultiplyAlpha: "premultiply" }));
      for (const path of missing) this.issues.push({ where: picked.sidecar.name, message: `reference "${path}" was not given; kept, not shown` });
      this.changed();
    }
  }

  /**
   * Images dropped or chosen while a document is open become references (E4-PLAN step 9): one a
   * missing reference names fills it; any other is added at `centre`, scale 1, the preferred opacity.
   * Returns what happened, for the status line.
   */
  async addReferenceImages(files: readonly Source[], centre: readonly [number, number]): Promise<string> {
    const filled: string[] = [], added: string[] = [];
    for (const f of files) {
      const bitmap = await createImageBitmap(await f.blob(), { premultiplyAlpha: "premultiply" });
      const name = f.name.toLowerCase();
      const missing = this.sidecar.references.find((r) => referenceFile(r.path).toLowerCase() === name && !this.referenceImages.has(r.path));
      if (missing) { this.referenceImages.set(missing.path, bitmap); filled.push(f.name); continue; }
      const path = f.name;
      this.referenceImages.get(path)?.close();
      this.sidecar = addReference(this.sidecar, { path, x: centre[0], y: centre[1], scale: 1, opacity: this.referenceOpacity });
      this.referenceImages.set(path, bitmap);
      added.push(f.name);
    }
    this.changed();
    return [added.length ? `Added ${added.join(", ")} as reference${added.length > 1 ? "s" : ""}; keep ${added.length > 1 ? "them" : "it"} beside the skeleton.` : "",
      filled.length ? `Showing ${filled.join(", ")}.` : ""].filter(Boolean).join(" ");
  }

  /** The opened sidecar, and the view it keeps: skin and animation now, the camera for the stage. */
  private takeSidecar(s: Sidecar): void {
    this.sidecar = s;
    this.sidecarFromFile = true;
    this.sidecarWritten = contentText(s);
    this.lastSidecarText = writeSidecar(s);
    const v = viewOf(s), doc = this.doc!;
    if (v.skin !== undefined && doc.skins?.some((k) => k.name === v.skin)) this.skin = v.skin === "default" ? null : v.skin;
    if (v.animation !== undefined && doc.animations?.some((a) => a.name === v.animation)) this.shown = v.animation;
    this.openedCamera = v.camera ?? null;
    this.changed();
  }

  /**
   * Import a Photoshop file as a new, unsaved skeleton with the atlas and pages made from its
   * layers (E4-PLAN step 7). Refusals (`PsdRefused`, `PackRefused`) pass through with their reason.
   */
  private async openPsd(f: Source): Promise<void> {
    const im = importPsd(await (await f.blob()).arrayBuffer(), f.name, randomHash());
    const pages = new Map<string, ImageBitmap>();
    for (const p of im.pages) {
      pages.set(p.name, await createImageBitmap(new ImageData(new Uint8ClampedArray(p.pixels), p.width, p.height), { premultiplyAlpha: "premultiply" }));
    }
    this.replace(im.skeleton, false, im.name, im.atlas, pages, [...im.issues, ...profileIssues(im.skeleton)]);
    this.generated = { atlasText: im.atlasText, pages: im.pages };
    this.pageData = new Map(im.pages.map((p) => [p.name, async () => p]));
  }

  /** Start over on a new document. */
  private replace(skeleton: Skeleton, fromFile: boolean, name: string, atlas: Atlas | null, pages: Map<string, ImageBitmap>, all: Issue[]): void {
    const keep = new Set<ImageBitmap>();
    for (const r of this.reimports) for (const st of [r.old, r.next]) for (const b of st.pages.values()) keep.add(b);
    for (const b of [...this.pages.values(), ...keep]) b.close();
    this.reimports = [];
    this.pageData = new Map();
    this.generated = null;
    this.sidecar = EMPTY_SIDECAR;
    this.sidecarFromFile = false;
    this.sidecarWritten = contentText(EMPTY_SIDECAR);
    this.lastSidecarText = "";
    this.openedCamera = null;
    for (const b of this.referenceImages.values()) b.close();
    this.referenceImages = new Map();
    this.history = new History(skeleton, this.undoSteps);
    // A skeleton started from an atlas or a PSD is new: unsaved until saved.
    this.saved = fromFile ? this.history.doc : null;
    this.name = name;
    this.atlas = atlas;
    this.images = atlas ? atlasImages(atlas) : NO_IMAGES;
    this.pages = pages;
    this.skin = null;
    this.selected = null;
    this.vertex = null;
    this.reference = null;
    this.weightBone = null;
    this.setup = null;
    this.shown = null;
    this.clearUnkeyed();
    this.time = 0;
    this.playing = false;
    this.poser = null;
    this.issues = all;
    this.posed = null;
    this.changed();
  }

  /**
   * Open a recovery copy (E6 step 4a) through the same path as files, then mark it unsaved; an
   * atlas the editor had made (a PSD import never saved) is to be written by the next Save again.
   */
  async restore(files: readonly Source[], generated: { atlasText: string } | null): Promise<void> {
    await this.open(files);
    this.saved = null;
    if (generated && this.atlas) {
      const pages: Page[] = [];
      for (const p of this.atlas.pages) {
        const px = await this.pagePixels(p.name);
        if (px) pages.push({ name: p.name, ...px });
      }
      this.generated = { atlasText: generated.atlasText, pages };
    }
    this.changed();
  }

  /** The document as Spine JSON text; marks it saved. */
  save(): string {
    if (!this.history) throw new Error("Nothing is open.");
    const text = writeSkeleton(this.history.doc);
    this.saved = this.history.doc;
    this.changed();
    return text;
  }
}

/** An atlas with what goes with it: its regions in numbers, page images, exact pixels, the files Save writes. */
interface AtlasState {
  readonly atlas: Atlas | null;
  readonly images: AtlasImages;
  readonly pages: Map<string, ImageBitmap>;
  readonly pageData: Map<string, () => Promise<PngImage>>;
  readonly generated: { atlasText: string; pages: readonly Page[] } | null;
}

/** A random 11-character hash for a new skeleton's header, like the Spine Editor's. */
function randomHash(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return btoa(String.fromCharCode(...bytes)).slice(0, 11);
}

/** A sidecar's text without its view: what makes it need saving. */
function contentText(s: Sidecar): string {
  return writeSidecar({ ...s, view: new Map() });
}
