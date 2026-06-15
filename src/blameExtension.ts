import { EditorView, GutterMarker, gutter } from "@codemirror/view";
import {
  EditorState,
  Extension,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  Text,
} from "@codemirror/state";
import { BlameLine, BlameResult, DEFAULT_SETTINGS, GitLensSettings } from "./types";
import { ageColor, formatDate, shortHash, tooltipText } from "./format";

/** Everything the gutter needs to render and to answer click events. */
export interface BlameContext {
  result: BlameResult | null;
  settings: GitLensSettings;
}

/** Coordinates (viewport-relative) used to position the popup. */
export interface ClickCoords {
  x: number;
  y: number;
}

export interface BlameGutterDeps {
  onLineClick: (blame: BlameLine, repoRoot: string, coords: ClickCoords) => void;
}

/** Dispatch this effect to push fresh blame data into an editor. */
export const setBlame = StateEffect.define<BlameContext>();

/** Holds the current blame context; read by event handlers. */
const blameDataField = StateField.define<BlameContext>({
  create: () => ({ result: null, settings: DEFAULT_SETTINGS }),
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBlame)) return e.value;
    return value;
  },
});

/** Pre-built per-line gutter markers; rebuilt whenever blame data changes. */
const blameMarkersField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(markers, tr) {
    for (const e of tr.effects) if (e.is(setBlame)) return buildMarkers(tr.state.doc, e.value);
    return tr.docChanged ? markers.map(tr.changes) : markers;
  },
});

/** Read the current blame context out of an editor state (e.g. for commands). */
export function readBlameContext(state: EditorState): BlameContext | null {
  return state.field(blameDataField, false) ?? null;
}

class BlameMarker extends GutterMarker {
  constructor(
    private readonly blame: BlameLine,
    private readonly settings: GitLensSettings,
  ) {
    super();
  }

  eq(other: BlameMarker): boolean {
    return (
      other.blame.hash === this.blame.hash &&
      other.blame.authorTime === this.blame.authorTime &&
      other.settings === this.settings
    );
  }

  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "git-lens-annot";

    if (this.blame.isUncommitted) {
      el.classList.add("git-lens-uncommitted");
      el.appendChild(span("git-lens-date", "Uncommitted"));
    } else {
      if (this.settings.colorByAge) {
        el.style.borderLeftColor = ageColor(this.blame.authorTime);
      }
      if (this.settings.showHash) {
        el.appendChild(span("git-lens-hash", shortHash(this.blame.hash)));
      }
      el.appendChild(span("git-lens-date", formatDate(this.blame.authorTime, this.settings.dateStyle)));
    }

    el.setAttribute("aria-label", tooltipText(this.blame));
    el.title = tooltipText(this.blame);
    return el;
  }
}

/** Reserves a stable gutter width so annotations never collapse to a sliver. */
class SpacerMarker extends GutterMarker {
  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "git-lens-annot";
    el.appendChild(span("git-lens-hash", "0000000"));
    el.appendChild(span("git-lens-date", "0000-00-00"));
    return el;
  }
}

const spacerMarker = new SpacerMarker();

function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}

function buildMarkers(doc: Text, ctx: BlameContext): RangeSet<GutterMarker> {
  if (!ctx.result || !ctx.settings.enableGutter) return RangeSet.empty;

  const builder = new RangeSetBuilder<GutterMarker>();
  const blameLines = ctx.result.lines;
  const total = doc.lines;

  for (let n = 1; n <= total; n++) {
    const blame = blameLines[n - 1];
    if (!blame) continue;
    const from = doc.line(n).from;
    builder.add(from, from, new BlameMarker(blame, ctx.settings));
  }

  return builder.finish();
}

function handleGutterEvent(view: EditorView, lineFrom: number, event: Event, deps: BlameGutterDeps): boolean {
  const ctx = view.state.field(blameDataField, false);
  if (!ctx || !ctx.result) return false;

  const lineNo = view.state.doc.lineAt(lineFrom).number;
  const blame = ctx.result.lines[lineNo - 1];
  if (!blame) return false;

  event.preventDefault();
  event.stopPropagation();
  const mouse = event as MouseEvent;
  deps.onLineClick(blame, ctx.result.repoRoot, { x: mouse.clientX, y: mouse.clientY });
  return true;
}

/** The full set of editor extensions powering the blame gutter. */
export function blameExtension(deps: BlameGutterDeps): Extension {
  return [
    blameDataField,
    blameMarkersField,
    gutter({
      class: "git-lens-gutter",
      markers: (view) => view.state.field(blameMarkersField),
      initialSpacer: () => spacerMarker,
      domEventHandlers: {
        mousedown: (view, line, event) => handleGutterEvent(view, line.from, event, deps),
        contextmenu: (view, line, event) => handleGutterEvent(view, line.from, event, deps),
      },
    }),
  ];
}
