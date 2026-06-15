# Git Lens for Obsidian

JetBrains-style per-line **git blame** annotations for your notes. If your vault (or a
folder in it) is a git repository, Git Lens shows, in the editor's left gutter, the commit
that last changed every line — short hash, author date, and an age-based color bar.

Click or **right-click** a line to open a popup with the full commit details, and from there
**show the full diff** (`git show`) in a modal.

![concept](docs/concept.png)

## Features

- Always-on blame gutter in Live Preview / Source mode (like JetBrains "Annotate").
- Short hash + relative or absolute date per line, colored by commit age.
- Consecutive lines from the same commit are visually grouped.
- Click / right-click a line → commit popup (author, date, message, copy hash).
- "Show full diff" → `git show <hash>` rendered with +/- coloring.
- Locally-modified lines are marked as *uncommitted*.
- Command + ribbon icon to toggle the gutter; settings for date style, hash, and coloring.

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
| `git.ts` | Run & parse `git blame` / `git show`; cache by path+mtime |
| `blameExtension.ts` | CM6 state fields, gutter, markers, event handling |
| `popup.ts` | Commit popover + diff modal |
| `settings.ts` | Settings tab |
| `main.ts` | Plugin lifecycle, events, commands |

## Testing

```bash
npm test           # vitest unit tests for the blame parser
```

## Known limitations (v1)

- Editing mode only (reading mode has no gutter — matching how code editors annotate).
- While you have unsaved edits, annotations may be momentarily stale; they re-compute on save.
- Desktop only; no mobile / in-browser git yet.

## License

MIT
