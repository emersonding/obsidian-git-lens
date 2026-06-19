import { App, PluginSettingTab, Setting } from "obsidian";
import type GitLensPlugin from "./main";
import { ColorMode, DateStyle } from "./types";

export class GitLensSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: GitLensPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Show blame gutter")
      .setDesc("Display per-line commit annotations in the editor's left gutter.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enableGutter).onChange(async (v) => {
          this.plugin.settings.enableGutter = v;
          await this.plugin.saveSettings();
          this.plugin.refreshActive();
        }),
      );

    new Setting(containerEl)
      .setName("Date format")
      .setDesc("How the commit date is shown in the gutter.")
      .addDropdown((d) =>
        d
          .addOption("relative", "Relative (e.g. 3w)")
          .addOption("absolute", "Absolute (YYYY-MM-DD)")
          .setValue(this.plugin.settings.dateStyle)
          .onChange(async (v) => {
            this.plugin.settings.dateStyle = v as DateStyle;
            await this.plugin.saveSettings();
            this.plugin.refreshActive();
          }),
      );

    new Setting(containerEl)
      .setName("Show commit hash")
      .setDesc("Show the short commit hash alongside the date.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showHash).onChange(async (v) => {
          this.plugin.settings.showHash = v;
          await this.plugin.saveSettings();
          this.plugin.refreshActive();
        }),
      );

    new Setting(containerEl)
      .setName("Bar color")
      .setDesc("How the left annotation bar is colored.")
      .addDropdown((d) =>
        d
          .addOption("commit", "By commit (distinct color per commit)")
          .addOption("age", "By age (gradient)")
          .addOption("none", "None")
          .setValue(this.plugin.settings.colorMode)
          .onChange(async (v) => {
            this.plugin.settings.colorMode = v as ColorMode;
            await this.plugin.saveSettings();
            this.plugin.refreshActive();
          }),
      );

    new Setting(containerEl)
      .setName("Soft wrap diffs")
      .setDesc("Wrap long lines in the history view instead of scrolling horizontally.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.wrapDiff).onChange(async (v) => {
          this.plugin.settings.wrapDiff = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Git executable")
      .setDesc(
        "Path to the git binary. Set an absolute path (e.g. /usr/bin/git or " +
          "/opt/homebrew/bin/git) if the gutter never appears — Obsidian launched " +
          "from Finder/Dock can have a PATH that doesn't include git.",
      )
      .addText((t) =>
        t
          .setPlaceholder("git")
          .setValue(this.plugin.settings.gitPath)
          .onChange(async (v) => {
            this.plugin.settings.gitPath = v.trim() || "git";
            await this.plugin.saveSettings();
            this.plugin.applyGitConfig();
            this.plugin.refreshActive();
          }),
      );
  }
}
