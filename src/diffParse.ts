/**
 * Pure unified-diff parsing — no Obsidian imports, so it's unit-testable. The
 * DOM rendering that consumes this lives in diff.ts.
 */

/** How a file changed in a commit; drives the per-file header badge. */
export type DiffFileKind = "added" | "deleted" | "renamed" | "modified" | "binary";

/** One file's section of a unified diff, with the git plumbing stripped out. */
export interface DiffFile {
  /** Display path (the new path; the old path for deletions). */
  path: string;
  /** Old path, set only for renames/copies. */
  oldPath?: string;
  kind: DiffFileKind;
  /** Hunk + content lines (`@@`, `+`, `-`, context) — never the `---`/`+++`/`index` headers. */
  body: string[];
}

/** A parsed `git show`/`git diff`: the commit preamble plus per-file sections. */
export interface ParsedDiff {
  /** Lines before the first file (commit hash/author/date/message for `git show`). */
  preamble: string[];
  files: DiffFile[];
}

/**
 * Parse unified-diff text into a commit preamble and per-file sections,
 * discarding the noisy `diff --git` / `index` / `---` / `+++` plumbing (its
 * meaning is folded into each file's path + kind).
 */
export function parseDiff(diff: string): ParsedDiff {
  const preamble: string[] = [];
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let inHeader = false; // collecting git's per-file header, before the first hunk

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = { path: "", kind: "modified", body: [] };
      files.push(cur);
      inHeader = true;
      // `diff --git a/<old> b/<new>` — greedy match still resolves names without spaces.
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      if (m) {
        cur.oldPath = m[1];
        cur.path = m[2];
      }
      continue;
    }

    if (!cur) {
      preamble.push(line);
      continue;
    }

    if (inHeader) {
      if (line.startsWith("@@")) {
        inHeader = false;
        cur.body.push(line);
      } else if (line.startsWith("new file mode")) {
        cur.kind = "added";
      } else if (line.startsWith("deleted file mode")) {
        cur.kind = "deleted";
      } else if (line.startsWith("rename from ")) {
        cur.kind = "renamed";
        cur.oldPath = line.slice("rename from ".length);
      } else if (line.startsWith("rename to ")) {
        cur.kind = "renamed";
        cur.path = line.slice("rename to ".length);
      } else if (line.startsWith("Binary files")) {
        if (cur.kind === "modified") cur.kind = "binary";
        cur.body.push(line);
      }
      // index / mode / similarity / --- / +++ headers are intentionally dropped.
      continue;
    }

    cur.body.push(line);
  }

  // A rename with no path change isn't a rename worth labelling as old → new.
  for (const f of files) if (f.oldPath === f.path) f.oldPath = undefined;
  return { preamble, files };
}
