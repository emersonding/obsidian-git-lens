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
import { blameExtension, readBlameContext, setBlame } from "./blameExtension";
import { BlamePopup } from "./popup";
import { GitLensSettingTab } from "./settings";
import { DEFAULT_SETTINGS, GitLensSettings } from "./types";

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

    this.applyGutterVisibility();

    this.registerEditorExtension(
      blameExtension({
        onLineClick: (blame, repoRoot, coords) => {
          new BlamePopup(this.app, this.git, blame, repoRoot).showAt(coords);
        },
      }),
    );

    this.addSettingTab(new GitLensSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
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

    this.addRibbonIcon("git-branch", "Git Lens: toggle blame gutter", () => void this.toggleGutter());

    // Blame whatever is already open once the workspace is ready.
    this.app.workspace.onLayoutReady(() => {
      const file = this.app.workspace.getActiveFile();
      if (file) void this.updateBlame(file);
    });
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

  /** Absolute filesystem path for a vault file (desktop FileSystemAdapter). */
  private absPath(file: TFile): string {
    const adapter = this.app.vault.adapter;
    const base = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
    return `${base}/${file.path}`;
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

    // The active view may have changed while we awaited git; re-check.
    const current = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!current || current.file?.path !== file.path) return;
    const cm = this.getEditorView(current);
    if (!cm) return;

    cm.dispatch({ effects: setBlame.of({ result, settings: this.settings }) });
  }

  /** Re-blame whatever file is currently active and sync gutter visibility. */
  refreshActive(): void {
    this.applyGutterVisibility();
    const file = this.app.workspace.getActiveFile();
    if (file) void this.updateBlame(file);
  }

  /** Open the commit popup for the caret's current line. */
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

    const pos = cm.state.selection.main.head;
    const lineNo = cm.state.doc.lineAt(pos).number;
    const blame = ctx.result.lines[lineNo - 1];
    if (!blame) return;

    const coords = cm.coordsAtPos(pos);
    const point = coords
      ? { x: coords.left, y: coords.bottom }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    new BlamePopup(this.app, this.git, blame, ctx.result.repoRoot).showAt(point);
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
