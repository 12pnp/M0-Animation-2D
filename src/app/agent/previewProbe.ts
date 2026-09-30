import type { Store } from "@/app/Store";
import type { AssetStore } from "@/app/AssetStore";
import { buildExports } from "@/io/export/ExportBundle";
import { PreviewHost } from "@/preview/previewHost";
import { stageSkinOf } from "@/core/spine/spinePose";
import type { PreviewProbe } from "./AgentApi";

/**
 * `check_preview`'s runtime: a preview page of its own, hidden, fed the
 * export exactly as the Preview panel is, so a check neither needs the panel
 * open nor moves what it shows. Loaded once per document revision and
 * animation, then seeked frame by frame.
 */
export class HiddenPreviewProbe implements PreviewProbe {
  private host: PreviewHost | null = null;
  private loadedFor = "";

  constructor(private readonly store: Store, private readonly assets: AssetStore) {}

  async matricesAt(animation: string, frame: number): Promise<Record<string, number[]>> {
    const host = this.ensureHost();
    const sym = this.store.currentSymbol;
    const key = `${this.store.history.revision}|${sym.id}|${animation}`;
    if (key !== this.loadedFor) {
      const result = (await buildExports(this.store.project, this.assets, [sym.id])).get(sym.id)!;
      const loaded = host.once("loaded", 20000);
      const skins = sym.spine ? stageSkinOf(sym) : [];
      host.load(result.skeleton, result.atlas, result.pages.map((p) => ({ name: p.info.imagePath, png: p.blob })), {
        animation, frame, ...(skins.length ? { skins } : {}),
      });
      const msg = await loaded;
      if (msg.animation !== animation) throw new Error(`The runtime has no animation "${animation}" in the export.`);
      this.loadedFor = key;
    }
    // In order: the frame handles one message after another, and a seek poses
    // the skeleton before the matrices are read.
    const answer = host.once("matrices");
    host.post({ type: "seek", frame });
    host.post({ type: "getMatrices" });
    return (await answer).bones;
  }

  private ensureHost(): PreviewHost {
    if (this.host) return this.host;
    const host = new PreviewHost();
    host.iframe.style.cssText = "position:fixed;left:-10000px;top:0;width:64px;height:64px;border:0";
    host.iframe.setAttribute("aria-hidden", "true");
    document.body.appendChild(host.iframe);
    this.host = host;
    return host;
  }

  dispose(): void {
    this.host?.detach();
    this.host = null;
    this.loadedFor = "";
  }
}
