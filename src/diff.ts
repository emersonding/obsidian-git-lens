import { App, Modal, Notice } from "obsidian";
import { GitBlameService } from "./git";
import { BlameLine, CommitInfo } from "./types";
import { formatAbsolute, formatAge, shortHash } from "./format";

/**
 * Render unified-diff text into `el` with basic +/- coloring. Each row is sized
 * to its content (with a full-width floor) so the colored background spans the
 * whole line even when scrolled horizontally.
 */
export function renderDiffInto(el: HTMLElement, diff: string): void {
  el.empty();
  const pre = el.createEl("pre", { cls: "git-lens-diff" });
  for (const line of diff.split("\n")) {
    const row = pre.createEl("div", { text: line.length ? line : " " });
    if (line.startsWith("+") && !line.startsWith("+++")) row.addClass("git-lens-add");
    else if (line.startsWith("-") && !line.startsWith("---")) row.addClass("git-lens-del");
    else if (line.startsWith("@@")) row.addClass("git-lens-hunk");
    else if (line.startsWith("diff ") || line.startsWith("commit ") || line.startsWith("index ")) {
      row.addClass("git-lens-meta");
    }
  }
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
    this.titleEl.setText(`${shortHash(this.blame.hash)} — ${this.blame.summary}`);
    renderDiffInto(this.contentEl, this.diff);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Master-detail commit history for a file or directory: a scrollable commit list
 * on the left, the selected commit's diff on the right. Diffs are loaded lazily
 * when a commit is selected; the newest commit is selected on open.
 */
export class HistoryModal extends Modal {
  private detailEl!: HTMLElement;
  private selectedHash: string | null = null;
  private readonly rowByHash = new Map<string, HTMLElement>();
  private readonly diffCache = new Map<string, string>();

  constructor(
    app: App,
    private readonly git: GitBlameService,
    private readonly absPath: string,
    private readonly isDir: boolean,
    /** Display name shown in the title (file basename or folder path). */
    private readonly displayName: string,
    private readonly commits: CommitInfo[],
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("git-lens-history-modal");
    this.titleEl.setText(`History — ${this.displayName} (${this.commits.length})`);

    const split = this.contentEl.createDiv({ cls: "git-lens-history" });
    const list = split.createDiv({ cls: "git-lens-history-list" });
    this.detailEl = split.createDiv({ cls: "git-lens-history-detail" });

    for (const commit of this.commits) {
      const row = list.createDiv({ cls: "git-lens-commit" });
      this.rowByHash.set(commit.hash, row);

      row.createDiv({ cls: "git-lens-commit-summary", text: commit.summary || "(no message)" });
      const meta = row.createDiv({ cls: "git-lens-commit-meta" });
      meta.createSpan({ cls: "git-lens-commit-hash", text: shortHash(commit.hash) });
      meta.createSpan({ cls: "git-lens-commit-author", text: commit.author });
      meta.createSpan({
        cls: "git-lens-commit-date",
        text: commit.authorTime ? `${formatAbsolute(commit.authorTime)} · ${formatAge(commit.authorTime)}` : "",
      });

      row.addEventListener("click", () => void this.select(commit.hash));
    }

    if (this.commits.length) void this.select(this.commits[0].hash);
    else this.detailEl.createDiv({ cls: "git-lens-history-empty", text: "No commits." });
  }

  private async select(hash: string): Promise<void> {
    this.selectedHash = hash;
    for (const [h, row] of this.rowByHash) row.toggleClass("is-active", h === hash);

    const cached = this.diffCache.get(hash);
    if (cached !== undefined) {
      renderDiffInto(this.detailEl, cached);
      return;
    }

    this.detailEl.empty();
    this.detailEl.createDiv({ cls: "git-lens-history-empty", text: "Loading diff…" });
    try {
      const diff = await this.git.showPath(this.absPath, this.isDir, hash);
      this.diffCache.set(hash, diff);
      // The user may have clicked another commit while we awaited git.
      if (this.selectedHash === hash) renderDiffInto(this.detailEl, diff);
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
