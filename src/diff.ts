import { App, Modal, Notice, setIcon } from "obsidian";
import { GitBlameService } from "./git";
import { BlameLine, ChangedFile, CommitInfo, HISTORY_PAGE_SIZE } from "./types";
import { formatAbsolute, formatAge, shortHash } from "./format";
import { DiffFileKind, parseDiff } from "./diffParse";

/** Map a git --name-status letter to a label + the CSS modifier used for badges. */
const STATUS_INFO: Record<string, { label: string; kind: DiffFileKind }> = {
  A: { label: "A", kind: "added" },
  M: { label: "M", kind: "modified" },
  D: { label: "D", kind: "deleted" },
  R: { label: "R", kind: "renamed" },
  C: { label: "C", kind: "renamed" },
  T: { label: "T", kind: "modified" },
};

const BADGE_LABEL: Record<DiffFileKind, string> = {
  added: "added",
  deleted: "deleted",
  renamed: "renamed",
  modified: "modified",
  binary: "binary",
};

/** Color +/- content rows; size each to its content so the tint spans full width. */
function renderBody(pre: HTMLElement, lines: string[]): void {
  for (const line of lines) {
    const row = pre.createEl("div", { text: line.length ? line : " " });
    if (line.startsWith("+")) row.addClass("git-lens-add");
    else if (line.startsWith("-")) row.addClass("git-lens-del");
    else if (line.startsWith("@@")) row.addClass("git-lens-hunk");
    else if (line.startsWith("Binary files") || line.startsWith("\\ ")) row.addClass("git-lens-meta");
  }
}

/**
 * Render unified-diff text into `el`: a compact commit preamble, then one clean
 * header per file (badge + path) followed by its +/- colored hunks. Falls back
 * to raw line rendering if the text isn't a recognizable file diff. Returns a
 * map of file path -> its header element, so callers can scroll to a file.
 */
export function renderDiffInto(el: HTMLElement, diff: string): Map<string, HTMLElement> {
  el.empty();
  const headers = new Map<string, HTMLElement>();
  const { preamble, files } = parseDiff(diff);

  const message = preamble.join("\n").trim();
  if (message) {
    const head = el.createDiv({ cls: "git-lens-diff-commit" });
    for (const line of preamble) {
      if (line.startsWith("commit ")) continue; // hash is already in the title
      head.createDiv({ text: line.replace(/^ {4}/, "") || " " });
    }
  }

  if (files.length === 0) {
    // Not a file diff (or empty) — render verbatim with the old coloring.
    renderBody(el.createEl("pre", { cls: "git-lens-diff" }), diff.split("\n"));
    return headers;
  }

  for (const file of files) {
    const header = el.createDiv({ cls: "git-lens-diff-file" });
    header.createSpan({ cls: `git-lens-diff-badge is-${file.kind}`, text: BADGE_LABEL[file.kind] });
    const name = header.createSpan({ cls: "git-lens-diff-path" });
    if (file.oldPath) {
      name.createSpan({ cls: "git-lens-diff-oldpath", text: file.oldPath });
      name.createSpan({ cls: "git-lens-diff-arrow", text: " → " });
    }
    name.createSpan({ text: file.path || "(unknown)" });
    if (file.path) headers.set(file.path, header);

    if (file.body.length) renderBody(el.createEl("pre", { cls: "git-lens-diff" }), file.body);
  }
  return headers;
}

/**
 * Modal that renders `git show <hash> -- <file>` output (scoped to one file)
 * with basic +/- coloring.
 */
export class DiffModal extends Modal {
  constructor(
    app: App,
    private readonly blame: BlameLine,
    private readonly diff: string,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("git-lens-diff-modal");
    this.titleEl.setText(`${shortHash(this.blame.hash)} — ${this.blame.summary}`);
    renderDiffInto(this.contentEl, this.diff);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Per-row controls so the expand/collapse-all button can drive every commit. */
interface CommitRow {
  setExpanded(v: boolean): void;
}

/**
 * Master-detail commit history for a file or directory: a scrollable commit list
 * on the left, the selected commit's diff on the right. Each commit row expands
 * to show the files it changed; an "Expand all" button toggles every row, and a
 * "Load more" button pages further back through history. Diffs load lazily when
 * a commit is selected; the newest commit is selected on open.
 */
export class HistoryModal extends Modal {
  private detailEl!: HTMLElement;
  private rowsEl!: HTMLElement;
  private moreEl!: HTMLElement;
  private selectedHash: string | null = null;
  private allExpanded = false;
  private loading = false;
  private exhausted = false;
  private readonly commits: CommitInfo[];
  private readonly rowByHash = new Map<string, HTMLElement>();
  private readonly rows: CommitRow[] = [];
  private readonly diffCache = new Map<string, string>();

  constructor(
    app: App,
    private readonly git: GitBlameService,
    private readonly absPath: string,
    private readonly isDir: boolean,
    /** Display name shown in the title (file basename or folder path). */
    private readonly displayName: string,
    /** First page of commits, already fetched. */
    initial: CommitInfo[],
  ) {
    super(app);
    this.commits = [...initial];
  }

  onOpen(): void {
    this.modalEl.addClass("git-lens-history-modal");

    const toolbar = this.contentEl.createDiv({ cls: "git-lens-history-toolbar" });
    const expandBtn = toolbar.createEl("button", { text: "Expand all" });
    expandBtn.addEventListener("click", () => {
      this.allExpanded = !this.allExpanded;
      for (const r of this.rows) r.setExpanded(this.allExpanded);
      expandBtn.setText(this.allExpanded ? "Collapse all" : "Expand all");
    });

    const split = this.contentEl.createDiv({ cls: "git-lens-history" });
    const list = split.createDiv({ cls: "git-lens-history-list" });
    this.rowsEl = list.createDiv({ cls: "git-lens-history-rows" });
    this.moreEl = list.createDiv({ cls: "git-lens-history-more" });
    this.detailEl = split.createDiv({ cls: "git-lens-history-detail" });

    for (const commit of this.commits) this.renderCommit(commit);
    this.renderMore();
    this.updateTitle();

    if (this.commits.length) void this.select(this.commits[0].hash);
    else this.detailEl.createDiv({ cls: "git-lens-history-empty", text: "No commits." });
  }

  private updateTitle(): void {
    this.titleEl.setText(`History — ${this.displayName} (${this.commits.length})`);
  }

  private renderCommit(commit: CommitInfo): void {
    const row = this.rowsEl.createDiv({ cls: "git-lens-commit" });
    this.rowByHash.set(commit.hash, row);

    const head = row.createDiv({ cls: "git-lens-commit-head" });
    const chevron = head.createSpan({ cls: "git-lens-commit-chevron" });
    setIcon(chevron, "chevron-right");
    const main = head.createDiv({ cls: "git-lens-commit-main" });
    main.createDiv({ cls: "git-lens-commit-summary", text: commit.summary || "(no message)" });
    const meta = main.createDiv({ cls: "git-lens-commit-meta" });
    meta.createSpan({ cls: "git-lens-commit-hash", text: shortHash(commit.hash) });
    meta.createSpan({ cls: "git-lens-commit-author", text: commit.author });
    meta.createSpan({
      cls: "git-lens-commit-date",
      text: commit.authorTime ? `${formatAbsolute(commit.authorTime)} · ${formatAge(commit.authorTime)}` : "",
    });

    const fileList = row.createDiv({ cls: "git-lens-commit-files" });
    if (commit.files.length) {
      for (const file of commit.files) this.renderChangedFile(fileList, commit.hash, file);
    } else {
      fileList.createDiv({ cls: "git-lens-commit-file is-empty", text: "No files in this path" });
    }

    let expanded = false;
    const setExpanded = (v: boolean): void => {
      expanded = v;
      row.toggleClass("is-expanded", v);
    };
    chevron.addEventListener("click", (e) => {
      e.stopPropagation();
      setExpanded(!expanded);
    });
    main.addEventListener("click", () => void this.select(commit.hash));

    setExpanded(this.allExpanded);
    this.rows.push({ setExpanded });
  }

  private renderChangedFile(list: HTMLElement, hash: string, file: ChangedFile): void {
    const info = STATUS_INFO[file.status] ?? { label: file.status, kind: "modified" as DiffFileKind };
    const fr = list.createDiv({ cls: "git-lens-commit-file" });
    fr.createSpan({ cls: `git-lens-file-status is-${info.kind}`, text: info.label });
    const path = fr.createSpan({ cls: "git-lens-file-path" });
    if (file.oldPath) {
      path.createSpan({ cls: "git-lens-diff-oldpath", text: file.oldPath });
      path.createSpan({ cls: "git-lens-diff-arrow", text: " → " });
    }
    path.createSpan({ text: file.path });
    fr.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.select(hash, file.path);
    });
  }

  private renderMore(): void {
    this.moreEl.empty();
    // A full first page implies there may be more; once a fetch comes back short
    // (or empty) `exhausted` is set and the button stays hidden.
    if (this.exhausted || this.commits.length === 0 || this.commits.length % HISTORY_PAGE_SIZE !== 0) {
      return;
    }
    const btn = this.moreEl.createEl("button", { text: "Load more" });
    btn.addEventListener("click", () => void this.loadMore(btn));
  }

  private async loadMore(btn: HTMLButtonElement): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    btn.disabled = true;
    btn.setText("Loading…");
    try {
      const next = await this.git.log(this.absPath, this.isDir, HISTORY_PAGE_SIZE, this.commits.length);
      const page = next ?? [];
      for (const commit of page) {
        this.commits.push(commit);
        this.renderCommit(commit);
      }
      // A short/empty page (or a failed fetch) means we've reached the end.
      if (next === null || page.length < HISTORY_PAGE_SIZE) this.exhausted = true;
      this.updateTitle();
      this.renderMore(); // re-evaluates whether another page is likely
    } catch {
      btn.disabled = false;
      btn.setText("Load more");
      new Notice("Git Lens: failed to load more commits");
    } finally {
      this.loading = false;
    }
  }

  private async select(hash: string, scrollToPath?: string): Promise<void> {
    this.selectedHash = hash;
    for (const [h, row] of this.rowByHash) row.toggleClass("is-active", h === hash);

    const render = (diff: string): void => {
      const headers = renderDiffInto(this.detailEl, diff);
      const target = scrollToPath ? headers.get(scrollToPath) : undefined;
      if (target) target.scrollIntoView({ block: "start" });
      else this.detailEl.scrollTop = 0;
    };

    const cached = this.diffCache.get(hash);
    if (cached !== undefined) {
      render(cached);
      return;
    }

    this.detailEl.empty();
    this.detailEl.createDiv({ cls: "git-lens-history-empty", text: "Loading diff…" });
    try {
      const diff = await this.git.showPath(this.absPath, this.isDir, hash);
      this.diffCache.set(hash, diff);
      // The user may have clicked another commit while we awaited git.
      if (this.selectedHash === hash) render(diff);
    } catch {
      if (this.selectedHash === hash) {
        this.detailEl.empty();
        this.detailEl.createDiv({ cls: "git-lens-history-empty", text: "Failed to load diff." });
      }
      new Notice("Git Lens: failed to load commit diff");
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
