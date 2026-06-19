# Git Lens for Obsidian

JetBrains-style per-line **git blame** annotations for your notes. If your vault (or a
folder in it) is a git repository, Git Lens shows, in the editor's left gutter, the commit
that last changed every line — its date, with a **distinct color per commit** so you can see
where one commit's block ends and the next begins.

Click a line's annotation to open the **full commit diff** (`git show`, scoped to that file).

Blame is **off by default** — turn it on per note (ribbon / command / right-click), or
globally in settings.

![concept](docs/concept.png)

## Features

- Per-line blame gutter in editing mode (Live Preview / Source), like JetBrains "Annotate".
- Date per line (relative or absolute) with a **distinct color per commit**, so adjacent
  commits are clearly separated. Color-by-age and no-color modes are also available.
- **Per-note toggle**: show blame for just the current note (ribbon icon, command, or
  right-click) — independent of the global on/off setting, which is **off by default**.
- Click a line → the **commit diff** (`git show <hash> -- <file>`) in a modal, +/- colored.
- **Commit history viewer**: right-click any file or folder in the explorer (or run the
  "Show history for current file" command) to open a master-detail window — commits on the
  left (subject, hash, author, date), the selected commit's diff on the right. Each commit
  row **expands** to list the files it changed (click a file to jump to it in the diff), with
  an **Expand/Collapse all** button, and a **Load more** button to page back through history
  beyond the first 200 commits.
- Works on **git-crypt-encrypted notes** (decrypts history via the repo's textconv driver).
- Locally-modified lines are marked as *uncommitted*.
- Settings: global on/off, date style, show hash, bar color, git executable path.

## Requirements

- **Desktop only.** Git Lens shells out to the `git` binary via Node, which isn't available
  on Obsidian mobile. The plugin no-ops on mobile.
- `git` must be installed and on your `PATH`.
- The note must live inside a git working tree.

## Install (manual / development)

```bash
npm install
npm run build      # type-checks, then bundles src/ -> main.js
```

Then copy `manifest.json`, `main.js`, and `styles.css` into your vault at:

```
<vault>/.obsidian/plugins/git-lens/
```

Enable **Git Lens** under Settings → Community plugins. Use `npm run dev` for a watch build
during development.

## How it works

Obsidian's editor is CodeMirror 6. Git Lens registers a CM6 `gutter()` whose markers come
from a `StateField`. On file open / save it runs `git blame --line-porcelain` for the active
note, parses the output into per-line attribution, and dispatches it into the editor as a
`StateEffect`. Gutter click/`contextmenu` handlers open the commit popup.

See `src/`:

| File | Responsibility |
| --- | --- |
| `git.ts` | Run & parse `git blame` / `git show` / `git log`; cache by path+mtime |
| `blameExtension.ts` | CM6 state fields, gutter, markers, event handling |
| `diff.ts` | Single-commit diff modal + file/folder commit-history viewer |
| `settings.ts` | Settings tab |
| `main.ts` | Plugin lifecycle, events, commands |

## Testing

```bash
npm test                    # vitest: blame parser + real-git integration
npm run deploy -- <vault>   # build + install/enable git-lens into a vault (default: web-clipper)
npm run e2e                 # automated end-to-end check in REAL Obsidian
```

### Automated E2E (`npm run e2e`)

`scripts/e2e-obsidian.mjs` drives real Obsidian over the Chrome DevTools Protocol to
verify the live gutter — the thing unit tests can't see. It:

1. builds and installs the plugin into the **web-clipper** vault (and enables it),
2. **quits and relaunches Obsidian** with `--remote-debugging-port=9222`,
3. connects with `puppeteer-core`, opens a non-encrypted multi-commit note in editing mode,
4. asserts via the plugin's `getBlameStats()`: every blamed line has a marker, blame covers
   the document, `distinctCommits > 1`, and clicking the gutter opens a **single-file** diff,
5. writes screenshots to `scripts/e2e-out/` and exits non-zero on any failure.

Prereqs: desktop Obsidian installed, the target vault already trusted with community plugins
enabled. Note: this **closes your running Obsidian** and reopens it with a debug port.

## Encrypted notes (git-crypt)

Files behind an encrypting clean/smudge filter (git-crypt) store only whole-file
ciphertext in git, so plain `git blame` is meaningless. Git Lens still blames them by
**decrypting each historical version** through the repo's `diff.<driver>.textconv` driver
(the one git-crypt writes into `.git/config`) and attributing lines incrementally with an
LCS diff. Caveats:

- First open of a heavily-committed encrypted note is slow (it decrypts every revision —
  e.g. ~30s for a 300-commit note). The decrypted history is then cached by the file's HEAD
  commit, so editing/saving stays fast (~0.2s) and only a *new* commit triggers a re-decrypt.
- Falls back to no gutter if the repo is locked / textconv can't decrypt, or for files with
  more than 1000 revisions or 2000 lines.

## Known limitations

- Editing mode only (reading mode has no gutter — matching how code editors annotate).
- While you have unsaved edits, annotations may be momentarily stale; they re-compute on save.
- Desktop only; no mobile / in-browser git yet.

## License

MIT
