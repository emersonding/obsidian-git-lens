import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { GitBlameService } from "./git";

/**
 * End-to-end test against a real `git` binary in a throwaway repo. Validates the
 * full blame pipeline (run + porcelain parse) the way the plugin uses it.
 */

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

let repo: string;
let filePath: string;
let firstHash: string;

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), "gitlens-it-"));
  git(["init", "-q"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "Test User"], repo);
  git(["config", "commit.gpgsign", "false"], repo);

  filePath = path.join(repo, "note.md");
  writeFileSync(filePath, "# Title\nFirst body line\n");
  git(["add", "note.md"], repo);
  git(["commit", "-q", "-m", "Initial commit"], repo);
  firstHash = git(["rev-parse", "HEAD"], repo);

  // Append a third line and leave it uncommitted.
  writeFileSync(filePath, "# Title\nFirst body line\nUncommitted line\n");
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("GitBlameService (real git)", () => {
  it("blames committed lines and flags uncommitted ones", async () => {
    const svc = new GitBlameService();
    const result = await svc.blame(filePath, statSync(filePath).mtimeMs);

    expect(result).not.toBeNull();
    expect(result!.repoRoot).toBe(git(["rev-parse", "--show-toplevel"], repo));
    expect(result!.lines).toHaveLength(3);

    const [title, body, extra] = result!.lines;
    expect(title.hash).toBe(firstHash);
    expect(title.author).toBe("Test User");
    expect(title.summary).toBe("Initial commit");
    expect(title.isUncommitted).toBe(false);
    expect(body.hash).toBe(firstHash);
    expect(extra.isUncommitted).toBe(true);
  });

  it("caches by mtime and serves the same object", async () => {
    const svc = new GitBlameService();
    const mtime = statSync(filePath).mtimeMs;
    const a = await svc.blame(filePath, mtime);
    const b = await svc.blame(filePath, mtime);
    expect(a).toBe(b); // same cached reference
  });

  it("returns the full commit diff via show()", async () => {
    const svc = new GitBlameService();
    const root = git(["rev-parse", "--show-toplevel"], repo);
    const diff = await svc.show(root, firstHash);
    expect(diff).toContain("Initial commit");
    expect(diff).toContain("+# Title");
  });

  it("returns null outside a git repo", async () => {
    const svc = new GitBlameService();
    const noRepo = mkdtempSync(path.join(tmpdir(), "gitlens-norepo-"));
    const f = path.join(noRepo, "x.md");
    writeFileSync(f, "hello\n");
    try {
      expect(await svc.blame(f, statSync(f).mtimeMs)).toBeNull();
    } finally {
      rmSync(noRepo, { recursive: true, force: true });
    }
  });
});
