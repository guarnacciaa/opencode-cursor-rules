import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { RuleLoader } from "../src/loader.ts";
import { formatSystemPromptSection, selectRules } from "../src/matcher.ts";
import type { SessionState } from "../src/types.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(TEST_DIR, "fixtures", "integration-test");
const USER_RULES_DIR = join(FIXTURES_DIR, "config", "opencode", "rules");
const PROJECT_DIR = join(FIXTURES_DIR, "project");
const PROJECT_RULES_DIR = join(PROJECT_DIR, ".opencode", "rules");
const CURSOR_RULES_DIR = join(PROJECT_DIR, ".cursor", "rules");
const LEGACY_FILE = join(PROJECT_DIR, ".cursorrules");

function createDir(dir: string) {
  mkdirSync(dir, { recursive: true });
}

function writeRule(dir: string, name: string, content: string) {
  writeFileSync(join(dir, name), content, "utf-8");
}

describe("Integration: Full Pipeline", () => {
  let loader: RuleLoader;

  beforeEach(() => {
    loader = new RuleLoader();
    rmSync(FIXTURES_DIR, { recursive: true, force: true });
    createDir(USER_RULES_DIR);
    createDir(PROJECT_RULES_DIR);
  });

  afterEach(() => {
    rmSync(FIXTURES_DIR, { recursive: true, force: true });
  });

  test("end-to-end: three-tier rule categorization", async () => {
    // Always-apply rule (user level)
    writeRule(
      USER_RULES_DIR,
      "bun-preference.mdc",
      `---
description: "Use Bun instead of Node.js"
alwaysApply: true
---

Default to using Bun for all tasks.
- Use \`bun test\` instead of jest
- Use \`bun run\` instead of npm run`,
    );

    // Glob rule (project level) — should go to suggested
    writeRule(
      PROJECT_RULES_DIR,
      "typescript-standards.mdc",
      `---
description: "TypeScript coding standards"
globs: "*.ts, *.tsx"
---

Use strict TypeScript. Prefer interfaces over types.`,
    );

    // Glob rule (project level) — should go to suggested
    writeRule(
      PROJECT_RULES_DIR,
      "react-patterns.mdc",
      `---
description: "React component best practices"
globs: "*.tsx, src/components/**"
---

Use functional components with hooks.`,
    );

    // Description-only rule — should go to available
    writeRule(
      PROJECT_RULES_DIR,
      "api-design.mdc",
      `---
description: "REST API design guidelines"
---

Use proper HTTP methods. Version your APIs.`,
    );

    // Manual rule (no frontmatter) — should not appear unless @-mentioned
    writeRule(
      PROJECT_RULES_DIR,
      "migration-guide.mdc",
      `# Legacy Migration Guide

When refactoring from v1 to v2:
1. Replace old hooks with new ones
2. Update import paths`,
    );

    const rules = await loader.loadAll(USER_RULES_DIR, PROJECT_RULES_DIR, null);
    assert.strictEqual(rules.length, 5);

    const session: SessionState = {
      filePaths: new Set(["src/utils/helpers.ts", "src/components/Button.tsx"]),
      lastUserMessage: "Help me refactor this component",
    };

    const { injected, suggested, available } = selectRules(rules, session);

    // bun-preference: always-apply → injected (full content)
    assert.notStrictEqual(
      injected.find((m) => m.rule.name === "bun-preference"),
      undefined,
    );

    // typescript-standards: globs match *.ts → suggested (path only)
    assert.notStrictEqual(
      suggested.find((m) => m.rule.name === "typescript-standards"),
      undefined,
    );

    // react-patterns: globs match *.tsx → suggested (path only)
    assert.notStrictEqual(
      suggested.find((m) => m.rule.name === "react-patterns"),
      undefined,
    );

    // api-design: description only → available (path only)
    assert.notStrictEqual(
      available.find((r) => r.name === "api-design"),
      undefined,
    );

    // migration-guide: no frontmatter → nowhere (not @-mentioned)
    assert.strictEqual(
      injected.find((m) => m.rule.name === "migration-guide"),
      undefined,
    );
    assert.strictEqual(
      suggested.find((m) => m.rule.name === "migration-guide"),
      undefined,
    );
    assert.strictEqual(
      available.find((r) => r.name === "migration-guide"),
      undefined,
    );

    // Format system prompt
    const prompt = formatSystemPromptSection(injected, suggested, available);
    assert.ok(prompt.includes("<rules>"));
    // Only always-apply content is inline
    assert.ok(prompt.includes("Bun"));
    // Glob-matched rules show as suggested with paths
    assert.ok(prompt.includes("<suggested_rules"));
    assert.ok(prompt.includes("typescript-standards"));
    assert.ok(prompt.includes(".mdc"));
    // Available rules show descriptions with paths
    assert.ok(prompt.includes("<available_rules"));
    assert.ok(prompt.includes("api-design"));
    // Glob rule content should NOT be inline
    assert.ok(!prompt.includes("Use strict TypeScript"));
    assert.ok(!prompt.includes("functional components"));
  });

  test("@-mention triggers manual rule injection with full content", async () => {
    writeRule(
      PROJECT_RULES_DIR,
      "migration-guide.mdc",
      `# Migration Guide

Replace v1 APIs with v2 equivalents.`,
    );

    const rules = await loader.loadAll(null, PROJECT_RULES_DIR, null);

    const session: SessionState = {
      filePaths: new Set(),
      lastUserMessage: "Apply @migration-guide to this file",
    };

    const { injected } = selectRules(rules, session);
    assert.strictEqual(injected.length, 1);
    assert.strictEqual(injected[0]?.rule.name, "migration-guide");

    // @-mentioned rules get full content injected
    const prompt = formatSystemPromptSection(injected, [], []);
    assert.ok(prompt.includes("Replace v1 APIs with v2 equivalents."));
  });

  test("symlinked .cursor/rules directory works end-to-end", async () => {
    createDir(CURSOR_RULES_DIR);
    writeRule(
      CURSOR_RULES_DIR,
      "cursor-rule.mdc",
      `---
description: "Cursor rule via symlink"
alwaysApply: true
---

This rule comes from .cursor/rules via symlink.`,
    );

    // Symlink .opencode/rules → .cursor/rules
    rmSync(PROJECT_RULES_DIR, { recursive: true, force: true });
    symlinkSync(CURSOR_RULES_DIR, PROJECT_RULES_DIR);

    const rules = await loader.loadAll(null, PROJECT_RULES_DIR, null);
    assert.strictEqual(rules.length, 1);
    assert.strictEqual(rules[0]?.name, "cursor-rule");
    assert.strictEqual(rules[0]?.frontmatter.alwaysApply, true);

    const session: SessionState = { filePaths: new Set(), lastUserMessage: "" };
    const { injected } = selectRules(rules, session);
    assert.strictEqual(injected.length, 1);

    const prompt = formatSystemPromptSection(injected, [], []);
    assert.ok(prompt.includes("This rule comes from .cursor/rules via symlink."));
  });

  test("legacy .cursorrules file integrates correctly", async () => {
    writeFileSync(
      LEGACY_FILE,
      `You are a helpful coding assistant.
Always explain your reasoning.
Follow clean code principles.`,
      "utf-8",
    );

    writeRule(
      PROJECT_RULES_DIR,
      "modern-rule.mdc",
      `---
description: "Modern project rule"
alwaysApply: true
---

Use modern patterns.`,
    );

    const rules = await loader.loadAll(null, PROJECT_RULES_DIR, LEGACY_FILE);
    assert.strictEqual(rules.length, 2);

    const session: SessionState = { filePaths: new Set(), lastUserMessage: "" };
    const { injected } = selectRules(rules, session);

    // Both should be always-apply → injected
    assert.strictEqual(injected.length, 2);
    assert.ok(injected.map((m) => m.rule.name).includes("modern-rule"));
    assert.ok(injected.map((m) => m.rule.name).includes(".cursorrules"));
  });

  test("project rules override user rules on name collision", async () => {
    writeRule(
      USER_RULES_DIR,
      "coding-style.mdc",
      `---
description: "User coding style"
alwaysApply: true
---

User preferences.`,
    );

    writeRule(
      PROJECT_RULES_DIR,
      "coding-style.mdc",
      `---
description: "Project coding style"
alwaysApply: true
---

Project-specific preferences.`,
    );

    const rules = await loader.loadAll(USER_RULES_DIR, PROJECT_RULES_DIR, null);
    assert.strictEqual(rules.length, 1);
    assert.strictEqual(rules[0]?.source, "project");
    assert.strictEqual(rules[0]?.body.trim(), "Project-specific preferences.");
  });

  test("suggested rules include correct file paths with .mdc extension", async () => {
    writeRule(
      PROJECT_RULES_DIR,
      "my-rule.mdc",
      `---
description: "A glob rule"
globs: "*.ts"
---

Rule content.`,
    );

    const rules = await loader.loadAll(null, PROJECT_RULES_DIR, null);
    const session: SessionState = {
      filePaths: new Set(["app.ts"]),
      lastUserMessage: "",
    };

    const { suggested } = selectRules(rules, session);
    assert.strictEqual(suggested.length, 1);

    // The sourcePath must have .mdc extension
    assert.ok(suggested[0]?.rule.sourcePath.endsWith(".mdc"));

    // Formatted output must include the actual .mdc path
    const prompt = formatSystemPromptSection([], suggested, []);
    assert.ok(prompt.includes("my-rule.mdc"));
    assert.ok(prompt.includes("Path:"));
  });

  test("performance: loads 50 rules under 100ms", async () => {
    for (let i = 0; i < 50; i++) {
      writeRule(
        PROJECT_RULES_DIR,
        `rule-${i}.mdc`,
        `---
description: "Rule number ${i}"
globs: "*.ts"
alwaysApply: ${i < 5}
---

Rule ${i} content with some text to simulate real rules.`,
      );
    }

    const start = performance.now();
    const rules = await loader.loadAll(null, PROJECT_RULES_DIR, null);
    const elapsed = performance.now() - start;

    assert.strictEqual(rules.length, 50);
    assert.ok(elapsed < 100);

    // Second load should be even faster (cached)
    const start2 = performance.now();
    await loader.loadAll(null, PROJECT_RULES_DIR, null);
    const elapsed2 = performance.now() - start2;

    assert.ok(elapsed2 < 50);
  });

  test("performance: rule selection with many files is fast", async () => {
    for (let i = 0; i < 20; i++) {
      writeRule(
        PROJECT_RULES_DIR,
        `rule-${i}.mdc`,
        `---
globs: "src/**/*.ts, lib/**/*.ts, test/**/*.ts"
---
Rule ${i} content.`,
      );
    }

    const rules = await loader.loadAll(null, PROJECT_RULES_DIR, null);

    const filePaths = new Set<string>();
    for (let i = 0; i < 100; i++) {
      filePaths.add(`src/module-${i}/index.ts`);
    }

    const session: SessionState = { filePaths, lastUserMessage: "" };

    const start = performance.now();
    const { suggested } = selectRules(rules, session);
    const elapsed = performance.now() - start;

    assert.strictEqual(suggested.length, 20); // All should match
    assert.ok(elapsed < 50);
  });
});
