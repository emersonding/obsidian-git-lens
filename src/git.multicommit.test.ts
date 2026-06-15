import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { GitBlameService } from "./git";

/**
 * Regression test for two reported bugs:
 *  1. blame only covered the first ~200 lines of a long file;
 *  2. every line showed the same (latest) commit instead of the per-line commit.
 * Builds a 600-line file across three commits touching different line ranges.
 */

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

let repo: string;
let file: string;
let c1: string;
let c2: string;
let c3: string;

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), "gitlens-multi-"));
  git(["init", "-q"], repo);
  git(["config", "user.email", "t@e.com"], repo);
  git(["config", "user.name", "T"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  file = path.join(repo, "big.md");

  // commit 1: 300 lines.
  writeFileSync(file, Array.from({ length: 300 }, (_, i) => `line ${i + 1} v1`).join("\n") + "\n");
  git(["add", "big.md"], repo);
  git(["commit", "-q", "-m", "c1"], repo);
  c1 = git(["rev-parse", "HEAD"], repo);

  // commit 2: rewrite lines 100..150.
  const arr = readFileSync(file, "utf8").split("\n");
  for (let i = 99; i < 150; i++) arr[i] = `line ${i + 1} v2`;
  writeFileSync(file, arr.join("\n"));
  git(["commit", "-qam", "c2"], repo);
  c2 = git(["rev-parse", "HEAD"], repo);

  // commit 3: append 300 more lines (total 600).
  const more = Array.from({ length: 300 }, (_, i) => `line ${i + 301} v3`).join("\n");
  writeFileSync(file, readFileSync(file, "utf8").replace(/\n$/, "") + "\n" + more + "\n");
  git(["commit", "-qam", "c3"], repo);
  c3 = git(["rev-parse", "HEAD"], repo);
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("GitBlameService large multi-commit", () => {
  it("blames EVERY line, not just the first screenful", async () => {
    const svc = new GitBlameService();
    const r = await svc.blame(file, statSync(file).mtimeMs);
    expect(r).not.toBeNull();
    expect(r!.lines.length).toBe(600);
  });

  it("attributes each line to the commit that last changed it", async () => {
    const svc = new GitBlameService();
    const r = await svc.blame(file, statSync(file).mtimeMs);
    expect(r!.lines[0].hash).toBe(c1); // line 1 untouched since c1
    expect(r!.lines[120].hash).toBe(c2); // line 121 rewritten in c2
    expect(r!.lines[400].hash).toBe(c3); // line 401 added in c3
    expect(new Set(r!.lines.map((l) => l.hash)).size).toBeGreaterThanOrEqual(3);
  });
});
