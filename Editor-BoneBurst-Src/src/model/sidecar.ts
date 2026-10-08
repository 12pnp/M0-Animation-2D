import type { Json, JsonObject } from "./json";

/**
 * `<name>.bb.json` (SPEC §3): what the editor keeps beside a skeleton that does not change what the
 * skeleton means. Deleting it loses only these. Versioned from its first field.
 */
export const SIDECAR_FORMAT = "boneburst-sidecar";
export const SIDECAR_VERSION = 1;

export interface Sidecar {
  /** Camera, zoom, open panels: whatever the interface restores. */
  readonly view: JsonObject;
  readonly guides: readonly Guide[];
  readonly references: readonly Reference[];
  readonly notes: readonly Note[];
  /** Tags on elements of the rig (docs/TAGS-PLAN.md), by the key `edit/tags.ts` makes for the element. */
  readonly tags: readonly TagEntry[];
  /** Keys a newer version of this file wrote at the top level, kept. */
  readonly extra: JsonObject;
}

/** One element's tags, in the order they were added. */
export interface TagEntry {
  readonly key: string;
  readonly tags: readonly string[];
}

export interface Guide {
  readonly axis: "x" | "y";
  /** In skeleton units. */
  readonly at: number;
}

/** A picture to animate against: a file next to the skeleton, placed in skeleton space. */
export interface Reference {
  readonly path: string;
  readonly x: number;
  readonly y: number;
  readonly scale: number;
  readonly opacity: number;
}

/** A note left on the document, by a person or an AI. */
export interface Note {
  readonly text: string;
  readonly author?: string;
  /** What it is about: a bone, slot or animation name. */
  readonly about?: string;
}

export const EMPTY_SIDECAR: Sidecar = { view: new Map<string, Json>(), guides: [], references: [], notes: [], tags: [], extra: new Map<string, Json>() };
