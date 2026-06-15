import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { GitBlameService } from "./git";

/**
 * Files run through an encrypting clean/smudge filter (git-crypt) store only
 * ciphertext in git, so per-line blame of the plaintext is impossible. We detect
 * the filter via `git check-attr` and report blame as unavailable instead of
 * showing misleading attributions. This reproduces that with a `.gitattributes`
 * filter assignment (no git-crypt binary required).
 */

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "gitlens-enc-"));
  git(["init", "-q"], repo);
  git(["config", "user.email", "t@e.com"], repo);
  git(["config", "user.name", "T"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  return repo;
}

describe("GitBlameService encrypted files", () => {
  it("reports blame unavailable for files behind a git-crypt filter", async () => {
    const repo = initRepo();
    try {
      // A local passthrough filter whose name matches /crypt/i — hermetic, so we
      // don't invoke a real (and possibly locked) git-crypt binary on commit.
      git(["config", "filter.cryptdummy.clean", "cat"], repo);
      git(["config", "filter.cryptdummy.smudge", "cat"], repo);
      writeFileSync(path.join(repo, ".gitattributes"), "secret.md filter=cryptdummy diff=cryptdummy\n");
      const f = path.join(repo, "secret.md");
      writeFileSync(f, "top secret\nmore secret\n");
      git(["add", "."], repo);
      git(["commit", "-q", "-m", "init"], repo);

      const r = await new GitBlameService().blame(f, statSync(f).mtimeMs);
      expect(r).not.toBeNull();
      expect(r!.lines).toHaveLength(0);
      expect(r!.unavailableReason).toMatch(/encrypted/i);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("blames normally when no encrypting filter applies", async () => {
    const repo = initRepo();
    try {
      const f = path.join(repo, "note.md");
      writeFileSync(f, "a\nb\nc\n");
      git(["add", "."], repo);
      git(["commit", "-q", "-m", "init"], repo);

      const r = await new GitBlameService().blame(f, statSync(f).mtimeMs);
      expect(r!.unavailableReason).toBeUndefined();
      expect(r!.lines).toHaveLength(3);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
