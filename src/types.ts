/** A single line's blame attribution. */
export interface BlameLine {
  /** 40-char commit hash, or all-zeros for not-yet-committed local changes. */
  hash: string;
  author: string;
  /** Raw `author-mail`, including the angle brackets, e.g. "<a@b.com>". */
  authorMail: string;
  /** Author time in seconds since the Unix epoch. */
  authorTime: number;
  /** First line of the commit message. */
  summary: string;
  /** True when the line has local, uncommitted modifications. */
  isUncommitted: boolean;
}

/** Result of blaming a file: its repo root plus 1-based per-line attribution. */
export interface BlameResult {
  repoRoot: string;
  /** lines[i] corresponds to document line i+1. */
  lines: BlameLine[];
}

export type DateStyle = "relative" | "absolute";

export interface GitLensSettings {
  /** Master switch for the gutter. */
  enableGutter: boolean;
  /** Show the date as "3w" (relative) or "2024-01-30" (absolute). */
  dateStyle: DateStyle;
  /** Show the short commit hash in the gutter. */
  showHash: boolean;
  /** Tint the left border of each annotation by commit age. */
  colorByAge: boolean;
  /** git binary to use; absolute path if "git" isn't on Obsidian's PATH. */
  gitPath: string;
}

export const DEFAULT_SETTINGS: GitLensSettings = {
  enableGutter: true,
  dateStyle: "absolute",
  showHash: false,
  colorByAge: true,
  gitPath: "git",
};

/** Hash git uses for the synthetic "Not Committed Yet" commit. */
export const ZERO_HASH = "0000000000000000000000000000000000000000";
