import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "fs";
import { tmpdir } from "os";
import * as path from "path";
import { GitBlameService } from "./git";

/**
 * Faithful, hermetic simulation of git-crypt: a clean/smudge filter base64-encodes
 * the blob (so git stores whole-file "ciphertext" with a different line count than
 * the plaintext), and a matching diff textconv decodes it. Verifies that blame for
 * such a file is reconstructed from DECRYPTED history with correct per-line commits —
 * i.e. the plugin uses the repo's textconv driver, not the raw ciphertext blob.
 */

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const ENCODE = `process.stdout.write(require("fs").readFileSync(0).toString("base64"));`;
// Idempotent base64 decode: reads the blob from a path arg (textconv) or stdin (smudge)
// and passes through anything that isn't valid base64. This mirrors git-crypt, whose
// smudge AND textconv both decrypt — and `git show --textconv` runs smudge THEN textconv,
// so a non-idempotent decoder would double-decode to garbage.
const IDEM =
  `const fs=require("fs");` +
  `const src=process.argv[2]?fs.readFileSync(process.argv[2],"utf8"):fs.readFileSync(0,"utf8");` +
  `const t=src.trim();let out=src;` +
  `if(t.length>0&&t.length%4===0&&/^[A-Za-z0-9+/=]+$/.test(t)){try{const d=Buffer.from(t,"base64");if(d.toString("base64")===t)out=d.toString();}catch{}}` +
  `process.stdout.write(out);`;

let repo: string;
let secret: string;
let c1: string;
let c2: string;

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), "gitlens-tc-"));
  git(["init", "-q"], repo);
  git(["config", "user.email", "t@e.com"], repo);
  git(["config", "user.name", "T"], repo);
  git(["config", "commit.gpgsign", "false"], repo);

  writeFileSync(path.join(repo, "encode.js"), ENCODE);
  writeFileSync(path.join(repo, "idem.js"), IDEM);
  const idem = `node ${path.join(repo, "idem.js")}`;
  git(["config", "filter.fakecrypt.clean", `node ${path.join(repo, "encode.js")}`], repo);
  git(["config", "filter.fakecrypt.smudge", idem], repo);
  git(["config", "filter.fakecrypt.required", "true"], repo);
  git(["config", "diff.fakecrypt.textconv", idem], repo);
  writeFileSync(path.join(repo, ".gitattributes"), "secret.md filter=fakecrypt diff=fakecrypt\n");

  secret = path.join(repo, "secret.md");
  writeFileSync(secret, "line one\nline two\nline three\n");
  git(["add", "secret.md", ".gitattributes"], repo);
  git(["commit", "-q", "-m", "c1"], repo);
  c1 = git(["rev-parse", "HEAD"], repo);

  writeFileSync(secret, "line one\nline two EDITED\nline three\n");
  git(["commit", "-qam", "c2"], repo);
  c2 = git(["rev-parse", "HEAD"], repo);
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("blameViaTextconv (git-crypt-style encrypted files)", () => {
  it("stores ciphertext but reconstructs decrypted per-line blame", async () => {
    // The committed blob is base64 (one line), not the 3-line plaintext.
    const blob = git(["show", "HEAD:secret.md"], repo);
    expect(blob.split("\n").length).toBe(1);
    expect(blob).not.toContain("line one");

    const r = await new GitBlameService().blame(secret, statSync(secret).mtimeMs);
    expect(r).not.toBeNull();
    expect(r!.unavailableReason).toBeUndefined();
    expect(r!.lines.length).toBeGreaterThanOrEqual(3);
    expect(r!.lines[0].hash).toBe(c1); // "line one" — unchanged since c1
    expect(r!.lines[1].hash).toBe(c2); // "line two EDITED" — changed in c2
    expect(r!.lines[2].hash).toBe(c1); // "line three" — unchanged
    expect(new Set(r!.lines.slice(0, 3).map((l) => l.hash)).size).toBe(2);
  });
});
