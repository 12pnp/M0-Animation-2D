/**
 * Every command a key can be bound to, with its default chords.
 *
 * Data only: the handlers live in `app/`, registered against these ids. The
 * menus, the tooltips, the Preferences list and the Keyboard Shortcuts window
 * all read labels and chords from here, so none of them can show a key the
 * dispatcher does not honour.
 *
 * Defaults follow Flash where Flash had one. `inText` marks the commands that
 * still fire while a text field has focus — the ones that did before this
 * registry existed (save, undo, the F-keys…); everything else leaves the key
 * to the field.
 */

export type CommandCategory =
  | "File" | "Edit" | "View" | "Modify" | "Timeline" | "Playback"
  | "Stage" | "Tools" | "Window" | "AI" | "Help";

export interface CommandDef {
  id: string;
  label: string;
  category: CommandCategory;
  keys: string[];
  inText?: boolean;
}

export const CATEGORY_ORDER: CommandCategory[] = [
  "File", "Edit", "View", "Modify", "Timeline", "Playback", "Stage", "Tools", "Window", "AI", "Help",
];

const c = (
  category: CommandCategory, id: string, label: string, keys: string[] = [], inText = false,
): CommandDef => (inText ? { id, label, category, keys, inText } : { id, label, category, keys });

export const PANEL_COMMANDS = [
  { id: "properties", label: "Properties" },
  { id: "library", label: "Library" },
  { id: "outline", label: "Tree" },
  { id: "subtree", label: "Sub Tree" },
  { id: "animations", label: "Animations" },
  { id: "skins", label: "Skins" },
  { id: "history", label: "History" },
  { id: "preview", label: "Preview" },
  { id: "path", label: "Local Path" },
  { id: "worldPath", label: "World Path" },
  { id: "reference", label: "Reference" },
  { id: "poses", label: "Poses" },
  { id: "timeline", label: "Timeline" },
] as const;

export const COMMANDS: CommandDef[] = [
  // ⌘N opens a browser window and never reaches the page, so New Project
  // takes ⌥⌘N instead.
  c("File", "file.new", "New Project", ["Mod+Alt+N"], true),
  c("File", "file.open", "Open…", ["Mod+O"], true),
  c("File", "file.save", "Save", ["Mod+S"], true),
  c("File", "file.saveAs", "Save As…", ["Mod+Shift+S"], true),
  c("File", "file.importImages", "Import Images…", ["Mod+R"]),
  c("File", "file.openSpine", "Open Spine…"),
  c("File", "file.openSpineFolder", "Open Spine Folder…"),
  c("File", "file.importPsd", "Import PSD…"),
  c("File", "file.importPsdLayers", "Import PSD as Layers…"),
  c("File", "file.export", "Export Spine…", ["Mod+Alt+E"]),
  c("File", "file.exportFolder", "Export to Folder…"),
  c("File", "file.exportSettings", "Export Settings…"),

  c("Edit", "edit.undo", "Undo", ["Mod+Z"], true),
  c("Edit", "edit.redo", "Redo", ["Mod+Shift+Z"], true),
  c("Edit", "edit.cut", "Cut", ["Mod+X"]),
  c("Edit", "edit.copy", "Copy", ["Mod+C"]),
  c("Edit", "edit.paste", "Paste", ["Mod+V"]),
  c("Edit", "edit.pasteOverwriteFrames", "Paste and Overwrite Frames"),
  c("Edit", "edit.duplicate", "Duplicate", ["Mod+D"]),
  c("Edit", "edit.copyProperties", "Copy Properties", ["Mod+Alt+C"]),
  c("Edit", "edit.pasteProperties", "Paste Properties", ["Mod+Alt+V"]),
  c("Edit", "edit.pastePropertiesNoPosition", "Paste Properties Except Position", ["Mod+Alt+Shift+V"]),
  c("Edit", "edit.selectAll", "Select All", ["Mod+A"]),
  c("Edit", "edit.deselectAll", "Deselect All", ["Mod+Shift+A"]),
  c("Edit", "edit.deselect", "Deselect", ["Escape"]),
  c("Edit", "edit.selectAllFrames", "Select All Frames", ["Mod+Alt+A"]),
  c("Edit", "edit.newLayer", "New Layer"),
  c("Edit", "edit.copyLayers", "Copy Layers"),
  c("Edit", "edit.pasteLayers", "Paste Layers"),
  c("Edit", "edit.duplicateLayers", "Duplicate Layer"),
  c("Edit", "edit.preferences", "Preferences…", ["Mod+,"], true),
  c("Edit", "edit.delete", "Delete", ["Backspace", "Delete"]),

  c("View", "view.zoomIn", "Zoom In", ["Mod+=", "Mod+Plus"], true),
  c("View", "view.zoomOut", "Zoom Out", ["Mod+-"], true),
  c("View", "view.zoom100", "Zoom to 100%", ["Mod+1"], true),
  c("View", "view.fitStage", "Fit to Stage", ["Mod+0"], true),
  c("View", "view.rulers", "Rulers"),
  c("View", "view.grid", "Grid"),
  c("View", "view.guides", "Guides"),
  c("View", "view.stageSettings", "Stage & Grid Settings…"),
  c("View", "view.lockGuides", "Lock Guides"),
  c("View", "view.clearGuides", "Clear Guides"),
  c("View", "view.snapping", "Snapping", ["Mod+Shift+;"], true),
  c("View", "view.snapTo.toGrid", "Snap to Grid"),
  c("View", "view.snapTo.toGuides", "Snap to Guides"),
  c("View", "view.snapTo.toObjects", "Snap to Objects"),
  c("View", "view.snapTo.toStage", "Snap to Stage Edges & Centre"),
  c("View", "view.snapTo.toPixel", "Snap to Whole Pixels"),
  c("View", "view.toolbar", "Show Toolbar"),
  c("View", "view.showBones", "Show Bones"),
  c("View", "view.showGizmos", "Show Gizmos"),
  c("View", "view.showBonePaths", "Show Bone Paths", ["Alt+B"]),
  c("View", "view.onionSkin", "Onion Skin"),
  c("View", "view.editMultipleFrames", "Edit Multiple Frames"),
  c("View", "view.onionAnchor", "Anchor Onion Markers"),
  c("View", "view.onionAll", "Onion All Frames"),
  c("View", "view.onionKeyframesOnly", "Onion Keyframes Only"),
  c("View", "view.onionOutline", "Onion Outline"),
  c("View", "view.onionTint", "Colour-coded Onion Skin"),
  c("View", "view.onionSettings", "Onion Skin Settings…"),

  c("Modify", "modify.convertToSymbol", "Convert to Symbol…", ["F8"]),
  c("Modify", "modify.editSymbol", "Edit Symbol", ["Enter"]),
  c("Modify", "modify.group", "Group", ["Mod+G"]),
  c("Modify", "modify.swapInstance", "Swap Instance"),
  c("Modify", "modify.bindToBone", "Bind to Bone"),
  c("Modify", "modify.makeMesh", "Make Mesh"),
  c("Modify", "modify.removeMesh", "Remove Mesh"),
  c("Modify", "modify.bindMesh", "Bind Mesh to Bones"),
  c("Modify", "modify.unbindMesh", "Unbind Mesh"),
  c("Modify", "modify.addBox", "Add Bounding Box"),
  c("Modify", "modify.addPoint", "Add Point"),
  c("Modify", "modify.makePath", "Make Path from Bones"),
  c("Modify", "modify.mask", "Mask"),
  c("Modify", "modify.masked", "Masked"),
  c("Modify", "modify.documentSettings", "Document Settings…"),
  c("Modify", "modify.setupMode", "Setup Pose Mode", ["Mod+Shift+M"], true),
  c("Modify", "modify.autoKey", "Auto Keyframe"),
  c("Modify", "modify.orderForward", "Draw Order: Bring Forward", ["Mod+ArrowUp"]),
  c("Modify", "modify.orderBackward", "Draw Order: Send Backward", ["Mod+ArrowDown"]),
  c("Modify", "modify.orderFront", "Draw Order: Bring to Front", ["Mod+Shift+ArrowUp"]),
  c("Modify", "modify.orderBack", "Draw Order: Send to Back", ["Mod+Shift+ArrowDown"]),

  c("Timeline", "timeline.insertFrame", "Insert Frames", ["F5"], true),
  c("Timeline", "timeline.removeFrame", "Remove Frames", ["Shift+F5"], true),
  c("Timeline", "timeline.insertFrameAll", "Insert Frames (All Layers)", ["Alt+F5"], true),
  c("Timeline", "timeline.removeFrameAll", "Remove Frames (All Layers)", ["Alt+Shift+F5"], true),
  c("Timeline", "timeline.insertKeyframe", "Insert Keyframe", ["F6"], true),
  c("Timeline", "timeline.clearKeyframe", "Clear Keyframe", ["Shift+F6"], true),
  c("Timeline", "timeline.insertBlankKeyframe", "Insert Blank Keyframe", ["F7"], true),
  c("Timeline", "timeline.goToFrame", "Go to Frame…"),
  c("Timeline", "timeline.cycle", "Cycle"),
  c("Timeline", "timeline.closeLoop", "Close Loop"),
  c("Timeline", "timeline.offsetKeys", "Offset Keys…"),
  c("Timeline", "timeline.keyChanged", "Key Changed"),
  c("Timeline", "timeline.keyAll", "Key All"),

  c("Playback", "playback.toggle", "Play / Pause", ["Space"]),
  c("Playback", "playback.prev", "Previous Frame", [","]),
  c("Playback", "playback.next", "Next Frame", ["."]),
  c("Playback", "playback.prevKey", "Previous Keyframe", ["Q"]),
  c("Playback", "playback.nextKey", "Next Keyframe", ["W"]),
  c("Playback", "playback.start", "First Frame", ["Home"]),
  c("Playback", "playback.end", "Last Frame", ["End"]),

  c("Stage", "stage.nudgeLeft", "Nudge Left", ["ArrowLeft"]),
  c("Stage", "stage.nudgeRight", "Nudge Right", ["ArrowRight"]),
  c("Stage", "stage.nudgeUp", "Nudge Up", ["ArrowUp"]),
  c("Stage", "stage.nudgeDown", "Nudge Down", ["ArrowDown"]),
  c("Stage", "stage.nudgeLeft10", "Nudge Left 10px", ["Shift+ArrowLeft"]),
  c("Stage", "stage.nudgeRight10", "Nudge Right 10px", ["Shift+ArrowRight"]),
  c("Stage", "stage.nudgeUp10", "Nudge Up 10px", ["Shift+ArrowUp"]),
  c("Stage", "stage.nudgeDown10", "Nudge Down 10px", ["Shift+ArrowDown"]),

  c("Tools", "tool.select", "Selection Tool", ["V"]),
  // Q and W step through keyframes, as in Spine.
  c("Tools", "tool.freeTransform", "Free Transform Tool", ["Shift+Q"]),
  c("Tools", "tool.pivot", "Transform Point Tool", ["P"]),
  c("Tools", "tool.bone", "Bone Tool", ["M"]),
  c("Tools", "tool.ik", "IK Target Tool", ["K"]),
  c("Tools", "tool.mesh", "Mesh Tool", ["N"]),
  c("Tools", "tool.hand", "Hand Tool", ["H"]),
  c("Tools", "tool.zoom", "Zoom Tool", ["Z"]),
  c("Tools", "tool.rotate", "Rotate Tool", ["R"]),
  c("Tools", "tool.translate", "Translate Tool", ["T"]),
  c("Tools", "tool.scale", "Scale Tool", ["S"]),
  c("Tools", "tool.shear", "Shear Tool", ["E"]),

  ...PANEL_COMMANDS.map((p) => c("Window", `window.${p.id}`, p.label)),
  ...PANEL_COMMANDS.filter((p) => p.id !== "timeline")
    .map((p) => c("Window", `window.float.${p.id}`, `Float / Dock ${p.label}`)),
  c("Window", "window.saveWorkspace", "Save Workspace…"),
  c("Window", "window.resetLayout", "Reset Layout"),

  c("AI", "ai.connect", "Connect to AI"),
  c("AI", "ai.panel", "Show AI Panel", ["Mod+Shift+L"]),
  c("AI", "ai.ask", "Ask AI…"),
  c("AI", "ai.help", "Connecting AI…"),
  c("Help", "help.shortcuts", "Keyboard Shortcuts", ["Shift+/"]),
];

export const COMMANDS_BY_ID: ReadonlyMap<string, CommandDef> =
  new Map(COMMANDS.map((d) => [d.id, d]));

/**
 * Keyboard and mouse combinations that are not commands — held modifiers and
 * drags — listed in the Keyboard Shortcuts window so it answers "what does
 * this key do" completely. Not rebindable.
 */
export const GESTURES: Array<{ chord: string; suffix?: string; label: string }> = [
  { chord: "Space", suffix: "drag", label: "Pan the stage (also the middle button)" },
  { chord: "Mod", suffix: "wheel", label: "Zoom the stage at the pointer" },
  { chord: "Shift", suffix: "wheel", label: "Scroll the stage sideways" },
  { chord: "Mod", suffix: "while dragging", label: "Suspend snapping" },
  { chord: "Alt", suffix: "drag a bone tip", label: "Re-aim the bone (Bone tool)" },
  { chord: "Escape", suffix: "while dragging a guide", label: "Put the guide back" },
  { chord: "Shift", suffix: "drag a bone path's dot", label: "Move every key of the bone by as much" },
  { chord: "Alt", suffix: "drag a bone path's dot", label: "Turn the parent too, or not, for this drag (the bone's Path drag option, flipped)" },
  { chord: "", suffix: "Double-click empty stage", label: "Exit the symbol being edited" },
  { chord: "", suffix: "Double-click a guide", label: "Type its coordinate" },
];
