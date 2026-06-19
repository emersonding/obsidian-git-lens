import { describe, it, expect } from "vitest";
import { parseDiff } from "./diffParse";

// A typical `git show` for a single modified file.
const SINGLE = `commit a1b2c3d4
Author: Ada <ada@x.com>
Date:   Mon Jan 1 00:00:00 2024 +0000

    edit a

diff --git a/notes/a.md b/notes/a.md
index e69de29..d95f3ad 100644
--- a/notes/a.md
+++ b/notes/a.md
@@ -1 +1,2 @@
 v1
+v2
`;

// A directory commit touching several files: add, delete, rename.
const MULTI = `commit deadbeef

diff --git a/added.md b/added.md
new file mode 100644
index 0000000..3b18e51
--- /dev/null
+++ b/added.md
@@ -0,0 +1 @@
+hello
diff --git a/gone.md b/gone.md
deleted file mode 100644
index 9daeafb..0000000
--- a/gone.md
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/old.md b/new.md
similarity index 100%
rename from old.md
rename to new.md
diff --git a/pic.png b/pic.png
index 1111111..2222222 100644
Binary files a/pic.png and b/pic.png differ
`;

describe("parseDiff", () => {
  it("separates the commit preamble from the file section", () => {
    const { preamble, files } = parseDiff(SINGLE);
    expect(preamble.join("\n")).toContain("Author: Ada");
    expect(preamble.join("\n")).toContain("edit a");
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("notes/a.md");
    expect(files[0].kind).toBe("modified");
  });

  it("keeps only hunk/content lines in the body, never the plumbing", () => {
    const [file] = parseDiff(SINGLE).files;
    expect(file.body).toEqual(["@@ -1 +1,2 @@", " v1", "+v2", ""]);
    // None of the noisy headers leak through.
    for (const noise of ["diff --git", "index ", "--- ", "+++ "]) {
      expect(file.body.some((l) => l.startsWith(noise))).toBe(false);
    }
  });

  it("classifies added / deleted / renamed / binary files", () => {
    const { files } = parseDiff(MULTI);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath["added.md"].kind).toBe("added");
    expect(byPath["gone.md"].kind).toBe("deleted");
    expect(byPath["new.md"].kind).toBe("renamed");
    expect(byPath["new.md"].oldPath).toBe("old.md");
    expect(byPath["pic.png"].kind).toBe("binary");
  });

  it("does not label a non-renaming file with an oldPath", () => {
    const [file] = parseDiff(SINGLE).files;
    expect(file.oldPath).toBeUndefined();
  });

  it("returns no files for non-diff text", () => {
    expect(parseDiff("just a message\nno diff here").files).toEqual([]);
  });
});
