/**
 * Pure intra-line ("word-level") diff planning — no Obsidian/DOM imports, so
 * it's unit-testable. The DOM rendering that consumes this lives in diff.ts.
 *
 * Unified diffs color whole rows, so editing one word tints the entire line.
 * Here we pair the `-`/`+` lines of a replace block and run a word diff on each
 * pair, so the renderer can highlight only the changed segments. Pairing is
 * positional (line N of the deletions with line N of the additions); a pair is
 * only word-highlighted when the two lines are similar enough, otherwise it
 * falls back to plain full-row coloring (so unrelated lines aren't confetti).
 */
import { diffWordsWithSpace } from "diff";

/** One inline run within a rendered row; `changed` runs get the strong tint. */
export interface Segment {
  text: string;
  changed: boolean;
}

/** A planned render row: a plain colored line, or (for paired edits) one with
 * inline segments to highlight just the changed words. */
export interface DiffRow {
  cls: "add" | "del" | "hunk" | "meta" | "context";
  /** Full line text, used when `segments` is absent. */
  text: string;
  /** When present, render these inline spans instead of `text`. */
  segments?: Segment[];
}

/**
 * Pairs whose two lines share less than this fraction of content render as
 * plain rows rather than word-highlighted ones. Tuning knob: lower = more
 * lines get inline highlighting (riskier on unrelated lines), higher = fewer.
 */
export const WORD_DIFF_MIN_SIMILARITY = 0.4;

/** Classify a unified-diff line by its leading marker. */
function classify(line: string): DiffRow["cls"] {
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("Binary files") || line.startsWith("\\ ")) return "meta";
  return "context";
}

/**
 * Word-diff one deletion body against one addition body (both without their
 * leading `-`/`+`). Returns the inline segments for each side plus a 0..1
 * similarity ratio (shared length over the longer side) used to gate whether
 * the caller highlights or falls back to plain rows.
 */
function diffPair(delBody: string, addBody: string): {
  del: Segment[];
  add: Segment[];
  similarity: number;
} {
  const parts = diffWordsWithSpace(delBody, addBody);
  const del: Segment[] = [];
  const add: Segment[] = [];
  let shared = 0;
  for (const part of parts) {
    if (part.added) {
      add.push({ text: part.value, changed: true });
    } else if (part.removed) {
      del.push({ text: part.value, changed: true });
    } else {
      del.push({ text: part.value, changed: false });
      add.push({ text: part.value, changed: false });
      shared += part.value.length;
    }
  }
  const longer = Math.max(delBody.length, addBody.length);
  const similarity = longer === 0 ? 1 : shared / longer;
  return { del, add, similarity };
}

/** A row with only one changed segment spanning everything is no better than a
 * plain row — drop the segments so it renders as a normal full-row tint. */
function meaningful(segments: Segment[]): Segment[] | undefined {
  return segments.some((s) => !s.changed) ? segments : undefined;
}

/**
 * Turn unified-diff body lines into a render plan, upgrading replace blocks
 * (consecutive `-` lines immediately followed by consecutive `+` lines) to
 * word-level highlighting where the paired lines are similar enough.
 */
export function planDiffRows(lines: string[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (classify(line) !== "del") {
      rows.push({ cls: classify(line), text: line });
      i++;
      continue;
    }

    // Collect the run of deletions, then any run of additions that follows it.
    let j = i;
    while (j < lines.length && classify(lines[j]) === "del") j++;
    let k = j;
    while (k < lines.length && classify(lines[k]) === "add") k++;
    const dels = lines.slice(i, j);
    const adds = lines.slice(j, k);

    if (adds.length === 0) {
      // Pure deletion block — nothing to pair against.
      for (const d of dels) rows.push({ cls: "del", text: d });
      i = j;
      continue;
    }

    // Pair positionally over the overlap; word-diff each pair, but only keep the
    // inline segments when the two lines are similar enough.
    const paired = Math.min(dels.length, adds.length);
    const computed: ReturnType<typeof diffPair>[] = [];
    for (let p = 0; p < paired; p++) {
      computed.push(diffPair(dels[p].slice(1), adds[p].slice(1)));
    }
    // Emit all deletion rows first, then all addition rows (matching git's
    // block order). Paired rows that cleared the threshold carry segments.
    dels.forEach((d, p) => {
      const c = p < paired ? computed[p] : undefined;
      const segs = c && c.similarity >= WORD_DIFF_MIN_SIMILARITY ? meaningful(c.del) : undefined;
      rows.push({ cls: "del", text: d, segments: segs });
    });
    adds.forEach((a, p) => {
      const c = p < paired ? computed[p] : undefined;
      const segs = c && c.similarity >= WORD_DIFF_MIN_SIMILARITY ? meaningful(c.add) : undefined;
      rows.push({ cls: "add", text: a, segments: segs });
    });
    i = k;
  }
  return rows;
}
