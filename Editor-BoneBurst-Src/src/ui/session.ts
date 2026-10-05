import { readAtlas } from "@/io/atlas";
import { readSkeleton } from "@/io/skeletonRead";
import { writeSkeleton } from "@/io/skeletonWrite";
import { History } from "@/edit/history";
import type { Atlas } from "@/model/atlas";
import type { Issue } from "@/model/issue";
import { profileIssues } from "@/model/profile";
import type { Skeleton } from "@/model/skeleton";
import { atlasImages, NO_IMAGES, type AtlasImages } from "@/engine/regions";
import { baseName, pickFiles } from "./files";
import { poseSetup, type Posed } from "./stage/posed";

/** A file as the session reads it: a browser `File`, or a fetched fixture. */
export interface Source { name: string; text(): Promise<string>; blob(): Promise<Blob> }

export function fileSource(f: File): Source {
  return { name: f.name, text: () => f.text(), blob: async () => f };
}

/**
 * The open document and what the stage needs beside it: its history, atlas, page images, the
 * shown skin and the selection. Listeners hear every change; the pose is rebuilt once per
 * document revision.
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
  private posed: { revision: number; skin: string | null; value: Posed } | null = null;
  private readonly listeners = new Set<() => void>();

  get doc(): Skeleton | null { return this.history?.doc ?? null; }
  get dirty(): boolean { return !!this.history && this.history.doc !== this.saved; }

  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  changed(): void { for (const f of this.listeners) f(); }

  /** The document posed in its setup pose, rebuilt when the document or the skin changed. */
  pose(): Posed | null {
    const h = this.history;
    if (!h) return null;
    if (!this.posed || this.posed.revision !== h.revision || this.posed.skin !== this.skin) {
      this.posed = { revision: h.revision, skin: this.skin, value: poseSetup(h.doc, this.images, this.skin) };
    }
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
