import {
  Debouncer,
  FileSystemAdapter,
  MarkdownView,
  Notice,
  Platform,
  Plugin,
  TAbstractFile,
  TFile,
  TFolder,
  debounce,
} from "obsidian";
import type { EditorView } from "@codemirror/view";
import { GitBlameService } from "./git";
import { blameExtension, blameMarkerCount, readBlameContext, setBlame } from "./blameExtension";
import { HistoryModal } from "./diff";
import { GitLensSettingTab } from "./settings";
import { BlameLine, BlameResult, BlameStats, DEFAULT_SETTINGS, GitLensSettings } from "./types";

export default class GitLensPlugin extends Plugin {
  settings: GitLensSettings = DEFAULT_SETTINGS;
  private readonly git = new GitBlameService();
  /** Notes with blame explicitly turned on for just that note (independent of the
   *  global setting; ephemeral — resets on reload). */
  private readonly perNote = new Set<string>();
  private recomputeOnModify!: Debouncer<[TFile], void>;

  async onload(): Promise<void> {
    await this.loadSettings();

    // The plugin shells out to `git`, so it only works on desktop.
    if (!Platform.isDesktopApp) {
      return;
    }

    this.applyGitConfig();

    this.registerEditorExtension(
      blameExtension({
        onLineClick: (blame, result) => void this.openLineHistory(blame, result),
      }),
    );

    this.addSettingTab(new GitLensSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file) void this.updateBlame(file);
      }),
    );

    // Re-blame when switching panes/notes (also catches editors that only got
    // the gutter extension attached after this plugin was enabled).
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const file = this.app.workspace.getActiveFile();
        if (file) void this.updateBlame(file);
      }),
    );

    this.recomputeOnModify = debounce(
      (file: TFile) => {
        this.git.invalidate(this.absPath(file));
        const active = this.app.workspace.getActiveFile();
        if (active && active.path === file.path) void this.updateBlame(file);
      },
      400,
      true,
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) this.recomputeOnModify(file);
      }),
    );

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, _editor, view) => {
        if (!(view instanceof MarkdownView) || !view.file) return;
        const on = !!view.file && this.perNote.has(view.file.path);
        menu.addItem((item) =>
          item
            .setTitle(`Git Lens: ${on ? "hide" : "show"} blame for this note`)
            .setIcon("git-branch")
            .onClick(() => this.toggleNoteBlame()),
        );
      }),
    );

    // Right-click a file or folder in the explorer → show its commit history.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        menu.addItem((item) =>
          item
            .setTitle("Git Lens: show history")
            .setIcon("history")
            .onClick(() => void this.openHistory(file)),
        );
      }),
    );

    this.addCommand({
      id: "show-history-file",
      name: "Show history for current file",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (checking) return !!file;
        if (file) void this.openHistory(file);
        return true;
      },
    });

    this.addCommand({
      id: "show-history-all",
      name: "Show history for all files",
      callback: () => void this.showHistory(this.vaultBase(), true, "All files"),
    });

    this.addCommand({
      id: "toggle-blame-note",
      name: "Toggle blame for this note",
      callback: () => this.toggleNoteBlame(),
    });

    this.addCommand({
      id: "toggle-blame-gutter",
      name: "Toggle blame for all notes (global)",
      callback: () => void this.toggleGutter(),
    });

    this.addCommand({
      id: "diagnose",
      name: "Diagnose blame for current file",
      callback: () => void this.diagnose(),
    });

    this.addRibbonIcon("git-branch", "Git Lens: toggle blame for this note", () => this.toggleNoteBlame());

    // Verify git is reachable; warn early if not (common macOS GUI PATH issue).
    void this.git
      .version(this.vaultBase())
      .then((v) => this.log(`git available: ${v}`))
      .catch(() => {
        this.log("git NOT found — set an absolute path in Git Lens settings");
        new Notice(
          "Git Lens: couldn't run 'git'. Set the git path in Git Lens settings (e.g. /usr/bin/git).",
          12000,
        );
      });

    // Attach the gutter to any already-open editors, then blame the active note.
    this.app.workspace.onLayoutReady(() => {
      this.app.workspace.updateOptions();
      const file = this.app.workspace.getActiveFile();
      if (file) void this.updateBlame(file);
    });

    this.log(`loaded v${this.manifest.version} (click gutter → diff)`);
  }

  /** Push the configured git path into the service and drop stale cache. */
  applyGitConfig(): void {
    this.git.gitPath = this.settings.gitPath || "git";
    this.git.clear();
  }

  /** Whether blame should show for a file: the global setting OR a per-note opt-in. */
  private shouldBlame(file: TFile | null | undefined): boolean {
    return !!file && (this.settings.enableGutter || this.perNote.has(file.path));
  }

  private async toggleGutter(): Promise<void> {
    this.settings.enableGutter = !this.settings.enableGutter;
    await this.saveSettings();
    this.refreshActive();
    new Notice(`Git Lens: blame for all notes ${this.settings.enableGutter ? "on" : "off"}`);
  }

  /** Toggle blame for just the active note, independent of the global setting. */
  private toggleNoteBlame(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) return;
    const on = !this.perNote.has(file.path);
    if (on) this.perNote.add(file.path);
    else this.perNote.delete(file.path);
    void this.updateBlame(file);
    new Notice(`Git Lens: blame for "${file.basename}" ${on ? "on" : "off"}`);
  }

  private vaultBase(): string {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : ".";
  }

  /** Absolute filesystem path for a vault file (desktop FileSystemAdapter). */
  private absPath(file: TFile): string {
    return `${this.vaultBase()}/${file.path}`;
  }

  /** The underlying CodeMirror 6 EditorView for a Markdown view. */
  private getEditorView(view: MarkdownView): EditorView | null {
    // `editor.cm` is the CM6 EditorView; not in the public typings.
    return (view.editor as unknown as { cm?: EditorView }).cm ?? null;
  }

  /** Compute blame for a file and push it into the active editor — or clear it. */
  async updateBlame(file: TFile): Promise<void> {
    if (file.extension !== "md") return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.file?.path !== file.path) return;
    const cmEarly = this.getEditorView(view);

    // Not blaming this note (global off and not per-note opted in): clear any
    // existing markers and do no git work / logging.
    if (!this.shouldBlame(file)) {
      if (cmEarly && readBlameContext(cmEarly.state)?.result) {
        cmEarly.dispatch({ effects: setBlame.of({ result: null, settings: this.settings }) });
      }
      return;
    }

    const result = await this.git.blame(this.absPath(file), file.stat.mtime);
    this.log(
      `blame ${file.path}: ${
        result
          ? result.unavailableReason
            ? `unavailable — ${result.unavailableReason}`
            : `${result.lines.length} lines (${result.repoRoot})`
          : "no git repo / untracked"
      }`,
    );

    // The active view may have changed while we awaited git; re-check.
    const current = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!current || current.file?.path !== file.path) return;
    const cm = this.getEditorView(current);
    if (!cm) {
      this.log("no CM6 editor view (reading mode?)");
      return;
    }

    // If our gutter field isn't on this editor yet, force a reconfigure so the
    // dispatched effect has somewhere to land.
    if (readBlameContext(cm.state) === null) {
      this.log("gutter extension not attached yet; calling updateOptions()");
      this.app.workspace.updateOptions();
    }

    cm.dispatch({ effects: setBlame.of({ result, settings: this.settings }) });
  }

  /** Re-blame whatever file is currently active. */
  refreshActive(): void {
    const file = this.app.workspace.getActiveFile();
    if (file) void this.updateBlame(file);
  }

  /** Open this file's history viewer, focused on the commit that last changed
   * the clicked line. */
  private async openLineHistory(blame: BlameLine, result: BlameResult): Promise<void> {
    if (blame.isUncommitted) {
      new Notice("Git Lens: line has uncommitted changes — no commit to show");
      return;
    }
    const displayName = result.absFile.split("/").pop() ?? result.absFile;
    await this.showHistory(result.absFile, false, displayName, blame.hash);
  }

  /** Open the commit-history viewer for a file or folder from the explorer. */
  private async openHistory(file: TAbstractFile): Promise<void> {
    const isDir = file instanceof TFolder;
    if (!isDir && !(file instanceof TFile)) return;
    const abs = `${this.vaultBase()}/${file.path}`;
    const displayName = isDir ? file.path || "All files" : (file as TFile).name;
    await this.showHistory(abs, isDir, displayName);
  }

  /** Fetch the first page of history for a path and open the viewer, or warn.
   * `focusHash` selects/reveals a specific commit on open (e.g. from a blame click). */
  private async showHistory(abs: string, isDir: boolean, displayName: string, focusHash?: string): Promise<void> {
    try {
      const commits = await this.git.log(abs, isDir);
      if (commits === null) {
        new Notice("Git Lens: not a git repo (or git unavailable)");
        return;
      }
      if (commits.length === 0) {
        new Notice(`Git Lens: no commit history for "${displayName}"`);
        return;
      }
      const repoRoot = await this.git.getRepoRoot(abs);
      new HistoryModal(
        this.app,
        this.git,
        abs,
        isDir,
        displayName,
        commits,
        this.settings,
        () => this.saveSettings(),
        focusHash,
        (repoRelPath) => this.openDiffFile(repoRoot, repoRelPath),
      ).open();
    } catch {
      new Notice("Git Lens: failed to load commit history");
    }
  }

  /** Open a file from a diff header in the workspace. The diff path is relative
   * to the git repo root, so map it back to a vault-relative path before
   * resolving the `TFile`; fall back to a basename link lookup. */
  private async openDiffFile(repoRoot: string | null, repoRelPath: string): Promise<void> {
    const base = this.vaultBase();
    let file: TAbstractFile | null = null;

    if (repoRoot) {
      const abs = `${repoRoot}/${repoRelPath}`;
      if (abs.startsWith(`${base}/`)) {
        file = this.app.vault.getAbstractFileByPath(abs.slice(base.length + 1));
      }
    }
    // Fall back to treating the diff path as vault-relative (vault == repo root).
    if (!(file instanceof TFile)) file = this.app.vault.getAbstractFileByPath(repoRelPath);

    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file);
      return;
    }
    // Last resort: resolve by basename across the vault (handles deleted/moved).
    const linktext = repoRelPath.split("/").pop() ?? repoRelPath;
    const resolved = this.app.metadataCache.getFirstLinkpathDest(linktext, "");
    if (resolved) {
      await this.app.workspace.getLeaf(false).openFile(resolved);
      return;
    }
    new Notice(`Git Lens: can't open "${repoRelPath}" — not in this vault`);
  }

  /**
   * Structured snapshot of the blame pipeline for the active file. Public so the
   * automated E2E harness can read it via `app.plugins.plugins['git-lens'].getBlameStats()`.
   */
  async getBlameStats(): Promise<BlameStats> {
    const stats: BlameStats = {
      desktop: Platform.isDesktopApp,
      gutterEnabled: this.settings.enableGutter,
      gitPath: this.git.gitPath,
      gitVersion: null,
      file: null,
      repoRoot: null,
      hasView: false,
      hasEditor: false,
      gutterAttached: false,
      docLines: null,
      markers: null,
      blameLines: null,
      distinctCommits: null,
      unavailableReason: null,
    };

    try {
      stats.gitVersion = await this.git.version(this.vaultBase());
    } catch {
      stats.gitVersion = null;
    }

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    stats.hasView = !!view;
    const file = view?.file ?? this.app.workspace.getActiveFile();
    stats.file = file?.path ?? null;
    const cm = view ? this.getEditorView(view) : null;
    stats.hasEditor = !!cm;
    if (cm) {
      stats.gutterAttached = readBlameContext(cm.state) !== null;
      stats.docLines = cm.state.doc.lines;
      stats.markers = blameMarkerCount(cm.state);
    }

    if (file) {
      const abs = this.absPath(file);
      stats.repoRoot = await this.git.getRepoRoot(abs);
      if (stats.repoRoot) {
        const result = await this.git.blame(abs, file.stat.mtime);
        if (result?.unavailableReason) {
          stats.unavailableReason = result.unavailableReason;
        } else if (result) {
          stats.blameLines = result.lines.length;
          stats.distinctCommits = new Set(result.lines.map((l) => l.hash)).size;
        }
      }
    }

    return stats;
  }

  /** Report the blame pipeline state for the active file as a Notice. */
  private async diagnose(): Promise<void> {
    const s = await this.getBlameStats();
    const blame = s.unavailableReason
      ? `blame: unavailable — ${s.unavailableReason}`
      : s.blameLines === null
        ? "blame: no git repo / untracked"
        : `blame lines: ${s.blameLines}\ndistinct commits: ${s.distinctCommits}`;
    const msg = [
      `desktop: ${s.desktop}`,
      `gutter enabled: ${s.gutterEnabled}`,
      `git: ${s.gitVersion ?? "NOT FOUND on PATH (set an absolute path in settings)"}`,
      `file: ${s.file ?? "none"}`,
      `CM6 editor: ${s.hasEditor}`,
      `gutter attached: ${s.gutterAttached}`,
      `doc lines: ${s.docLines ?? "n/a"}`,
      `gutter markers: ${s.markers ?? "n/a"}`,
      `repo root: ${s.repoRoot ?? "not a git repo / untracked"}`,
      blame,
    ].join("\n");
    this.log(`diagnose\n${msg}`);
    new Notice(`Git Lens diagnose:\n${msg}`, 20000);
  }

  private log(msg: string): void {
    console.log(`[Git Lens] ${msg}`);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  onunload(): void {
    this.git.clear();
  }
}
