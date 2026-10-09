import { convertToFramePath, framePathReport, type FramePathOptions, type TimingMode } from "@/edit/toFramePath";
import type { Skeleton } from "@/model/skeleton";
import { DEFAULT_FPS } from "@/model/timelines";

/**
 * The analysis window a Spine export opens with (docs/SPINE-IMPORT-FRAMEPATH-PLAN.md, step 2): what the file is, what FramePath cannot
 * take as it is, and the conversion's options, before the skeleton opens. Resolves with what to do: open it (converted or as it is), or
 * nothing. A folder with only Spine's binary export (`.skel`) is said and not opened (Decision 4).
 */

/** What the window decides: open the file (converted with these options, or as it is), or cancel. */
export type OpenChoice = { readonly action: "cancel" } | { readonly action: "open"; readonly convert?: FramePathOptions };

/** What the window is shown: the file read, or a binary export without its JSON. */
export type OpenAnalysis = { readonly kind: "json"; readonly name: string; readonly skeleton: Skeleton; readonly issues: number } | { readonly kind: "skel"; readonly name: string };

const TIMINGS: readonly { value: TimingMode; label: string; note: string }[] = [
  { value: "split", label: "Match, and cut spans to stay within the tolerance", note: "the recommended: one timing for x and y, a key added where needed" },
  { value: "match", label: "Match only", note: "one timing for x and y, no keys added: the motion may move more" },
  { value: "leave", label: "Leave the timing", note: "only the separate x / y lists are merged; FramePath shows those curves as near, not exact" },
];

/**
 * Opens the window and resolves with the choice. Escape or Cancel: cancel. `convertOnly`: the same window for a document already open
 * (FramePath's ⋮ menu and its hint, step 3): no file facts, Cancel · Convert, the choice's `convert` the options.
 */
export function analyseOpen(a: OpenAnalysis, convertOnly = false): Promise<OpenChoice> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog");
    dialog.className = "import-analysis";
    dialog.setAttribute("aria-label", convertOnly ? "Convert to FramePath" : "Open: analysis");
    let choice: OpenChoice = { action: "cancel" };
    const finish = (c: OpenChoice): void => { choice = c; dialog.close(); };
    dialog.addEventListener("close", () => { dialog.remove(); resolve(choice); });
    const h = (text: string): HTMLElement => Object.assign(document.createElement("h3"), { textContent: text });
    const p = (text: string, className = ""): HTMLElement => Object.assign(document.createElement("p"), { textContent: text, className });
    const button = (text: string, act: () => void, primary = false): HTMLButtonElement => {
      const b = Object.assign(document.createElement("button"), { type: "button", textContent: text });
      if (primary) b.setAttribute("aria-pressed", "true");
      b.addEventListener("click", act);
      return b;
    };
    const row = document.createElement("div");
    row.className = "row";

    if (a.kind === "skel") {
      dialog.append(h(`Open ${a.name}`), p("This is Spine's binary export (.skel). The editor opens Spine's JSON export: in Spine, Export › JSON, then open that folder."), row);
      row.append(button("Close", () => finish({ action: "cancel" }), true));
      document.body.append(dialog);
      dialog.showModal();
      return;
    }

    const s = a.skeleton, anims = s.animations ?? [], findings = framePathReport(s);
    const fps = s.header?.fps;
    dialog.append(h(convertOnly ? `Convert ${a.name} to FramePath` : `Open ${a.name}`));
    const facts = document.createElement("dl");
    facts.className = "facts";
    for (const [k, v] of [
      ["Spine", s.header?.spine ?? "not said"],
      ["Frame rate", fps !== undefined ? `${fps} fps` : `not set (${DEFAULT_FPS} fps)`],
      ["Bones", String(s.bones?.length ?? 0)],
      ["Slots", String(s.slots?.length ?? 0)],
      ["Skins", String(s.skins?.length ?? 0)],
      ["Animations", String(anims.length)],
      ...(a.issues ? [["Read with notes", `${a.issues} (shown after opening)`]] : []),
    ] as const) facts.append(Object.assign(document.createElement("dt"), { textContent: k }), Object.assign(document.createElement("dd"), { textContent: v }));
    if (!convertOnly) dialog.append(facts, h("FramePath"));

    if (!findings.length) {
      dialog.append(p("FramePath can edit every bone's motion as it is: each keeps its translate in one list, x and y timed together."), row);
      if (convertOnly) row.append(button("Close", () => finish({ action: "cancel" }), true));
      else row.append(button("Cancel", () => finish({ action: "cancel" })), button("Open", () => finish({ action: "open" }), true));
      document.body.append(dialog);
      dialog.showModal();
      return;
    }

    const split = findings.filter((f) => f.split), apart = findings.filter((f) => f.apart), curves = apart.reduce((n, f) => n + f.apart!, 0);
    dialog.append(p([
      split.length ? `${split.length} bone${split.length === 1 ? "" : "s"} keep x and y as separate lists, which FramePath cannot edit.` : "",
      curves ? `${curves} curve${curves === 1 ? "" : "s"} time x and y apart, which FramePath shows as near, not exact.` : "",
    ].filter(Boolean).join(" ")));
    // The details: each animation and bone.
    const details = document.createElement("details");
    details.append(Object.assign(document.createElement("summary"), { textContent: `Where (${findings.length})` }));
    const table = document.createElement("table");
    table.innerHTML = "<thead><tr><th>Animation</th><th>Bone</th><th>Found</th></tr></thead>";
    const body = document.createElement("tbody");
    for (const f of findings) {
      const tr = document.createElement("tr");
      const what = [f.split ? `separate x (${f.split.x} keys) and y (${f.split.y})` : "", f.apart ? `${f.apart} curve${f.apart === 1 ? "" : "s"} timed apart` : ""].filter(Boolean).join("; ");
      for (const text of [f.animation, f.bone, what]) tr.append(Object.assign(document.createElement("td"), { textContent: text }));
      body.append(tr);
    }
    table.append(body);
    details.append(table);
    dialog.append(details);

    // The options: the timing (Decision 2) and the tolerance (Decision 3).
    const options = document.createElement("fieldset");
    options.append(Object.assign(document.createElement("legend"), { textContent: "Converting: x and y timing" }));
    let timing: TimingMode = "split";
    for (const t of TIMINGS) {
      const label = document.createElement("label"), radio = Object.assign(document.createElement("input"), { type: "radio", name: "timing", value: t.value, checked: t.value === timing });
      radio.addEventListener("change", () => { timing = t.value; tol.disabled = timing !== "split"; measure(); });
      label.append(radio, ` ${t.label}`, Object.assign(document.createElement("span"), { className: "note", textContent: ` (${t.note})` }));
      options.append(label);
    }
    const tolLabel = document.createElement("label"), tol = Object.assign(document.createElement("input"), { type: "number", min: "0.01", step: "0.1", value: "0.5" });
    tol.setAttribute("aria-label", "Tolerance");
    tolLabel.append("Tolerance ", tol, " units: how far the bone may move from where it was");
    tol.addEventListener("change", measure);
    options.append(tolLabel);
    const result = p("", "result");
    dialog.append(options, result, p(convertOnly ? "The conversion is one undo step; the file on disk changes only when it is saved." : "The conversion is one undo step after opening; the file on disk changes only when it is saved.", "note"), row);

    const opts = (): FramePathOptions => ({ timing, tolerance: Math.max(0.01, Number(tol.value) || 0.5) });
    // What converting with these options does, measured (a large file takes a moment).
    let pending = 0;
    function measure(): void {
      const ticket = ++pending;
      result.textContent = "Measuring…";
      setTimeout(() => {
        if (ticket !== pending) return;
        const r = convertToFramePath(s, opts());
        result.textContent = `Converting adds ${r.added} key${r.added === 1 ? "" : "s"}; the bones move at most ${Math.round(r.worst * 100) / 100} units from where they were${r.worst === 0 ? " (the same)" : ""}, as the curves are drawn (Spine plays a curve in 10 straight steps, which can add a little).`;
      }, 30);
    }
    if (convertOnly) row.append(button("Cancel", () => finish({ action: "cancel" })), button("Convert", () => finish({ action: "open", convert: opts() }), true));
    else row.append(
      button("Cancel", () => finish({ action: "cancel" })),
      button("Open as is", () => finish({ action: "open" })),
      button("Convert to FramePath and open", () => finish({ action: "open", convert: opts() }), true),
    );
    document.body.append(dialog);
    dialog.showModal();
    measure();
    (row.lastElementChild as HTMLButtonElement).focus();
  });
}
