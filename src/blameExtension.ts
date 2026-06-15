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
import { ageColor, commitColor, formatDate, shortHash, tooltipText } from "./format";

/** Everything the gutter needs to render and to answer click events. */
export interface BlameContext {
  result: BlameResult | null;
  settings: GitLensSettings;
}

export interface BlameGutterDeps {
  onLineClick: (blame: BlameLine, result: BlameResult) => void;
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
    if (tr.docChanged) {
      // When lines are added/removed (incl. the document finishing loading after
      // a blame dispatch), rebuild so every current line gets a marker. For pure
      // intra-line edits, remapping positions is enough and cheaper.
      if (tr.startState.doc.lines !== tr.state.doc.lines) {
        return buildMarkers(tr.state.doc, tr.state.field(blameDataField));
      }
      return markers.map(tr.changes);
    }
    return markers;
  },
});

/** Read the current blame context out of an editor state (e.g. for commands). */
export function readBlameContext(state: EditorState): BlameContext | null {
  return state.field(blameDataField, false) ?? null;
}

/** Number of gutter markers currently built for this editor (diagnostics). */
export function blameMarkerCount(state: EditorState): number {
  return state.field(blameMarkersField, false)?.size ?? 0;
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
      other.settings.colorMode === this.settings.colorMode &&
      other.settings.dateStyle === this.settings.dateStyle &&
      other.settings.showHash === this.settings.showHash
    );
  }

  toDOM(): HTMLElement {
    const el = document.createElement("div");
    el.className = "git-lens-annot";

    if (this.blame.isUncommitted) {
      el.classList.add("git-lens-uncommitted");
      el.appendChild(span("git-lens-date", "Uncommitted"));
    } else {
      if (this.settings.colorMode === "commit") {
        el.style.borderLeftColor = commitColor(this.blame.hash);
      } else if (this.settings.colorMode === "age") {
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

function span(cls: string, text: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = cls;
  s.textContent = text;
  return s;
}

function buildMarkers(doc: Text, ctx: BlameContext): RangeSet<GutterMarker> {
  // Whether to blame at all is decided upstream (global setting or per-note opt-in);
  // here we just render whatever blame result was dispatched. No result -> no gutter.
  if (!ctx.result) return RangeSet.empty;

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
  deps.onLineClick(blame, ctx.result);
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
      domEventHandlers: {
        mousedown: (view, line, event) => handleGutterEvent(view, line.from, event, deps),
        contextmenu: (view, line, event) => handleGutterEvent(view, line.from, event, deps),
      },
    }),
  ];
}
