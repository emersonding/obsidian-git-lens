import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { GitBlameService, parseLog } from "./git";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

let repo: string;
let dir: string;
let fileA: string;

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), "gitlens-hist-"));
  git(["init", "-q"], repo);
  git(["config", "user.email", "t@e.com"], repo);
  git(["config", "user.name", "T"], repo);
  git(["config", "commit.gpgsign", "false"], repo);

  dir = path.join(repo, "notes");
  mkdirSync(dir);
  fileA = path.join(dir, "a.md");
  const fileB = path.join(dir, "b.md");
  const outside = path.join(repo, "outside.md");

  // c1: create a.md
  writeFileSync(fileA, "v1\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "add a"], repo);

  // c2: create b.md (touches the dir but not a.md)
  writeFileSync(fileB, "b1\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "add b"], repo);

  // c3: edit a.md
  writeFileSync(fileA, "v1\nv2\n");
  git(["commit", "-qam", "edit a"], repo);

  // c4: a commit that does NOT touch notes/ at all
  writeFileSync(outside, "x\n");
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "outside"], repo);
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("GitBlameService.log", () => {
  it("lists only commits touching a file, newest first", async () => {
    const svc = new GitBlameService();
    const commits = await svc.log(fileA, false);
    expect(commits).not.toBeNull();
    expect(commits!.map((c) => c.summary)).toEqual(["edit a", "add a"]);
    expect(commits![0].author).toBe("T");
    expect(commits![0].authorTime).toBeGreaterThan(0);
  });

  it("lists every commit touching a directory", async () => {
    const svc = new GitBlameService();
    const commits = await svc.log(dir, true);
    expect(commits!.map((c) => c.summary)).toEqual(["edit a", "add b", "add a"]);
  });

  it("attaches the changed files (within the path) to each commit", async () => {
    const svc = new GitBlameService();
    const commits = await svc.log(dir, true);
    const byMsg = Object.fromEntries(commits!.map((c) => [c.summary, c]));
    expect(byMsg["add b"].files).toEqual([{ status: "A", path: "notes/b.md" }]);
    expect(byMsg["edit a"].files).toEqual([{ status: "M", path: "notes/a.md" }]);
  });

  it("pages through history with skip", async () => {
    const svc = new GitBlameService();
    const page1 = await svc.log(dir, true, 2, 0);
    const page2 = await svc.log(dir, true, 2, 2);
    expect(page1!.map((c) => c.summary)).toEqual(["edit a", "add b"]);
    expect(page2!.map((c) => c.summary)).toEqual(["add a"]);
  });

  it("returns null outside a git repo", async () => {
    const svc = new GitBlameService();
    const tmp = mkdtempSync(path.join(tmpdir(), "gitlens-norepo-"));
    try {
      expect(await svc.log(tmp, true)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("GitBlameService.showPath", () => {
  it("shows a single file's diff for a commit", async () => {
    const svc = new GitBlameService();
    const commits = await svc.log(fileA, false);
    const diff = await svc.showPath(fileA, false, commits![0].hash);
    expect(diff).toContain("a.md");
    expect(diff).toContain("+v2");
  });

  it("shows all files under a directory for a commit", async () => {
    const svc = new GitBlameService();
    const commits = await svc.log(dir, true);
    const addB = commits!.find((c) => c.summary === "add b")!;
    const diff = await svc.showPath(dir, true, addB.hash);
    expect(diff).toContain("b.md");
  });
});

describe("parseLog", () => {
  // RS (\x1e) introduces each commit; US (\x1f) separates the metadata fields;
  // TAB-separated name-status lines follow.
  const rec = (meta: string, ...status: string[]) =>
    "\x1e" + meta + (status.length ? "\n\n" + status.join("\n") : "") + "\n";

  it("parses a commit's metadata and changed files", () => {
    const out = rec("abc123\x1fAda\x1fada@x.com\x1f1700000000\x1fHello world", "M\tnotes/a.md", "A\tnotes/b.md");
    const [c] = parseLog(out);
    expect(c).toEqual({
      hash: "abc123",
      author: "Ada",
      authorMail: "<ada@x.com>",
      authorTime: 1700000000,
      summary: "Hello world",
      files: [
        { status: "M", path: "notes/a.md" },
        { status: "A", path: "notes/b.md" },
      ],
    });
  });

  it("parses rename name-status into old + new paths", () => {
    const [c] = parseLog(rec("h\x1fA\x1fa@x\x1f1\x1frename", "R100\told.md\tnew.md"));
    expect(c.files).toEqual([{ status: "R", oldPath: "old.md", path: "new.md" }]);
  });

  it("handles a commit with no files in the queried path", () => {
    const [c] = parseLog(rec("h\x1fA\x1fa@x\x1f1\x1fmsg"));
    expect(c.files).toEqual([]);
  });

  it("parses multiple commits", () => {
    const out = rec("h1\x1fA\x1fa@x\x1f1\x1ffirst", "M\tx") + rec("h2\x1fB\x1fb@x\x1f2\x1fsecond", "A\ty");
    const commits = parseLog(out);
    expect(commits.map((c) => c.hash)).toEqual(["h1", "h2"]);
    expect(commits[1].files).toEqual([{ status: "A", path: "y" }]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseLog("")).toEqual([]);
  });
});
