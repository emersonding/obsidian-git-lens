import { execFileSync } from "child_process";
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ID = "git-lens";
const DEFAULT_VAULT = "/Users/emerson/Documents/git/web-clipper";
const FILES = ["manifest.json", "main.js", "styles.css"];

/**
 * Build (optional) and install the plugin into a vault's plugin folder, and make
 * sure it's enabled. Returns { dest, version }.
 */
export function deploy(vault = DEFAULT_VAULT, { build = true } = {}) {
  vault = vault.replace(/^~(?=$|\/)/, homedir()); // expand a literal leading ~
  if (build) {
    console.log("[deploy] npm run build…");
    execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
  }

  const dest = join(vault, ".obsidian", "plugins", PLUGIN_ID);
  mkdirSync(dest, { recursive: true });
  for (const f of FILES) copyFileSync(join(ROOT, f), join(dest, f));

  // Enable the plugin (community-plugins.json is a JSON array of plugin ids).
  const cpPath = join(vault, ".obsidian", "community-plugins.json");
  let enabled = [];
  if (existsSync(cpPath)) {
    try {
      enabled = JSON.parse(readFileSync(cpPath, "utf8"));
    } catch {
      enabled = [];
    }
  }
  if (!enabled.includes(PLUGIN_ID)) {
    enabled.push(PLUGIN_ID);
    writeFileSync(cpPath, JSON.stringify(enabled, null, 2) + "\n");
    console.log(`[deploy] enabled ${PLUGIN_ID} in community-plugins.json`);
  }

  const version = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8")).version;
  console.log(`[deploy] git-lens v${version} -> ${dest}`);
  return { dest, version };
}

// CLI: node scripts/deploy.mjs [vaultPath]
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  deploy(process.argv[2] || DEFAULT_VAULT);
}
