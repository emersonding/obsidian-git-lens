import { App, Modal } from "obsidian";
import { BlameLine } from "./types";
import { shortHash } from "./format";

/**
 * Modal that renders `git show <hash> -- <file>` output (scoped to one file)
 * with basic +/- coloring. Each row is sized to its content so the colored
 * background spans the full line even when scrolled horizontally.
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
