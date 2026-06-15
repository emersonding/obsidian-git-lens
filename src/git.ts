import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import { BlameLine, BlameResult } from "./types";

const execFileAsync = promisify(execFile);

interface CacheEntry {
  mtime: number;
  result: BlameResult | null;
}

/**
 * Augment PATH with common git locations. GUI apps on macOS (Obsidian launched
 * from Finder/Dock) frequently inherit a minimal PATH that omits Homebrew and
 * even /usr/bin, so a bare `git` can fail with ENOENT despite git being installed.
 */
function gitEnv(): NodeJS.ProcessEnv {
  if (process.platform === "win32") return process.env;
  const extra = ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/opt/local/bin"];
  const current = process.env.PATH ? process.env.PATH.split(":") : [];
  const merged = Array.from(new Set([...current, ...extra])).filter(Boolean).join(":");
  return { ...process.env, PATH: merged };
}

/**
 * Runs git via child_process to compute per-line blame. Desktop only.
 * All commands use an argument array (never a shell string), so paths with
 * spaces or unicode are handled safely.
 */
export class GitBlameService {
  /** git binary to invoke; override with an absolute path when not on PATH. */
  gitPath = "git";

  private cache = new Map<string, CacheEntry>();

  private async run(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(this.gitPath, args, {
      cwd,
      env: gitEnv(),
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  }

  /** `git --version`; rejects (ENOENT) if the binary can't be found. */
  async version(cwd: string): Promise<string> {
    return (await this.run(cwd, ["--version"])).trim();
  }

  /** Repository root containing a file, or null if it isn't in a git repo. */
  async getRepoRoot(absFile: string): Promise<string | null> {
    try {
      const out = await this.run(path.dirname(absFile), ["rev-parse", "--show-toplevel"]);
      return out.trim() || null;
    } catch {
      return null;
    }
  }

  invalidate(absFile: string): void {
    this.cache.delete(absFile);
  }

  clear(): void {
    this.cache.clear();
  }

  /**
   * Per-line blame for a file. Returns null when the file is outside any git
   * repo, untracked, or git is unavailable. Results are cached per (path, mtime).
   */
  async blame(absFile: string, mtime: number): Promise<BlameResult | null> {
    const cached = this.cache.get(absFile);
    if (cached && cached.mtime === mtime) return cached.result;

    let result: BlameResult | null = null;
    try {
      const repoRoot = await this.getRepoRoot(absFile);
      if (repoRoot) {
        // Run from the file's own directory with its basename so we never depend
        // on path.relative(), which breaks when the vault sits under a symlinked
        // prefix (e.g. /var -> /private/var on macOS) that git canonicalizes.
        const out = await this.run(path.dirname(absFile), [
          "blame",
          "--line-porcelain",
          "--",
          path.basename(absFile),
        ]);
        result = { repoRoot, absFile, lines: parsePorcelain(out) };
      }
    } catch {
      // Untracked file, git missing, etc. — treat as "no blame".
      result = null;
    }

    this.cache.set(absFile, { mtime, result });
    return result;
  }

  /**
   * `git show <hash>` for the diff modal, scoped to a single file. Runs from the
   * file's own directory with its basename (symlink-safe, like blame).
   */
  async show(absFile: string, hash: string): Promise<string> {
    return this.run(path.dirname(absFile), [
      "show",
      "--no-color",
      hash,
      "--",
      path.basename(absFile),
    ]);
  }
}

interface CommitMeta {
  author: string;
  authorMail: string;
  authorTime: number;
  summary: string;
}

/**
 * Parse `git blame --line-porcelain` output into 1-based per-line entries.
 * Each line in the output is a block: a header
 *   `<40-hex> <orig-line> <final-line> [<group-size>]`
 * followed by metadata headers, then a TAB-prefixed content line.
 */
export function parsePorcelain(out: string): BlameLine[] {
  const lines: BlameLine[] = [];
  const metaByHash = new Map<string, CommitMeta>();

  const rows = out.split("\n");
  let i = 0;
  // Hash is 40 hex chars (SHA-1) or 64 (SHA-256); header is
  // `<hash> <orig-line> <final-line> [<group-size>]`.
  const headerRe = /^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/;

  while (i < rows.length) {
    const match = headerRe.exec(rows[i]);
    if (!match) {
      i++;
      continue;
    }

    const hash = match[1];
    const meta: CommitMeta = { ...(metaByHash.get(hash) ?? { author: "", authorMail: "", authorTime: 0, summary: "" }) };
    i++;

    // Consume metadata header lines until the TAB-prefixed content line.
    while (i < rows.length && !rows[i].startsWith("\t")) {
      const row = rows[i];
      if (row.startsWith("author ")) meta.author = row.slice(7);
      else if (row.startsWith("author-mail ")) meta.authorMail = row.slice(12);
      else if (row.startsWith("author-time ")) meta.authorTime = parseInt(row.slice(12), 10) || 0;
      else if (row.startsWith("summary ")) meta.summary = row.slice(8);
      i++;
    }
    i++; // skip the TAB-prefixed content line itself

    metaByHash.set(hash, meta);

    lines.push({
      hash,
      author: meta.author,
      authorMail: meta.authorMail,
      authorTime: meta.authorTime,
      summary: meta.summary,
      // git uses an all-zero hash for not-yet-committed local changes.
      isUncommitted: /^0+$/.test(hash),
    });
  }

  return lines;
}
