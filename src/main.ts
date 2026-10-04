import "@fontsource-variable/jetbrains-mono";
import "@/styles/theme.css";
import "@/styles/layout.css";
import "@/styles/panels.css";
import "@/styles/timeline.css";
import "@/styles/settings.css";
import { App } from "@/app/App";
import { valueFreeze } from "@/core/doc/freeze";
import { UI_FONT_FAMILY } from "@/core/prefs/fonts";

const root = document.getElementById("app");
if (!root) throw new Error("#app not found");

// Opt-in: see core/doc/freeze.ts.
if (import.meta.env.DEV && localStorage.getItem("animo.freezeValues") === "1") valueFreeze.enabled = true;

const start = (): void => {
  const app = new App(root);
  // Handy while building; harmless in production.
  (window as unknown as Record<string, unknown>).animo = app;
};

// The timeline and rulers are canvases: what they draw before the font
// arrives stays in the fallback until something repaints them. The font is
// bundled, so waiting for it costs a few milliseconds; a failure starts anyway.
document.fonts.load(`11px ${UI_FONT_FAMILY}`).then(start, start);
