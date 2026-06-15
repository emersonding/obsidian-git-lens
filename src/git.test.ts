import { describe, it, expect } from "vitest";
import { parsePorcelain } from "./git";
import { ZERO_HASH } from "./types";

// Two committed lines from one commit, then one uncommitted line.
const SAMPLE = [
  "a3f9c1d2e3f4a5b6c7d8e9f01122334455667788 1 1 2",
  "author Ada Lovelace",
  "author-mail <ada@example.com>",
  "author-time 1700000000",
  "author-tz +0000",
  "committer Ada Lovelace",
  "committer-mail <ada@example.com>",
  "committer-time 1700000000",
  "committer-tz +0000",
  "summary Add intro paragraph",
  "filename note.md",
  "\t# Intro",
  "a3f9c1d2e3f4a5b6c7d8e9f01122334455667788 2 2",
  "author Ada Lovelace",
  "author-mail <ada@example.com>",
  "author-time 1700000000",
  "author-tz +0000",
  "summary Add intro paragraph",
  "filename note.md",
  "\tSecond line of intro",
  ZERO_HASH + " 3 3 1",
  "author Not Committed Yet",
  "author-mail <not.committed.yet>",
  "author-time 1700000100",
  "author-tz +0000",
  "summary Version of note.md from note.md",
  "filename note.md",
  "\tWork in progress",
  "",
].join("\n");

describe("parsePorcelain", () => {
  it("maps every document line to a blame entry", () => {
    const lines = parsePorcelain(SAMPLE);
    expect(lines).toHaveLength(3);
  });

  it("attributes committed lines to their commit", () => {
    const [first, second] = parsePorcelain(SAMPLE);
    expect(first.hash).toBe("a3f9c1d2e3f4a5b6c7d8e9f01122334455667788");
    expect(first.author).toBe("Ada Lovelace");
    expect(first.authorTime).toBe(1700000000);
    expect(first.summary).toBe("Add intro paragraph");
    expect(first.isUncommitted).toBe(false);
    // Second block omits some headers; metadata is carried over by hash.
    expect(second.author).toBe("Ada Lovelace");
    expect(second.summary).toBe("Add intro paragraph");
  });

  it("flags uncommitted lines", () => {
    const lines = parsePorcelain(SAMPLE);
    const last = lines[2];
    expect(last.hash).toBe(ZERO_HASH);
    expect(last.isUncommitted).toBe(true);
  });

  it("returns an empty array for empty input", () => {
    expect(parsePorcelain("")).toEqual([]);
  });
});
