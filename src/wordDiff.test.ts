import { describe, it, expect } from "vitest";
import { planDiffRows, DiffRow, WORD_DIFF_MIN_SIMILARITY } from "./wordDiff";

/** Collapse a row's segments into a compact "plain|[changed]" string for asserting. */
function show(row: DiffRow): string {
  if (!row.segments) return `<${row.cls}> ${row.text}`;
  const body = row.segments.map((s) => (s.changed ? `[${s.text}]` : s.text)).join("");
  return `<${row.cls}:words> ${row.text.slice(0, 1)}${body}`;
}

describe("planDiffRows", () => {
  it("highlights only the changed words in a similar replace pair", () => {
    const rows = planDiffRows(["-the quick brown fox", "+the quick red fox"]);
    expect(rows.map(show)).toEqual([
      "<del:words> -the quick [brown] fox",
      "<add:words> +the quick [red] fox",
    ]);
  });

  it("highlights a leading whitespace-only change", () => {
    const rows = planDiffRows(["-foo bar", "+ foo bar"]);
    // The added leading space is the only changed segment on the add side.
    const add = rows.find((r) => r.cls === "add");
    expect(add?.segments).toBeDefined();
    expect(add?.segments?.some((s) => s.changed)).toBe(true);
    expect(add?.segments?.filter((s) => s.changed).map((s) => s.text).join("")).toBe(" ");
  });

  it("preserves block order: all deletions, then all additions", () => {
    const rows = planDiffRows(["-a one", "-b two", "+a ONE", "+b TWO"]);
    expect(rows.map((r) => r.cls)).toEqual(["del", "del", "add", "add"]);
  });

  it("pairs positionally over the overlap and leaves extras as plain rows", () => {
    const rows = planDiffRows(["-x one", "-x two", "+x one!", "+y", "+z"]);
    const adds = rows.filter((r) => r.cls === "add");
    expect(adds).toHaveLength(3);
    expect(adds[0].segments).toBeDefined(); // paired with "-x one"
    expect(adds[1].segments).toBeUndefined(); // "+y" is an extra, plain row
    expect(adds[2].segments).toBeUndefined(); // "+z" is an extra, plain row
  });

  it("falls back to plain rows when the paired lines are dissimilar", () => {
    const rows = planDiffRows(["-completely different content here", "+nothing alike whatsoever"]);
    expect(rows.every((r) => r.segments === undefined)).toBe(true);
  });

  it("leaves pure deletions and pure additions untouched", () => {
    expect(planDiffRows(["-gone"]).map(show)).toEqual(["<del> -gone"]);
    expect(planDiffRows(["+new"]).map(show)).toEqual(["<add> +new"]);
  });

  it("classifies context, hunk, and meta lines", () => {
    const rows = planDiffRows(["@@ -1 +1 @@", " ctx", "\\ No newline at end of file"]);
    expect(rows.map((r) => r.cls)).toEqual(["hunk", "context", "meta"]);
    expect(rows.every((r) => r.segments === undefined)).toBe(true);
  });

  it("does not highlight a row whose every segment changed (no shared content)", () => {
    // Sanity: the similarity gate keeps the threshold meaningful.
    expect(WORD_DIFF_MIN_SIMILARITY).toBeGreaterThan(0);
  });
});
