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

/** A single file changed by a commit (from `git log --name-status`). */
export interface ChangedFile {
  /** Single-letter status: A added, M modified, D deleted, R renamed, C copied, T type. */
  status: string;
  /** Path of the file (new path for renames/copies), relative to the repo root. */
  path: string;
  /** Previous path, set only for renames/copies. */
  oldPath?: string;
}

/** One commit in a file's or directory's history, for the history viewer. */
export interface CommitInfo {
  /** 40-char commit hash. */
  hash: string;
  author: string;
  /** Raw `author-mail`, including the angle brackets, e.g. "<a@b.com>". */
  authorMail: string;
  /** Author time in seconds since the Unix epoch. */
  authorTime: number;
  /** First line of the commit message. */
  summary: string;
  /** Files this commit changed (within the queried path). */
  files: ChangedFile[];
}

/** How many commits the history viewer loads per page. */
export const HISTORY_PAGE_SIZE = 200;

/** Result of blaming a file: its repo root plus 1-based per-line attribution. */
export interface BlameResult {
  repoRoot: string;
  /** Absolute path of the blamed file (used to scope `git show` to this file). */
  absFile: string;
  /** lines[i] corresponds to document line i+1. */
  lines: BlameLine[];
  /**
   * Set when blame is meaningless for this file (e.g. git-crypt encrypted: git
   * only stores whole-file ciphertext, so there is no per-line plaintext history).
   * When present, `lines` is empty and no gutter is drawn.
   */
  unavailableReason?: string;
}

export type DateStyle = "relative" | "absolute";

/** How the left annotation bar is colored. */
export type ColorMode = "commit" | "age" | "none";

/** Structured snapshot of the blame pipeline for the active file. Drives both the
 *  "Diagnose" Notice and the automated E2E assertions. */
export interface BlameStats {
  desktop: boolean;
  gutterEnabled: boolean;
  gitPath: string;
  gitVersion: string | null;
  file: string | null;
  repoRoot: string | null;
  hasView: boolean;
  hasEditor: boolean;
  gutterAttached: boolean;
  docLines: number | null;
  markers: number | null;
  blameLines: number | null;
  distinctCommits: number | null;
  unavailableReason: string | null;
}

export interface GitLensSettings {
  /** Master switch for the gutter. */
  enableGutter: boolean;
  /** Show the date as "3w" (relative) or "2024-01-30" (absolute). */
  dateStyle: DateStyle;
  /** Show the short commit hash in the gutter. */
  showHash: boolean;
  /** How the left annotation bar is colored (per-commit, by age, or off). */
  colorMode: ColorMode;
  /** git binary to use; absolute path if "git" isn't on Obsidian's PATH. */
  gitPath: string;
  /** Soft-wrap long diff lines in the history view instead of scrolling. */
  wrapDiff: boolean;
  /** Show only Markdown (`.md`) changes in the history viewer (diff + commit
   *  file lists). When false, all file types are shown. */
  diffMdOnly: boolean;
  /** Vault-relative folder paths pinned for quick history access. Each gets its
   *  own command (`Git Lens: Show history: <path>`) so a hotkey can be bound to
   *  a specific folder. An empty string "" means the vault root (all files). */
  pinnedFolders: string[];
}

export const DEFAULT_SETTINGS: GitLensSettings = {
  enableGutter: false,
  dateStyle: "absolute",
  showHash: false,
  colorMode: "commit",
  gitPath: "git",
  wrapDiff: false,
  diffMdOnly: true,
  pinnedFolders: [],
};

/** Hash git uses for the synthetic "Not Committed Yet" commit. */
export const ZERO_HASH = "0000000000000000000000000000000000000000";
