import { readAtlas } from "@/io/atlas";
import { readSkeleton } from "@/io/skeletonRead";
import { writeSkeleton } from "@/io/skeletonWrite";
import { History } from "@/edit/history";
import type { Atlas } from "@/model/atlas";
import type { Issue } from "@/model/issue";
import { profileIssues } from "@/model/profile";
import type { Animation, Skeleton } from "@/model/skeleton";
import { animationDuration, DEFAULT_FPS, frameTime, timeFrame } from "@/model/timelines";
import type { PhysicsMode } from "@/engine/physics";
import { atlasImages, NO_IMAGES, type AtlasImages } from "@/engine/regions";
import { baseName, pickFiles } from "./files";
import { Poser, type Posed } from "./stage/posed";

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
  selection: string | null = null;
  /** What reading found, and pages the atlas names that were not given. */
  issues: Issue[] = [];
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
  private readonly listeners = new Set<() => void>();

  get doc(): Skeleton | null { return this.history?.doc ?? null; }
  get dirty(): boolean { return !!this.history && this.history.doc !== this.saved; }

  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  changed(): void { for (const f of this.listeners) f(); }

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

  /** Stop and put the playhead on `frame`. */
  seek(frame: number): void {
    this.playing = false;
    this.step = "none";
    this.time = Math.fround(frameTime(Math.max(0, Math.round(frame)), this.fps));
    this.changed();
  }

  play(): void {
    if (!this.animation) return;
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
    const key = `${this.history!.revision}|${this.skin}|${anim}|${this.time}|${this.tick}|${step}`;
    if (this.posed?.key !== key) this.posed = { key, value: poser.pose(this.skin, anim, this.time, step) };
    return this.posed.value;
  }

  /** Open a skeleton, its atlas and its pages from the given files. Throws when there is no skeleton. */
  async open(files: readonly Source[]): Promise<void> {
    const picked = pickFiles(files);
    if (!picked.skeleton) throw new Error("Choose a Spine skeleton (.json), with its .atlas and page images.");
    const { skeleton, issues } = readSkeleton(await picked.skeleton.text());
    const all: Issue[] = [...issues, ...profileIssues(skeleton)];
    let atlas: Atlas | null = null;
    const pages = new Map<string, ImageBitmap>();
    if (picked.atlas) {
      atlas = readAtlas(await picked.atlas.text());
      for (const p of atlas.pages) {
        const img = picked.images.get(p.name);
        if (!img) { all.push({ where: picked.atlas.name, message: `page "${p.name}" was not given; its images are not drawn` }); continue; }
        // Premultiplied on upload unless the atlas says the page already is.
        const pma = p.fields.some((f) => f.key === "pma" && f.values[0] === "true");
        pages.set(p.name, await createImageBitmap(await img.blob(), { premultiplyAlpha: pma ? "none" : "premultiply" }));
      }
    } else {
      all.push({ where: picked.skeleton.name, message: "no atlas was given; the bones are shown without images" });
    }
    for (const b of this.pages.values()) b.close();
    this.history = new History(skeleton);
    this.saved = this.history.doc;
    this.name = baseName(picked.skeleton.name);
    this.atlas = atlas;
    this.images = atlas ? atlasImages(atlas) : NO_IMAGES;
    this.pages = pages;
    this.skin = null;
    this.selection = null;
    this.shown = null;
    this.time = 0;
    this.playing = false;
    this.poser = null;
    this.issues = all;
    this.posed = null;
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
