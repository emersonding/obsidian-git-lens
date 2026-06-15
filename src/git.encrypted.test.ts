import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { GitBlameService } from "./git";

/**
 * Fallback behavior: when a file is behind an encrypting filter (git-crypt) but its
 * content can't be decrypted for blame (locked repo / no working textconv), the
 * plugin must report blame as unavailable rather than blaming ciphertext. And files
 * with no encrypting filter blame normally. (The decrypt-and-blame success path is
 * covered in git.textconv.test.ts.)
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
  it("reports blame unavailable when the file stays encrypted (no working textconv)", async () => {
    const repo = initRepo();
    try {
      // clean filter prefixes the git-crypt magic so the stored blob looks encrypted;
      // with no diff textconv configured, `git show --textconv` returns it as-is.
      writeFileSync(
        path.join(repo, "enc.js"),
        `process.stdout.write("\\0GITCRYPT\\0" + require("fs").readFileSync(0).toString("base64"));`,
      );
      git(["config", "filter.cryptlocked.clean", `node ${path.join(repo, "enc.js")}`], repo);
      writeFileSync(path.join(repo, ".gitattributes"), "secret.md filter=cryptlocked\n");
      const f = path.join(repo, "secret.md");
      writeFileSync(f, "top secret\nmore secret\n");
      git(["add", "secret.md", ".gitattributes"], repo);
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
