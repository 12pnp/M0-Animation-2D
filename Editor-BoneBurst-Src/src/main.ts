import { EDITOR_NAME, SPINE_VERSION, titleFor } from "./about";

// E0 skeleton: the shell only. The stage, timeline and inspector arrive in
// E2–E4 (docs/SPEC.md ▸ Plan).
document.title = titleFor(null, false);
const app = document.getElementById("app");
if (app) app.textContent = `${EDITOR_NAME} — Spine ${SPINE_VERSION}. Nothing to edit yet.`;
