import { App, Modal, Notice } from "obsidian";
import { ClickCoords } from "./blameExtension";
import { GitBlameService } from "./git";
import { BlameLine } from "./types";
import { formatDateTime, shortHash } from "./format";

/**
 * A lightweight floating popover showing a single commit's details, with a
 * "Show full diff" action. Dismisses on outside click or Escape.
 */
export class BlamePopup {
  private el: HTMLElement | null = null;

  constructor(
    private readonly app: App,
    private readonly git: GitBlameService,
    private readonly blame: BlameLine,
    private readonly repoRoot: string,
  ) {}

  showAt(coords: ClickCoords): void {
    this.close();

    const el = document.createElement("div");
    el.className = "git-lens-popup";

    if (this.blame.isUncommitted) {
      el.createDiv({ cls: "git-lens-popup-summary", text: "Uncommitted local changes (not yet committed)." });
    } else {
      const head = el.createDiv({ cls: "git-lens-popup-head" });
      head.createSpan({ cls: "git-lens-popup-hash", text: shortHash(this.blame.hash) });
      const copy = head.createSpan({ cls: "git-lens-popup-copy", text: "Copy hash" });
      copy.addEventListener("click", () => {
        navigator.clipboard?.writeText(this.blame.hash);
        new Notice("Git Lens: commit hash copied");
      });

      el.createDiv({ cls: "git-lens-popup-row", text: `${this.blame.author} ${this.blame.authorMail}`.trim() });
      el.createDiv({ cls: "git-lens-popup-row", text: formatDateTime(this.blame.authorTime) });
      el.createDiv({ cls: "git-lens-popup-summary", text: this.blame.summary });

      const btn = el.createEl("button", { cls: "git-lens-popup-btn", text: "Show full diff" });
      btn.addEventListener("click", () => void this.showDiff());
    }

    document.body.appendChild(el);
    this.position(el, coords);
    this.el = el;

    // Defer listener attachment so the opening click doesn't immediately close it.
    window.setTimeout(() => {
      document.addEventListener("mousedown", this.onOutsideClick, true);
      document.addEventListener("keydown", this.onKey, true);
    }, 0);
  }

  private position(el: HTMLElement, coords: ClickCoords): void {
    const margin = 8;
    const rect = el.getBoundingClientRect();
    let left = coords.x + 4;
    let top = coords.y + 4;
    if (left + rect.width + margin > window.innerWidth) left = window.innerWidth - rect.width - margin;
    if (top + rect.height + margin > window.innerHeight) top = coords.y - rect.height - 4;
    el.style.left = `${Math.max(margin, left)}px`;
    el.style.top = `${Math.max(margin, top)}px`;
  }

  private async showDiff(): Promise<void> {
    try {
      const diff = await this.git.show(this.repoRoot, this.blame.hash);
      new DiffModal(this.app, this.blame, diff).open();
      this.close();
    } catch {
      new Notice("Git Lens: failed to load commit diff");
    }
  }

  private readonly onOutsideClick = (e: MouseEvent): void => {
    if (this.el && !this.el.contains(e.target as Node)) this.close();
  };

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") this.close();
  };

  close(): void {
    document.removeEventListener("mousedown", this.onOutsideClick, true);
    document.removeEventListener("keydown", this.onKey, true);
    this.el?.remove();
    this.el = null;
  }
}

/** Modal that renders `git show <hash>` output with basic +/- coloring. */
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
    const pre = this.contentEl.createEl("pre", { cls: "git-lens-diff" });
    for (const line of this.diff.split("\n")) {
      const row = pre.createEl("div", { text: line.length ? line : " " });
      if (line.startsWith("+") && !line.startsWith("+++")) row.addClass("git-lens-add");
      else if (line.startsWith("-") && !line.startsWith("---")) row.addClass("git-lens-del");
      else if (line.startsWith("@@")) row.addClass("git-lens-hunk");
      else if (line.startsWith("diff ") || line.startsWith("commit ") || line.startsWith("index ")) {
        row.addClass("git-lens-meta");
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
