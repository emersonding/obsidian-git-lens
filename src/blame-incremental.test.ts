import { describe, it, expect } from "vitest";
import { computeIncrementalBlame } from "./git";

const A = "a".repeat(40);
const B = "b".repeat(40);
const ZERO = "0".repeat(40);

describe("computeIncrementalBlame", () => {
  it("attributes each line to the commit that last changed it", () => {
    const versions = [
      { hash: A, lines: ["a", "b", "c"] },
      { hash: B, lines: ["a", "B2", "c", "d"] },
    ];
    // working tree adds an uncommitted line "e"
    expect(computeIncrementalBlame(versions, ["a", "B2", "c", "d", "e"])).toEqual([A, B, A, B, ZERO]);
  });

  it("keeps old attribution across a pure insertion", () => {
    const versions = [
      { hash: A, lines: ["one", "two"] },
      { hash: B, lines: ["one", "inserted", "two"] },
    ];
    expect(computeIncrementalBlame(versions, ["one", "inserted", "two"])).toEqual([A, B, A]);
  });

  it("attributes everything to the first commit when unchanged", () => {
    expect(computeIncrementalBlame([{ hash: A, lines: ["x", "y"] }], ["x", "y"])).toEqual([A, A]);
  });

  it("marks all lines uncommitted when there is no history", () => {
    expect(computeIncrementalBlame([], ["x", "y"])).toEqual([ZERO, ZERO]);
  });
});
