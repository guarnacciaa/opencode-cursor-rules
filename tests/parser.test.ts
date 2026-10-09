import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseMdc } from "../src/parser.ts";

describe("parseMdc", () => {
  describe("frontmatter extraction", () => {
    test("parses valid frontmatter with all fields", () => {
      const raw = `---
description: "TypeScript coding standards"
globs: "*.ts, *.tsx"
alwaysApply: true
---

Use strict TypeScript mode.`;

      const result = parseMdc(raw);

      assert.strictEqual(result.frontmatter.description, "TypeScript coding standards");
      assert.deepStrictEqual(result.frontmatter.globs, ["*.ts", "*.tsx"]);
      assert.strictEqual(result.frontmatter.alwaysApply, true);
      assert.strictEqual(result.body.trim(), "Use strict TypeScript mode.");
    });

    test("returns defaults when no frontmatter present", () => {
      const raw = "Just some markdown content.\nWith multiple lines.";
      const result = parseMdc(raw);

      assert.strictEqual(result.frontmatter.description, undefined);
      assert.deepStrictEqual(result.frontmatter.globs, []);
      assert.strictEqual(result.frontmatter.alwaysApply, false);
      assert.strictEqual(result.body, raw);
    });

    test("handles empty frontmatter", () => {
      const raw = `---
---
Body content here.`;

      const result = parseMdc(raw);

      assert.strictEqual(result.frontmatter.description, undefined);
      assert.deepStrictEqual(result.frontmatter.globs, []);
      assert.strictEqual(result.frontmatter.alwaysApply, false);
      assert.strictEqual(result.body.trim(), "Body content here.");
    });

    test("handles empty string input", () => {
      const result = parseMdc("");

      assert.deepStrictEqual(result.frontmatter.globs, []);
      assert.strictEqual(result.frontmatter.alwaysApply, false);
      assert.strictEqual(result.body, "");
    });

    test("handles malformed YAML gracefully", () => {
      const raw = `---
description: [invalid yaml: {
globs: missing: colon
---

Body content.`;

      const result = parseMdc(raw);

      // Should treat as no frontmatter
      assert.deepStrictEqual(result.frontmatter.globs, []);
      assert.strictEqual(result.frontmatter.alwaysApply, false);
      assert.strictEqual(result.body, raw);
    });

    test("preserves body content after frontmatter exactly", () => {
      const body = `# Title

Some content with **markdown**.

\`\`\`ts
const x = 1;
\`\`\`
`;
      const raw = `---
description: test
---
${body}`;

      const result = parseMdc(raw);
      assert.strictEqual(result.body, body);
    });
  });

  describe("globs normalization", () => {
    test("splits comma-separated string into array", () => {
      const raw = `---
globs: "*.ts, *.tsx, src/**/*.js"
---
body`;

      const result = parseMdc(raw);
      assert.deepStrictEqual(result.frontmatter.globs, ["*.ts", "*.tsx", "src/**/*.js"]);
    });

    test("handles array format", () => {
      const raw = `---
globs:
  - "*.ts"
  - "*.tsx"
---
body`;

      const result = parseMdc(raw);
      assert.deepStrictEqual(result.frontmatter.globs, ["*.ts", "*.tsx"]);
    });

    test("handles single string glob (no commas)", () => {
      const raw = `---
globs: "**/*.test.ts"
---
body`;

      const result = parseMdc(raw);
      assert.deepStrictEqual(result.frontmatter.globs, ["**/*.test.ts"]);
    });

    test("trims whitespace from globs", () => {
      const raw = `---
globs: "  *.ts ,  *.tsx  "
---
body`;

      const result = parseMdc(raw);
      assert.deepStrictEqual(result.frontmatter.globs, ["*.ts", "*.tsx"]);
    });

    test("filters empty strings from globs", () => {
      const raw = `---
globs: "*.ts, , *.tsx, "
---
body`;

      const result = parseMdc(raw);
      assert.deepStrictEqual(result.frontmatter.globs, ["*.ts", "*.tsx"]);
    });

    test("returns empty array for null/undefined globs", () => {
      const raw = `---
description: test
---
body`;

      const result = parseMdc(raw);
      assert.deepStrictEqual(result.frontmatter.globs, []);
    });

    test("returns empty array for invalid globs type", () => {
      const raw = `---
globs: 42
---
body`;

      const result = parseMdc(raw);
      assert.deepStrictEqual(result.frontmatter.globs, []);
    });
  });

  describe("alwaysApply normalization", () => {
    test("handles true boolean", () => {
      const raw = `---
alwaysApply: true
---
body`;
      assert.strictEqual(parseMdc(raw).frontmatter.alwaysApply, true);
    });

    test("handles false boolean", () => {
      const raw = `---
alwaysApply: false
---
body`;
      assert.strictEqual(parseMdc(raw).frontmatter.alwaysApply, false);
    });

    test("defaults to false when missing", () => {
      const raw = `---
description: test
---
body`;
      assert.strictEqual(parseMdc(raw).frontmatter.alwaysApply, false);
    });

    test("handles string 'true'", () => {
      const raw = `---
alwaysApply: "true"
---
body`;
      assert.strictEqual(parseMdc(raw).frontmatter.alwaysApply, true);
    });

    test("handles string 'false'", () => {
      const raw = `---
alwaysApply: "false"
---
body`;
      assert.strictEqual(parseMdc(raw).frontmatter.alwaysApply, false);
    });
  });

  describe("description normalization", () => {
    test("handles valid string description", () => {
      const raw = `---
description: "A helpful rule"
---
body`;
      assert.strictEqual(parseMdc(raw).frontmatter.description, "A helpful rule");
    });

    test("returns undefined for empty string", () => {
      const raw = `---
description: ""
---
body`;
      assert.strictEqual(parseMdc(raw).frontmatter.description, undefined);
    });

    test("coerces number to string", () => {
      const raw = `---
description: 42
---
body`;
      assert.strictEqual(parseMdc(raw).frontmatter.description, "42");
    });

    test("returns undefined when not present", () => {
      const raw = `---
globs: "*.ts"
---
body`;
      assert.strictEqual(parseMdc(raw).frontmatter.description, undefined);
    });
  });

  describe("edge cases", () => {
    test("handles Windows-style line endings (CRLF)", () => {
      const raw = '---\r\ndescription: test\r\nglobs: "*.ts"\r\n---\r\nBody content.';
      const result = parseMdc(raw);

      assert.strictEqual(result.frontmatter.description, "test");
      assert.deepStrictEqual(result.frontmatter.globs, ["*.ts"]);
      assert.strictEqual(result.body.trim(), "Body content.");
    });

    test("handles frontmatter with extra whitespace", () => {
      const raw = `---
description:   "  spaced description  "  
globs: "*.ts"
---
body`;

      const result = parseMdc(raw);
      assert.strictEqual(result.frontmatter.description, "  spaced description  ");
    });

    test("handles body with --- in content (not frontmatter)", () => {
      const raw = `---
description: test
---

Some content.

---

More content after horizontal rule.`;

      const result = parseMdc(raw);
      assert.strictEqual(result.frontmatter.description, "test");
      assert.ok(result.body.includes("---"));
      assert.ok(result.body.includes("More content after horizontal rule."));
    });

    test("handles very long content efficiently", () => {
      const longBody = "x".repeat(100_000);
      const raw = `---
description: big rule
---
${longBody}`;

      const start = performance.now();
      const result = parseMdc(raw);
      const elapsed = performance.now() - start;

      assert.strictEqual(result.frontmatter.description, "big rule");
      assert.strictEqual(result.body.trim().length, 100_000);
      assert.ok(elapsed < 50); // Should be very fast
    });

    test("handles content that looks like frontmatter but isn't at the start", () => {
      const raw = `Some text first.

---
description: not frontmatter
---

More text.`;

      const result = parseMdc(raw);
      assert.strictEqual(result.frontmatter.description, undefined);
      assert.strictEqual(result.body, raw);
    });
  });
});
