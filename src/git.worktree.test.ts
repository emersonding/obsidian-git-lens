import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { GitBlameService, parseStatus } from "./git";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("parseStatus", () => {
  it("prefers the worktree status and reports paths repo-root-relative", () => {
    expect(parseStatus(" M notes/a.md\n")).toEqual([{ status: "M", path: "notes/a.md" }]);
  });

  it("falls back to the index status when the worktree column is blank", () => {
    // A staged-but-unmodified addition: index "A", worktree " ".
    expect(parseStatus("A  notes/new.md\n")).toEqual([{ status: "A", path: "notes/new.md" }]);
  });

  it("surfaces untracked files as added", () => {
    expect(parseStatus("?? notes/fresh.md\n")).toEqual([{ status: "A", path: "notes/fresh.md" }]);
  });

  it("parses renames into old + new paths", () => {
    expect(parseStatus("R  notes/old.md -> notes/new.md\n")).toEqual([
      { status: "R", path: "notes/new.md", oldPath: "notes/old.md" },
    ]);
  });

  it("ignores blank lines", () => {
    expect(parseStatus("\n M a\n\n")).toEqual([{ status: "M", path: "a" }]);
  });
});

describe("GitBlameService working-tree diff", () => {
  let repo: string;
  let dir: string;
  let fileA: string;

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), "gitlens-wt-"));
    git(["init", "-q"], repo);
    git(["config", "user.email", "t@e.com"], repo);
    git(["config", "user.name", "T"], repo);
    git(["config", "commit.gpgsign", "false"], repo);

    dir = path.join(repo, "notes");
    mkdirSync(dir);
    fileA = path.join(dir, "a.md");
    writeFileSync(fileA, "v1\n");
    writeFileSync(path.join(repo, "outside.md"), "x\n");
    git(["add", "."], repo);
    git(["commit", "-q", "-m", "init"], repo);
  });

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it("returns an empty list when the scope is clean", async () => {
    const svc = new GitBlameService();
    expect(await svc.statusFiles(dir, true)).toEqual([]);
  });

  it("returns null outside a git repo", async () => {
    const svc = new GitBlameService();
    const tmp = mkdtempSync(path.join(tmpdir(), "gitlens-norepo-"));
    try {
      expect(await svc.statusFiles(tmp, true)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("lists a modified tracked file and diffs it against HEAD", async () => {
    const svc = new GitBlameService();
    writeFileSync(fileA, "v1\nv2\n");

    expect(await svc.statusFiles(fileA, false)).toEqual([{ status: "M", path: "notes/a.md" }]);
    const diff = await svc.diffWorkingTree(fileA, false);
    expect(diff).toContain("notes/a.md");
    expect(diff).toContain("+v2");
  });

  it("includes untracked files (diffed against /dev/null)", async () => {
    const svc = new GitBlameService();
    writeFileSync(path.join(dir, "fresh.md"), "brand new\n");

    expect(await svc.statusFiles(dir, true)).toEqual([{ status: "A", path: "notes/fresh.md" }]);
    const diff = await svc.diffWorkingTree(dir, true);
    expect(diff).toContain("notes/fresh.md");
    expect(diff).toContain("+brand new");
  });

  it("scopes changes to the queried directory only", async () => {
    const svc = new GitBlameService();
    writeFileSync(fileA, "v1\nedit\n");
    writeFileSync(path.join(repo, "outside.md"), "x\nchanged\n");

    const files = await svc.statusFiles(dir, true);
    expect(files).toEqual([{ status: "M", path: "notes/a.md" }]);
    const diff = await svc.diffWorkingTree(dir, true);
    expect(diff).toContain("notes/a.md");
    expect(diff).not.toContain("outside.md");
  });

  it("combines tracked edits and untracked files in one diff", async () => {
    const svc = new GitBlameService();
    writeFileSync(fileA, "v1\nv2\n");
    writeFileSync(path.join(dir, "fresh.md"), "new file\n");

    const files = await svc.statusFiles(dir, true);
    expect(files).toEqual([
      { status: "M", path: "notes/a.md" },
      { status: "A", path: "notes/fresh.md" },
    ]);
    const diff = await svc.diffWorkingTree(dir, true);
    expect(diff).toContain("+v2");
    expect(diff).toContain("+new file");
  });
});
