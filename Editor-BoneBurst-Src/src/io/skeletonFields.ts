import type { Fields } from "./fields";

/** Each object kind's plain keys and JSON types (Format-Json-Atlas.md §4–13). */

export const HEADER: Fields = [
  ["hash", "str"], ["spine", "str"], ["x", "num"], ["y", "num"], ["width", "num"], ["height", "num"],
  ["referenceScale", "num"], ["fps", "num"], ["images", "strOrNull"], ["audio", "strOrNull"],
];

export const BONE: Fields = [
  ["name", "str"], ["parent", "str"], ["length", "num"], ["x", "num"], ["y", "num"], ["rotation", "num"],
  ["scaleX", "num"], ["scaleY", "num"], ["shearX", "num"], ["shearY", "num"], ["inherit", "str"],
  ["skin", "bool"], ["color", "str"], ["icon", "str"], ["visible", "bool"],
];

export const SLOT: Fields = [
  ["name", "str"], ["bone", "str"], ["color", "str"], ["dark", "str"], ["attachment", "str"], ["blend", "str"],
  ["visible", "bool"],
];

const CONSTRAINT_BASE: Fields = [["name", "str"], ["type", "str"], ["skin", "bool"]];

export const CONSTRAINT: Readonly<Record<string, Fields>> = {
  ik: [...CONSTRAINT_BASE, ["bones", "strs"], ["target", "str"], ["scaleY", "str"], ["mix", "num"], ["softness", "num"],
    ["bendPositive", "bool"], ["compress", "bool"], ["stretch", "bool"]],
  transform: [...CONSTRAINT_BASE, ["bones", "strs"], ["source", "str"], ["localSource", "bool"], ["localTarget", "bool"],
    ["additive", "bool"], ["clamp", "bool"], ["rotation", "num"], ["x", "num"], ["y", "num"], ["scaleX", "num"],
    ["scaleY", "num"], ["shearY", "num"], ["mixRotate", "num"], ["mixX", "num"], ["mixY", "num"], ["mixScaleX", "num"],
    ["mixScaleY", "num"], ["mixShearY", "num"]],
  path: [...CONSTRAINT_BASE, ["bones", "strs"], ["slot", "str"], ["positionMode", "str"], ["spacingMode", "str"],
    ["rotateMode", "str"], ["rotation", "num"], ["position", "num"], ["spacing", "num"], ["mixRotate", "num"],
    ["mixX", "num"], ["mixY", "num"]],
  physics: [...CONSTRAINT_BASE, ["bone", "str"], ["x", "num"], ["y", "num"], ["rotate", "num"], ["scaleX", "num"],
    ["scaleY", "str"], ["shearX", "num"], ["limit", "num"], ["fps", "num"], ["inertia", "num"], ["strength", "num"],
    ["damping", "num"], ["mass", "num"], ["wind", "num"], ["gravity", "num"], ["mix", "num"], ["inertiaGlobal", "bool"],
    ["strengthGlobal", "bool"], ["dampingGlobal", "bool"], ["massGlobal", "bool"], ["windGlobal", "bool"],
    ["gravityGlobal", "bool"], ["mixGlobal", "bool"]],
  slider: [...CONSTRAINT_BASE, ["additive", "bool"], ["loop", "bool"], ["mix", "num"], ["animation", "str"],
    ["bone", "str"], ["property", "str"], ["from", "num"], ["to", "num"], ["scale", "num"], ["local", "bool"],
    ["time", "num"], ["max", "num"]],
};

export const TRANSFORM_FROM: Fields = [["offset", "num"]];
export const TRANSFORM_TO: Fields = [["offset", "num"], ["max", "num"], ["scale", "num"]];

export const SKIN: Fields = [
  ["name", "str"], ["bones", "strs"], ["ik", "strs"], ["transform", "strs"], ["path", "strs"], ["physics", "strs"],
  ["slider", "strs"], ["color", "str"],
];

export const ATTACHMENT: Fields = [
  ["type", "str"], ["name", "str"], ["path", "str"], ["color", "str"], ["x", "num"], ["y", "num"], ["scaleX", "num"],
  ["scaleY", "num"], ["rotation", "num"], ["width", "num"], ["height", "num"], ["source", "str"], ["slot", "str"],
  ["skin", "str"], ["timelines", "bool"], ["uvs", "nums"], ["vertices", "nums"], ["triangles", "nums"], ["hull", "num"],
  ["edges", "nums"], ["vertexCount", "num"], ["closed", "bool"], ["constantSpeed", "bool"], ["lengths", "nums"],
  ["end", "str"], ["convex", "bool"], ["inverse", "bool"],
];

export const SEQUENCE: Fields = [["count", "num"], ["start", "num"], ["digits", "num"], ["setup", "num"]];

export const EVENT: Fields = [
  ["int", "num"], ["float", "num"], ["string", "str"], ["audio", "strOrNull"], ["volume", "num"], ["balance", "num"],
];

export const KEY: Fields = [
  ["time", "num"], ["value", "num"], ["x", "num"], ["y", "num"], ["color", "str"], ["light", "str"], ["dark", "str"],
  ["name", "strOrNull"], ["inherit", "str"], ["mix", "num"], ["softness", "num"], ["bendPositive", "bool"],
  ["compress", "bool"], ["stretch", "bool"], ["mixRotate", "num"], ["mixX", "num"], ["mixY", "num"],
  ["mixScaleX", "num"], ["mixScaleY", "num"], ["mixShearY", "num"], ["offset", "num"], ["vertices", "nums"],
  ["mode", "str"], ["index", "num"], ["delay", "num"], ["int", "num"], ["float", "num"], ["string", "str"],
  ["volume", "num"], ["balance", "num"],
];

export const DRAW_ORDER_OFFSET: Fields = [["slot", "str"], ["offset", "num"]];
export const DRAW_ORDER_FOLDER: Fields = [["slots", "strs"]];
