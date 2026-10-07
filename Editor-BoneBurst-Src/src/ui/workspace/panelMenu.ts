import type { IHeaderActionsRenderer, IGroupHeaderProps } from "dockview-core";
import { showContextMenu } from "../contextMenu";
import type { MenuItem } from "../menubar";
import { isPanelId, type PanelId } from "./panelIds";

/**
 * The extra menu at the top right of every panel group (a ⋮ button): Info about the panel; Reset This
 * Panel's Layout (its own view, columns or floating cards), Put This Panel Back (to its default place) and
 * Reset All Panels; then what Dockview's tab menu offers (Float, Pop out, Maximize, Close). It acts on the group's front panel.
 */
export interface PanelMenuActions {
  /** Show what the panel is for. */
  readonly info: (id: PanelId) => void;
  /** Whether the panel has a layout of its own to reset (its view, its columns, its floating cards). */
  readonly canReset: (id: PanelId) => boolean;
  /** Put that inner layout back. */
  readonly reset: (id: PanelId) => void;
  /** Put the panel back where the default layout has it. */
  readonly putBack: (id: PanelId) => void;
  /** Back to the default layout, every panel. */
  readonly resetLayout: () => void;
}

export function panelMenu(actions: PanelMenuActions): (group: unknown) => IHeaderActionsRenderer {
  return () => {
    const element = document.createElement("div");
    element.className = "panel-menu";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "panel-menu-button";
    button.title = "Panel menu";
    button.setAttribute("aria-label", "Panel menu");
    button.setAttribute("aria-haspopup", "menu");
    button.textContent = "⋮";
    element.append(button);
    let params: IGroupHeaderProps | null = null;
    button.addEventListener("click", (e) => {
      const p = params, panel = p?.group.activePanel;
      if (!p || !panel) return;
      e.stopPropagation();
      const r = button.getBoundingClientRect(), maximized = panel.api.isMaximized();
      const items: MenuItem[] = [
        { label: "Info…", run: () => { if (isPanelId(panel.id)) actions.info(panel.id); } },
        {},
        { label: "Reset This Panel's Layout", disabled: !isPanelId(panel.id) || !actions.canReset(panel.id), run: () => { if (isPanelId(panel.id)) actions.reset(panel.id); } },
        { label: "Put This Panel Back", run: () => { if (isPanelId(panel.id)) actions.putBack(panel.id); } },
        { label: "Reset All Panels", run: () => actions.resetLayout() },
        {},
        { label: "Float", run: () => p.containerApi.addFloatingGroup(panel) },
        { label: "Pop out", run: () => void p.containerApi.addPopoutGroup(panel) },
        { label: maximized ? "Restore" : "Maximize", run: () => { if (maximized) panel.api.exitMaximized(); else panel.api.maximize(); } },
        {},
        { label: "Close", run: () => panel.api.close() },
      ];
      showContextMenu(r.left, r.bottom + 2, items, button.ownerDocument.body);
    });
    return { element, init: (props) => { params = props; }, dispose: () => { params = null; } };
  };
}
