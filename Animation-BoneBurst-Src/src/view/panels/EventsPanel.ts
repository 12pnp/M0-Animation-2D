import { clear, h, on } from "@/view/widgets/dom";
import type { Panel } from "@/view/widgets/Dock";
import type { Store } from "@/app/Store";
import type { SoundStore } from "@/app/SoundStore";
import { doSetEventKeys, doSetEvents } from "@/app/TimelineOps";
import { alertDialog } from "@/view/widgets/dialogs";
import {
  eventValues, type EventOverrides, renamedEvent, uniqueEventName, withEventDefValues, withEventKeyValues, withoutEvent,
} from "@/core/doc/events";
import type { EventDef, EventKey } from "@/core/doc/types";

/**
 * Events (ARCHITECTURE ▸ Events): the current symbol's events and their
 * values, and the values of the event keys picked on the timeline's Events
 * row. A key's blank field fires the event's own value.
 */
export class EventsPanel implements Panel {
  readonly id = "events";
  readonly title = "Events";
  readonly icon = "tag" as const;
  readonly el: HTMLElement;

  private body: HTMLElement;
  /** A store change while a field here has focus: rendered on blur, so the
   *  field being typed in is not rebuilt under the cursor. */
  private stale = false;

  constructor(private readonly store: Store, private readonly sounds: SoundStore) {
    this.body = h("div", { class: "props events-panel" });
    this.el = this.body;
    store.subscribe((t) => {
      if (t === "doc" || t === "timeline" || t === "ui") this.render();
    });
    sounds.onChange(() => this.render());
    on(this.body, "focusout", () => {
      if (this.stale) queueMicrotask(() => { if (!this.body.contains(document.activeElement)) this.render(); });
    });
    this.render();
  }

  private render(): void {
    if (this.body.contains(document.activeElement)) { this.stale = true; return; }
    this.stale = false;
    clear(this.body);
    const sym = this.store.currentSymbol;
    const defs = sym.events ?? [];

    const add = h("button", { class: "btn", title: "Add an event to this symbol" }, "New Event");
    on(add, "click", () => {
      const now = this.store.currentSymbol.events ?? [];
      const name = uniqueEventName(now, "event");
      doSetEvents(this.store, [...now, { name }], new Map(), `New Event "${name}"`);
    });
    this.body.appendChild(this.section("Events", [
      ...defs.map((d) => this.defRows(d)).flat(),
      h("div", { class: "prow" }, h("label"), h("div", { class: "fields" }, add)),
      ...(defs.length ? [] : [h("div", { class: "pnote" },
        "No events yet. Add one here, or right-click a frame on the timeline's Events row.")]),
    ]));

    const anim = this.store.currentAnimation;
    const frames = this.store.ui.eventFrames;
    if (anim && frames.length === 1) {
      const frame = frames[0]!;
      const keys = (anim.events ?? []).filter((k) => k.frame === frame);
      if (keys.length) this.body.appendChild(this.section(`Keys at frame ${frame + 1}`, keys.map((k, nth) => this.keyRows(k, nth, frame)).flat()));
    }
  }

  private section(title: string, rows: HTMLElement[]): HTMLElement {
    return h("div", { class: "section open" }, h("div", { class: "shead" }, h("span", null, title)), h("div", { class: "sbody" }, ...rows));
  }

  private row(label: string, ...controls: HTMLElement[]): HTMLElement {
    return h("div", { class: "prow" }, h("label", null, label), h("div", { class: `fields${controls.length > 1 ? " pair" : ""}` }, ...controls));
  }

  /** A text or number field committed on change. */
  private field(value: string, placeholder: string, commit: (text: string) => void, type = "text"): HTMLInputElement {
    const input = h("input", { type, value, placeholder, ...(type === "number" ? { step: "any" } : {}) }) as HTMLInputElement;
    on(input, "change", () => commit(input.value));
    on(input, "keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") input.blur(); });
    return input;
  }

  private writeDef(def: EventDef, patch: Partial<Omit<EventDef, "name">>, label: string): void {
    const now = this.store.currentSymbol.events ?? [];
    doSetEvents(this.store, now.map((d) => (d.name === def.name ? withEventDefValues(d, patch) : d)), new Map(), label);
  }

  private defRows(def: EventDef): HTMLElement[] {
    const v = eventValues(def);
    const name = this.field(def.name, "", async (text) => {
      const sym = this.store.currentSymbol;
      const out = renamedEvent(sym.events ?? [], sym.animations, def.name, text);
      if (!out) {
        await alertDialog({ title: "Rename Event", message: text.trim() ? `There is already an event called "${text.trim()}".` : "An event needs a name." });
        this.render();
        return;
      }
      if (text.trim() !== def.name) doSetEvents(this.store, out.defs, out.keys, `Rename Event "${def.name}"`);
    });
    const del = h("button", { class: "btn", title: "Delete this event and every key that fires it" }, "Delete");
    on(del, "click", () => {
      const sym = this.store.currentSymbol;
      const out = withoutEvent(sym.events ?? [], sym.animations, def.name);
      doSetEvents(this.store, out.defs, out.keys, `Delete Event "${def.name}"`);
    });
    const num = (key: "int" | "float" | "volume" | "balance", label: string) =>
      this.row(label, this.field(String(v[key]), "", (t) => {
        const n = Number(t);
        if (t.trim() === "" || !Number.isFinite(n)) { this.render(); return; }
        this.writeDef(def, { [key]: key === "int" ? Math.trunc(n) : n }, `Event ${label}`);
      }, "number"));

    const sound = h("select", { class: "preview-anim" }) as HTMLSelectElement;
    const paths = this.sounds.paths();
    sound.appendChild(h("option", { value: "" }, "None"));
    for (const p of paths) sound.appendChild(h("option", { value: p }, p));
    if (def.audio && !paths.includes(def.audio)) sound.appendChild(h("option", { value: def.audio }, `${def.audio} (no file)`));
    sound.appendChild(h("option", { value: "\0add" }, "Add Sound…"));
    sound.value = def.audio ?? "";
    on(sound, "change", () => {
      if (sound.value !== "\0add") { this.writeDef(def, { audio: sound.value || undefined }, "Event Sound"); return; }
      sound.value = def.audio ?? "";
      const pick = h("input", { type: "file", accept: "audio/*,.ogg,.wav,.mp3" }) as HTMLInputElement;
      on(pick, "change", () => {
        const file = pick.files?.[0];
        if (!file) return;
        const path = this.sounds.add(file, file.name);
        this.writeDef(def, { audio: path }, "Event Sound");
      });
      pick.click();
    });

    return [
      h("div", { class: "prow events-name" }, h("label", null, "Name"), h("div", { class: "fields pair" }, name, del)),
      num("int", "Int"),
      num("float", "Float"),
      this.row("String", this.field(v.string, "", (t) => this.writeDef(def, { string: t }, "Event String"))),
      this.row("Sound", sound),
      ...(def.audio ? [num("volume", "Volume"), num("balance", "Balance")] : []),
      h("div", { class: "events-sep" }),
    ];
  }

  private keyRows(key: EventKey, nth: number, frame: number): HTMLElement[] {
    const sym = this.store.currentSymbol;
    const def = (sym.events ?? []).find((d) => d.name === key.name);
    if (!def) return [];
    const own = eventValues(def);
    const write = (patch: { [K in keyof EventOverrides]?: EventOverrides[K] | undefined }, label: string) => {
      const keys = this.store.currentAnimation?.events ?? [];
      doSetEventKeys(this.store, withEventKeyValues(keys, frame, nth, patch), label);
    };
    const num = (f: "int" | "float" | "volume" | "balance", label: string) =>
      this.row(label, this.field(key[f] === undefined ? "" : String(key[f]), String(own[f]), (t) => {
        const n = Number(t);
        if (t.trim() !== "" && !Number.isFinite(n)) { this.render(); return; }
        write({ [f]: t.trim() === "" ? undefined : f === "int" ? Math.trunc(n) : n }, `Event Key ${label}`);
      }, "number"));
    return [
      this.row("Event", h("span", { class: "events-keyname" }, key.name)),
      num("int", "Int"),
      num("float", "Float"),
      this.row("String", this.field(key.string ?? "", own.string, (t) => write({ string: t === "" ? undefined : t }, "Event Key String"))),
      ...(def.audio ? [num("volume", "Volume"), num("balance", "Balance")] : []),
      h("div", { class: "events-sep" }),
    ];
  }
}
