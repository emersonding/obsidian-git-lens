import {
  Debouncer,
  FileSystemAdapter,
  MarkdownView,
  Notice,
  Platform,
  Plugin,
  TFile,
  debounce,
} from "obsidian";
import type { EditorView } from "@codemirror/view";
import { GitBlameService } from "./git";
import { blameExtension, blameMarkerCount, readBlameContext, setBlame } from "./blameExtension";
import { DiffModal } from "./diff";
import { GitLensSettingTab } from "./settings";
import { BlameLine, BlameResult, DEFAULT_SETTINGS, GitLensSettings } from "./types";

export default class GitLensPlugin extends Plugin {
  settings: GitLensSettings = DEFAULT_SETTINGS;
  private readonly git = new GitBlameService();
  private recomputeOnModify!: Debouncer<[TFile], void>;

  async onload(): Promise<void> {
    await this.loadSettings();

    // The plugin shells out to `git`, so it only works on desktop.
    if (!Platform.isDesktopApp) {
      return;
    }

    this.applyGitConfig();
    this.applyGutterVisibility();

    this.registerEditorExtension(
      blameExtension({
        onLineClick: (blame, result) => void this.openDiff(blame, result),
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
        menu.addItem((item) =>
          item
            .setTitle("Git Lens: Blame this line")
            .setIcon("git-branch")
            .onClick(() => this.blameCurrentLine()),
        );
      }),
    );

    this.addCommand({
      id: "toggle-blame-gutter",
      name: "Toggle blame gutter",
      callback: () => void this.toggleGutter(),
    });

    this.addCommand({
      id: "blame-current-line",
      name: "Blame current line",
      callback: () => this.blameCurrentLine(),
    });

    this.addCommand({
      id: "diagnose",
      name: "Diagnose blame for current file",
      callback: () => void this.diagnose(),
    });

    this.addRibbonIcon("git-branch", "Git Lens: toggle blame gutter", () => void this.toggleGutter());

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

  private async toggleGutter(): Promise<void> {
    this.settings.enableGutter = !this.settings.enableGutter;
    await this.saveSettings();
    this.refreshActive();
    new Notice(`Git Lens: blame gutter ${this.settings.enableGutter ? "on" : "off"}`);
  }

  private applyGutterVisibility(): void {
    document.body.classList.toggle("git-lens-off", !this.settings.enableGutter);
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

  /** Compute blame for a file and push it into the active editor. */
  async updateBlame(file: TFile): Promise<void> {
    if (file.extension !== "md") return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.file?.path !== file.path) return;

    const result = await this.git.blame(this.absPath(file), file.stat.mtime);
    this.log(
      `blame ${file.path}: ${result ? `${result.lines.length} lines (${result.repoRoot})` : "no git repo / untracked"}`,
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

  /** Re-blame whatever file is currently active and sync gutter visibility. */
  refreshActive(): void {
    this.applyGutterVisibility();
    const file = this.app.workspace.getActiveFile();
    if (file) void this.updateBlame(file);
  }

  /** Open the commit diff for the caret's current line. */
  private blameCurrentLine(): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    const cm = this.getEditorView(view);
    if (!cm) return;

    const ctx = readBlameContext(cm.state);
    if (!ctx || !ctx.result) {
      new Notice("Git Lens: no blame data for this file");
      return;
    }

    const lineNo = cm.state.doc.lineAt(cm.state.selection.main.head).number;
    const blame = ctx.result.lines[lineNo - 1];
    if (blame) void this.openDiff(blame, ctx.result);
  }

  /** Show the commit that last changed a line, scoped to the current file. */
  private async openDiff(blame: BlameLine, result: BlameResult): Promise<void> {
    if (blame.isUncommitted) {
      new Notice("Git Lens: line has uncommitted changes — no commit to show");
      return;
    }
    try {
      const diff = await this.git.show(result.absFile, blame.hash);
      new DiffModal(this.app, blame, diff).open();
    } catch {
      new Notice("Git Lens: failed to load commit diff");
    }
  }

  /** Report the full blame pipeline state for the active file. */
  private async diagnose(): Promise<void> {
    const lines: string[] = [];
    lines.push(`desktop: ${Platform.isDesktopApp}`);
    lines.push(`gutter enabled: ${this.settings.enableGutter}`);
    lines.push(`git path: ${this.git.gitPath}`);

    try {
      lines.push(`git: ${await this.git.version(this.vaultBase())}`);
    } catch {
      lines.push("git: NOT FOUND on PATH (set an absolute path in settings)");
    }

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    lines.push(`markdown view: ${!!view}`);
    const file = view?.file ?? this.app.workspace.getActiveFile();
    lines.push(`file: ${file?.path ?? "none"}`);
    const cm = view ? this.getEditorView(view) : null;
    lines.push(`CM6 editor: ${!!cm}`);
    lines.push(`gutter attached: ${cm ? readBlameContext(cm.state) !== null : "n/a"}`);
    if (cm) {
      lines.push(`doc lines: ${cm.state.doc.lines}`);
      lines.push(`gutter markers: ${blameMarkerCount(cm.state)}`);
    }

    if (file) {
      const abs = this.absPath(file);
      const root = await this.git.getRepoRoot(abs);
      lines.push(`repo root: ${root ?? "not a git repo / untracked"}`);
      if (root) {
        const result = await this.git.blame(abs, file.stat.mtime);
        if (result) {
          lines.push(`blame lines: ${result.lines.length}`);
          lines.push(`distinct commits: ${new Set(result.lines.map((l) => l.hash)).size}`);
        } else {
          lines.push("blame lines: null");
        }
      }
    }

    const msg = lines.join("\n");
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
    document.body.classList.remove("git-lens-off");
  }
}
