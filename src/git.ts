import { execFile } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import * as path from "path";
import { BlameLine, BlameResult, ZERO_HASH } from "./types";

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
  private textconvCache = new Map<string, TextconvCacheEntry>();

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

  /**
   * If the file is run through an encrypting clean/smudge filter (git-crypt &
   * friends), return the filter name. Blame is meaningless for such files since
   * git stores ciphertext, not the plaintext you see.
   */
  async encryptedFilter(absFile: string): Promise<string | null> {
    try {
      const out = await this.run(path.dirname(absFile), [
        "check-attr",
        "filter",
        "--",
        path.basename(absFile),
      ]);
      // Output: "<file>: filter: <value>"
      const value = /: filter: (.+)$/m.exec(out.trim())?.[1]?.trim();
      return value && /crypt/i.test(value) ? value : null;
    } catch {
      return null;
    }
  }

  invalidate(absFile: string): void {
    this.cache.delete(absFile);
  }

  clear(): void {
    this.cache.clear();
    this.textconvCache.clear();
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
        const crypt = await this.encryptedFilter(absFile);
        if (crypt) {
          // git stores only whole-file ciphertext, so plain blame is meaningless.
          // Reconstruct per-line blame from decrypted history via the repo's
          // textconv driver (diff.<driver>.textconv in .git/config, set by git-crypt).
          const decrypted = await this.blameViaTextconv(absFile);
          result = decrypted
            ? { repoRoot, absFile, lines: decrypted }
            : { repoRoot, absFile, lines: [], unavailableReason: `encrypted (${crypt})` };
        } else {
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

  /**
   * Per-line blame for an encrypted file (git-crypt etc.): decrypt every
   * historical version through the repo's textconv driver and attribute lines
   * incrementally. Returns null when decryption isn't available or the file has
   * too many revisions / lines to reconstruct cheaply.
   */
  async blameViaTextconv(absFile: string): Promise<BlameLine[] | null> {
    const dir = path.dirname(absFile);
    const base = path.basename(absFile);

    // The decrypted committed history only changes when a new commit touches the
    // file, so cache it keyed by the file's newest commit hash. Local edits then
    // cost only one diff of the working tree against the cached newest version,
    // instead of re-decrypting every revision on every save.
    let head: string;
    try {
      head = (await this.run(dir, ["log", "-1", "--format=%H", "--", base])).trim();
    } catch {
      return null;
    }
    if (!head) return null;

    let entry = this.textconvCache.get(absFile);
    if (!entry || entry.head !== head) {
      const built = await this.buildTextconvHistory(dir, base, head);
      if (!built) return null;
      entry = built;
      this.textconvCache.set(absFile, entry);
    }

    // Map the cached committed blame onto the current decrypted working-tree content.
    let finalLines: string[];
    try {
      finalLines = splitLines(await readFile(absFile, "utf8"));
    } catch {
      finalLines = entry.committedLines;
    }
    const blameHashes = applyWorkingTree(entry.committedLines, entry.committedBlame, finalLines);

    return blameHashes.map((hash) => {
      const isUncommitted = /^0+$/.test(hash);
      const m = entry!.meta.get(hash);
      return {
        hash: isUncommitted ? ZERO_HASH : hash,
        author: isUncommitted ? "" : m?.author ?? "",
        authorMail: isUncommitted ? "" : m?.authorMail ?? "",
        authorTime: isUncommitted ? 0 : m?.authorTime ?? 0,
        summary: isUncommitted ? "" : m?.summary ?? "",
        isUncommitted,
      };
    });
  }

  /** Decrypt every revision of a file and blame its newest committed version. */
  private async buildTextconvHistory(
    dir: string,
    base: string,
    head: string,
  ): Promise<TextconvCacheEntry | null> {
    let hashes: string[];
    try {
      const log = await this.run(dir, ["log", "--format=%H", "--reverse", "--", base]);
      hashes = log.split("\n").map((s) => s.trim()).filter(Boolean);
    } catch {
      return null;
    }
    if (hashes.length === 0 || hashes.length > MAX_DECRYPT_REVISIONS) return null;

    const versions: TextconvVersion[] = [];
    for (const hash of hashes) {
      let content: string;
      try {
        content = await this.run(dir, ["show", "--textconv", `${hash}:./${base}`]);
      } catch {
        continue; // file absent in this commit (e.g. a deletion)
      }
      if (looksEncrypted(content)) return null; // textconv didn't decrypt
      const lines = splitLines(content);
      if (lines.length > MAX_DECRYPT_LINES) return null;
      versions.push({ hash, lines });
    }
    if (versions.length === 0) return null;

    return {
      head,
      committedLines: versions[versions.length - 1].lines,
      committedBlame: committedBlame(versions),
      meta: await this.commitMeta(dir, base),
    };
  }

  /** Map of commit hash -> author/date/summary for every commit touching a file. */
  private async commitMeta(dir: string, base: string): Promise<Map<string, CommitMeta>> {
    const map = new Map<string, CommitMeta>();
    let out: string;
    try {
      out = await this.run(dir, ["log", "--format=%H%x1f%an%x1f%ae%x1f%at%x1f%s", "--", base]);
    } catch {
      return map;
    }
    for (const line of out.split("\n")) {
      if (!line) continue;
      const [hash, author, mail, at, ...rest] = line.split("\x1f");
      map.set(hash, {
        author: author ?? "",
        authorMail: mail ? `<${mail}>` : "",
        authorTime: parseInt(at ?? "", 10) || 0,
        summary: rest.join("\x1f"),
      });
    }
    return map;
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

/** Caps that keep decryption-aware blame from being pathologically slow. The
 *  per-revision decryption only runs when the file's HEAD changes (see the textconv
 *  cache), so a high revision cap is affordable — local edits never re-decrypt. */
const MAX_DECRYPT_REVISIONS = 1000;
const MAX_DECRYPT_LINES = 2000;

interface TextconvVersion {
  hash: string;
  lines: string[];
}

interface TextconvCacheEntry {
  head: string;
  committedLines: string[];
  committedBlame: string[];
  meta: Map<string, CommitMeta>;
}

/** Split like CodeMirror counts lines: a trailing "\n" yields a final empty line. */
function splitLines(content: string): string[] {
  return content.split("\n");
}

/** True if textconv handed back git-crypt ciphertext (i.e. it didn't decrypt). */
function looksEncrypted(content: string): boolean {
  return content.slice(0, 64).includes("GITCRYPT");
}

/**
 * Align `cur` lines to `prev` lines via an LCS. Returns an array parallel to
 * `cur`: each entry is the index of the matching (unchanged) line in `prev`, or
 * -1 if the line is new/changed.
 */
function alignLines(prev: string[], cur: string[]): Int32Array {
  const n = prev.length;
  const m = cur.length;
  const match = new Int32Array(m).fill(-1);
  if (n === 0 || m === 0) return match;

  // dp[i][j] = length of the LCS of prev[i:] and cur[j:].
  const dp: Int32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i];
    const next = dp[i + 1];
    const pi = prev[i];
    for (let j = m - 1; j >= 0; j--) {
      row[j] = pi === cur[j] ? next[j + 1] + 1 : next[j] >= row[j + 1] ? next[j] : row[j + 1];
    }
  }

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (prev[i] === cur[j]) {
      match[j] = i;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return match;
}

/** Incremental blame for the NEWEST committed version (no working-tree step). */
function committedBlame(versions: { hash: string; lines: string[] }[]): string[] {
  if (versions.length === 0) return [];
  let blame = versions[0].lines.map(() => versions[0].hash);
  for (let k = 1; k < versions.length; k++) {
    const match = alignLines(versions[k - 1].lines, versions[k].lines);
    const prev = blame;
    blame = versions[k].lines.map((_, j) => (match[j] >= 0 ? prev[match[j]] : versions[k].hash));
  }
  return blame;
}

/** Map committed blame onto the current working-tree content; new lines are uncommitted. */
function applyWorkingTree(committedLines: string[], blame: string[], finalLines: string[]): string[] {
  const ZERO = "0".repeat(40);
  const match = alignLines(committedLines, finalLines);
  return finalLines.map((_, j) => (match[j] >= 0 ? blame[match[j]] : ZERO));
}

/**
 * Walk decrypted versions oldest -> newest and attribute each line of the final
 * (working-tree) content to the commit that last introduced it. Lines absent from
 * the newest committed version are "uncommitted" (all-zero hash). Exported for tests.
 */
export function computeIncrementalBlame(
  versions: { hash: string; lines: string[] }[],
  finalLines: string[],
): string[] {
  if (versions.length === 0) return finalLines.map(() => "0".repeat(40));
  return applyWorkingTree(versions[versions.length - 1].lines, committedBlame(versions), finalLines);
}
