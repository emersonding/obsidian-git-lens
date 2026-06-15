import puppeteer from "puppeteer-core";
import { execFileSync, execSync, spawn } from "child_process";
import { mkdirSync, realpathSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { deploy } from "./deploy.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const VAULT = process.env.GITLENS_VAULT || "/Users/emerson/Documents/git/web-clipper";
const PORT = Number(process.env.GITLENS_CDP_PORT || 9222);
const OBSIDIAN_BIN = "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
const OUT = join(HERE, "e2e-out");
const PLUGIN_ID = "git-lens";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts });
const realOr = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** First tracked `*.md` that is NOT behind an encrypting filter and has >=3 commits. */
function discoverNote() {
  const files = sh("git", ["-C", VAULT, "ls-files", "-z", "*.md"]).split("\0").filter(Boolean);
  for (const f of files) {
    let filt;
    try {
      filt = sh("git", ["-C", VAULT, "check-attr", "filter", "--", f]).trim();
    } catch {
      continue;
    }
    if (!/: filter: unspecified$/.test(filt)) continue; // skip git-crypt etc.
    let commits = 0;
    try {
      commits = sh("git", ["-C", VAULT, "log", "--oneline", "--", f]).split("\n").filter(Boolean).length;
    } catch {
      continue;
    }
    if (commits >= 3) return f;
  }
  throw new Error("no non-encrypted multi-commit .md note found in the vault");
}

function obsidianRunning() {
  try {
    execSync("pgrep -x Obsidian", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function quitObsidian() {
  if (!obsidianRunning()) return;
  console.log("[e2e] quitting Obsidian…");
  try {
    execSync(`osascript -e 'quit app "Obsidian"'`);
  } catch {}
  for (let i = 0; i < 40 && obsidianRunning(); i++) await sleep(500);
  if (obsidianRunning()) {
    try {
      execSync("pkill -x Obsidian");
    } catch {}
    await sleep(2000);
  }
}

async function waitForCDP(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch {}
    await sleep(500);
  }
  throw new Error(
    `CDP endpoint never came up on :${PORT} — does this Obsidian build accept --remote-debugging-port?`,
  );
}

async function findVaultPage(browser) {
  const want = realOr(VAULT);
  for (let attempt = 0; attempt < 60; attempt++) {
    for (const p of await browser.pages()) {
      try {
        const base = await p.evaluate(
          () => window.app?.vault?.adapter?.getBasePath?.() ?? window.app?.vault?.adapter?.basePath ?? null,
        );
        if (base && realOr(base) === want) return p;
      } catch {}
    }
    await sleep(500);
  }
  throw new Error(`could not find an Obsidian window for vault ${VAULT}`);
}

async function pollStats(page, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.evaluate(
      (id) => window.app.plugins.plugins[id]?.getBlameStats?.() ?? null,
      PLUGIN_ID,
    );
    if (last && predicate(last)) return last;
    await sleep(500);
  }
  return last;
}

async function main() {
  console.log(`[e2e] vault: ${VAULT}`);
  const note = discoverNote();
  console.log(`[e2e] test note: ${note}`);

  // Build while Obsidian is still up, then quit and install (so Obsidian doesn't
  // clobber community-plugins.json on exit), then relaunch with the debug port.
  execFileSync("npm", ["run", "build"], { cwd: resolve(HERE, ".."), stdio: "inherit" });
  await quitObsidian();
  const { version } = deploy(VAULT, { build: false });

  console.log(`[e2e] launching Obsidian v? with git-lens v${version} on port ${PORT}…`);
  spawn(OBSIDIAN_BIN, [`--remote-debugging-port=${PORT}`], { detached: true, stdio: "ignore" }).unref();
  await waitForCDP();

  const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
  const checks = [];
  const check = (name, pass, detail = "") => checks.push({ name, pass: !!pass, detail });

  try {
    const page = await findVaultPage(browser);

    // Make sure the plugin is loaded/enabled.
    await page.evaluate(async (id) => {
      if (!window.app.plugins.plugins[id]) await window.app.plugins.enablePlugin(id);
    }, PLUGIN_ID);
    await pollStats(page, () => true, 1000); // let it settle

    // Open the note in editing (source) mode — the gutter is editor-only.
    // Handle NFC/NFD path mismatches (git vs Obsidian's index) and a not-yet-ready vault.
    const opened = await page.evaluate(async (notePath) => {
      const app = window.app;
      for (let i = 0; i < 80 && app.vault.getMarkdownFiles().length === 0; i++) {
        await new Promise((r) => setTimeout(r, 250));
      }
      const want = notePath.normalize("NFC");
      let file =
        app.vault.getAbstractFileByPath(want) ||
        app.vault.getAbstractFileByPath(notePath) ||
        app.vault.getMarkdownFiles().find((f) => f.path.normalize("NFC") === want) ||
        null;
      if (!file) {
        return { ok: false, count: app.vault.getMarkdownFiles().length, sample: app.vault.getMarkdownFiles().slice(0, 3).map((f) => f.path) };
      }
      await app.workspace.getLeaf(false).openFile(file, { active: true, state: { mode: "source" } });
      return { ok: true, path: file.path };
    }, note);
    if (!opened.ok) {
      throw new Error(`note not found: ${note} (vault has ${opened.count} md files, e.g. ${JSON.stringify(opened.sample)})`);
    }

    const stats = await pollStats(page, (s) => s.markers != null && s.markers > 0, 25000);
    if (!stats) throw new Error("blame never produced markers (getBlameStats stayed empty)");
    console.log("[e2e] stats:", JSON.stringify(stats));

    // Allow 1-line slack: CM counts the empty line after a trailing newline, git blame omits it.
    const covered = stats.blameLines != null && stats.docLines != null && stats.blameLines >= stats.docLines - 1;
    check("every blamed line has a marker", stats.markers === stats.blameLines, `markers=${stats.markers} blame=${stats.blameLines}`);
    check("blame covers the document", covered, `blame=${stats.blameLines} doc=${stats.docLines}`);
    check("distinctCommits > 1", (stats.distinctCommits ?? 0) > 1, `distinct=${stats.distinctCommits}`);
    check("not unavailable", !stats.unavailableReason, stats.unavailableReason || "");

    const annot = await page.evaluate(() => document.querySelectorAll(".git-lens-annot").length);
    check("gutter annotations render", annot > 0, `.git-lens-annot=${annot}`);

    mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: join(OUT, "gutter.png") });

    // Click a gutter annotation → diff modal (A1), scoped to one file (A3).
    // Dispatch a synthetic mousedown at the element's coords (what CM's gutter
    // handler listens for) — puppeteer's geometric click can't hit the thin gutter.
    const clicked = await page.evaluate(() => {
      const el = document.querySelector(".git-lens-annot");
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, clientX: r.left + 3, clientY: r.top + 3, button: 0 };
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      return true;
    });
    let diff = null;
    if (clicked) {
      try {
        await page.waitForSelector(".git-lens-diff", { timeout: 6000 });
        diff = await page.evaluate(() => {
          const text = document.querySelector(".git-lens-diff")?.textContent || "";
          return { fileCount: (text.match(/diff --git /g) || []).length };
        });
        await page.screenshot({ path: join(OUT, "diff.png") });
      } catch {
        diff = null;
      }
    }
    check("click opens diff modal (A1)", !!diff, diff ? "modal shown" : "no .git-lens-diff modal");
    check("diff scoped to one file (A3)", diff && diff.fileCount === 1, diff ? `diff --git x${diff.fileCount}` : "n/a");
  } finally {
    await browser.disconnect();
  }

  console.log("\n=== Git Lens E2E (web-clipper) ===");
  for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}  (${c.detail})`);
  console.log(`screenshots: ${OUT}`);
  const ok = checks.every((c) => c.pass);
  console.log(ok ? "\n✅ E2E PASSED" : "\n❌ E2E FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("\n❌ E2E ERROR:", err.message);
  process.exit(1);
});
