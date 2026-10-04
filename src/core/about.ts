/**
 * Who made this, what it stands on, and under what licence, as data.
 *
 * Pure, like the rest of `core/`: Preferences ▸ About renders it, and the same
 * table is what a THIRD-PARTY-NOTICES file has to agree with. Keeping it here
 * rather than in the dialog means a test can check it, and means the next
 * thing that needs to print the credits (an Electron About panel, a build
 * banner) does not have to reach into `view/`.
 */

export const APP_NAME = "Amino Spine2D";
export const APP_TAGLINE = "A Flash-style animation editor for Spine 4.3";

/** The browser tab's title: the file first, since that is what tells two
 *  open tabs apart, and the same " *" as the menu bar while it is unsaved. */
export function documentTitle(fileName: string, dirty: boolean): string {
  const name = fileName.trim();
  return name ? `${name}${dirty ? " *" : ""} — ${APP_NAME}` : APP_NAME;
}

/**
 * Replaced at build time by `define` in vite.config.ts. `typeof` rather than a
 * plain read: vitest runs its own config and never substitutes the token, and
 * an undeclared identifier throws on read but is safe to `typeof`.
 */
export const APP_VERSION: string =
  typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

export const REPO_URL = "https://github.com/12pnp/Amino-Spine2D-Src";

/** The editor this one is built from. The AGPL keeps its notices with the code. */
export const ORIGIN_NAME = "Animo";
export const ORIGIN_AUTHOR = "Morenoise";
export const ORIGIN_AUTHOR_URL = "https://morenoise.it";
export const ORIGIN_REPO_URL = "https://github.com/justmorenoise/animo";

export const LICENSE_ID = "AGPL-3.0-or-later";

/** The one sentence that keeps the licence usable. See LICENSE-EXCEPTION.md. */
export const LICENSE_NOTE =
  "Amino Spine2D is free software, released under the GNU AGPL v3 or later, "
  + "like Animo, the editor it is built from. What you export is yours: the "
  + "exported files can go into any game, commercial or not.";

export const TRADEMARK_NOTE =
  "Spine is a trademark of Esoteric Software. PixiJS is a trademark of its "
  + "owners. Amino Spine2D is an independent project, not affiliated with "
  + "Esoteric Software or with Morenoise.";

/** How the editor relates to the runtime it exports for. */
export const SPINE_NOTE =
  "Amino Spine2D exports the Spine 4.3 format: a skeleton .json, a .atlas and "
  + "its pages, which any Spine 4.3 runtime plays. The Preview panel and Play "
  + "mode run the official Spine runtime on those exact files: what you see there "
  + "is what your game will show. The plan is docs/PLAN.md in the source.";

export interface Credit {
  name: string;
  /** Omitted where the version is not pinned by us. */
  version?: string;
  license: string;
  url: string;
  /** What it does here, in one line. */
  what: string;
}

export const CREDITS: readonly Credit[] = Object.freeze([
  {
    name: "Animo",
    license: "AGPL-3.0-or-later",
    url: "https://github.com/justmorenoise/animo",
    what: "The editor this one is built from, by Morenoise.",
  },
  {
    name: "spine-pixi-v8",
    version: "4.3.13",
    license: "Spine Runtimes License",
    url: "https://github.com/EsotericSoftware/spine-runtimes",
    what: "The Spine runtime. Included so the Preview plays your animation for real.",
  },
  {
    name: "spine-core",
    version: "4.3.13",
    license: "Spine Runtimes License",
    url: "https://github.com/EsotericSoftware/spine-runtimes",
    what: "The same runtime's core. Poses opened Spine files on the stage, meshes and constraints included.",
  },
  {
    name: "PixiJS",
    version: "8.21.0",
    license: "MIT",
    url: "https://pixijs.com",
    what: "Draws the Preview.",
  },
  {
    name: "ag-psd",
    license: "MIT",
    url: "https://github.com/Agamnentzar/ag-psd",
    what: "Reads Photoshop files for PSD import.",
  },
  {
    name: "fflate",
    license: "MIT",
    url: "https://github.com/101arrowz/fflate",
    what: "Compresses project files and exports.",
  },
  {
    name: "pako",
    license: "MIT AND Zlib",
    url: "https://github.com/nodeca/pako",
    what: "Decompresses PSD data for ag-psd.",
  },
  {
    name: "JetBrains Mono",
    license: "OFL-1.1",
    url: "https://github.com/JetBrains/JetBrainsMono",
    what: "The typeface of the whole interface.",
  },
  {
    name: "Vite, TypeScript, Vitest",
    license: "MIT / Apache-2.0",
    url: "https://vite.dev",
    what: "Build and test tools. Not part of the app.",
  },
]);
