/**
 * The preview frame, until the Spine runtime is wired in (phase 3 of
 * docs/PLAN.md). It answers the host's handshake so the protocol stays live,
 * and refuses every load: the session never sends one while the exporter is a
 * stub, and a load reaching here means that changed without this file.
 */

import type { FrameToHost, HostToFrame } from "./protocol";

function post(msg: FrameToHost): void {
  window.parent.postMessage(msg, window.location.origin);
}

window.addEventListener("message", (e: MessageEvent<HostToFrame>) => {
  if (e.origin !== window.location.origin) return;
  if (e.data?.type === "load") {
    post({ type: "error", message: "The Spine runtime preview is not built yet." });
  }
});

post({ type: "ready", version: "none" });
