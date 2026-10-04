import type { Store } from "@/app/Store";
import { focusRows, type LayerRow } from "@/core/doc/layerTree";

/** The rows the layer column and the frame grid both show (`focusRows`). */
export function timelineRows(store: Store): LayerRow[] {
  return focusRows(store.currentSymbol, store.ui.timelineFocus, store.prefs.value.timeline.focusSelected);
}
