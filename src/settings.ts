import { App, PluginSettingTab, Setting } from "obsidian";
import type GitLensPlugin from "./main";
import { DateStyle } from "./types";

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
      .setName("Color by age")
      .setDesc("Tint each annotation's left border based on how old the commit is.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.colorByAge).onChange(async (v) => {
          this.plugin.settings.colorByAge = v;
          await this.plugin.saveSettings();
          this.plugin.refreshActive();
        }),
      );
  }
}
