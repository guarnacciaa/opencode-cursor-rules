import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { RuleLoader } from "../src/loader.ts";
import { parseMdc } from "../src/parser.ts";
import {
  createProjectRule,
  createUserRule,
  getProjectRulesDir,
  getUserRulesDir,
  listRules,
} from "../src/tools.ts";
import type { Rule } from "../src/types.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(TEST_DIR, "fixtures", "tools-test");
const TEST_USER_RULES = join(FIXTURES_DIR, "user-rules");
const TEST_PROJECT_RULES = join(FIXTURES_DIR, "project-rules");

// Store original env var
let originalXdgConfigHome: string | undefined;

describe("tools", () => {
  beforeEach(() => {
    // Store original XDG_CONFIG_HOME
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    // Hermetic XDG: point user rules into fixtures, never the real home dir
    process.env.XDG_CONFIG_HOME = join(FIXTURES_DIR, "config");

    // Clean up and create test directories
    rmSync(FIXTURES_DIR, { recursive: true, force: true });
    mkdirSync(TEST_USER_RULES, { recursive: true });
    mkdirSync(TEST_PROJECT_RULES, { recursive: true });
  });

  afterEach(() => {
    // Restore original env var
    if (originalXdgConfigHome !== undefined) {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    } else {
      delete process.env.XDG_CONFIG_HOME;
    }

    // Clean up test fixtures
    rmSync(FIXTURES_DIR, { recursive: true, force: true });
  });

  describe("createUserRule", () => {
    test("creates a user-level rule file with correct content", async () => {
      const result = await createUserRule(
        "test-rule",
        "Test rule description",
        "This is the rule content.",
        ["**/*.ts"],
        false,
      );

      assert.strictEqual(result.success, true);
      assert.notStrictEqual(result.filePath, undefined);
      assert.ok(result.filePath?.endsWith("test-rule.mdc"));
      assert.ok(existsSync(result.filePath!));

      const content = readFileSync(result.filePath!, "utf-8");
      assert.ok(content.includes("Test rule description"));
      assert.ok(content.includes("**/*.ts"));
      assert.ok(content.includes("This is the rule content."));
      assert.ok(!content.includes("alwaysApply"));

      const parsed = parseMdc(content);
      assert.strictEqual(parsed.frontmatter.description, "Test rule description");
      assert.deepStrictEqual(parsed.frontmatter.globs, ["**/*.ts"]);
      assert.strictEqual(parsed.frontmatter.alwaysApply, false);
    });

    test("creates rule with alwaysApply set to true", async () => {
      const result = await createUserRule(
        "always-rule",
        "Always apply rule",
        "Always apply content.",
        [],
        true,
      );

      assert.strictEqual(result.success, true);

      const content = readFileSync(result.filePath!, "utf-8");
      assert.ok(content.includes("alwaysApply: true"));

      const parsed = parseMdc(content);
      assert.strictEqual(parsed.frontmatter.description, "Always apply rule");
      assert.strictEqual(parsed.frontmatter.alwaysApply, true);
    });

    test("creates rule with multiple globs", async () => {
      const result = await createUserRule(
        "multi-glob-rule",
        "Multi glob rule",
        "Content.",
        ["**/*.ts", "**/*.tsx"],
        false,
      );

      assert.strictEqual(result.success, true);

      const content = readFileSync(result.filePath!, "utf-8");
      assert.ok(content.includes("globs:"));
      assert.ok(content.includes("**/*.ts"));
      assert.ok(content.includes("**/*.tsx"));

      const parsed = parseMdc(content);
      assert.deepStrictEqual(parsed.frontmatter.globs, ["**/*.ts", "**/*.tsx"]);
    });

    test("creates rule without globs or alwaysApply", async () => {
      const result = await createUserRule("simple-rule", "Simple rule", "Simple content.");

      assert.strictEqual(result.success, true);

      const content = readFileSync(result.filePath!, "utf-8");
      assert.ok(content.includes("Simple rule"));
      assert.ok(!content.includes("globs"));
      assert.ok(!content.includes("alwaysApply"));

      const parsed = parseMdc(content);
      assert.strictEqual(parsed.frontmatter.description, "Simple rule");
      assert.deepStrictEqual(parsed.frontmatter.globs, []);
      assert.strictEqual(parsed.frontmatter.alwaysApply, false);
    });

    test("sanitizes rule names", async () => {
      const result = await createUserRule("My Special Rule!", "Description", "Content.");

      assert.strictEqual(result.success, true);
      assert.ok(result.filePath?.endsWith("my-special-rule.mdc"));
    });

    test("creates directory if it doesn't exist", async () => {
      // Temporarily mock the user rules dir
      process.env.XDG_CONFIG_HOME = FIXTURES_DIR;

      const result = await createUserRule("deep-rule", "Deep rule", "Content.");

      assert.strictEqual(result.success, true);
      assert.ok(existsSync(result.filePath!));
    });

    test("handles invalid rule names gracefully", async () => {
      process.env.XDG_CONFIG_HOME = FIXTURES_DIR;

      const result = await createUserRule("!!!@@@###$$$", "Invalid rule", "Content");

      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes("Invalid rule name"));
    });

    test("handles file write errors gracefully", async () => {
      // Create a file where we expect a directory - this will cause mkdir to fail
      const blockingPath = join(FIXTURES_DIR, "blocking-file");
      writeFileSync(blockingPath, "blocking content", "utf-8");
      process.env.XDG_CONFIG_HOME = blockingPath;

      const result = await createUserRule("error-test", "Error test", "Content");

      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes("Failed to create user rule"));
    });

    test("sanitizes rule names with special characters", async () => {
      process.env.XDG_CONFIG_HOME = FIXTURES_DIR;

      const result = await createUserRule(
        "My Rule With Spaces & Special@Chars!",
        "Sanitized rule",
        "Content",
      );

      assert.strictEqual(result.success, true);
      assert.ok(result.filePath?.includes("my-rule-with-spaces-specialchars.mdc"));
    });

    test("returns success message with correct rule name", async () => {
      process.env.XDG_CONFIG_HOME = FIXTURES_DIR;

      const result = await createUserRule("success-test", "Success test", "Content");

      assert.strictEqual(result.success, true);
      assert.ok(result.message.includes("Created user-level rule"));
      assert.ok(result.message.includes("success-test"));
      assert.notStrictEqual(result.filePath, undefined);
    });
  });

  describe("createProjectRule", () => {
    test("creates a project-level rule file", async () => {
      const worktree = join(FIXTURES_DIR, "project-worktree");
      const result = await createProjectRule(
        "project-rule",
        "Project rule description",
        "Project content.",
        ["**/*.js"],
        false,
        worktree,
      );

      assert.strictEqual(result.success, true);
      assert.notStrictEqual(result.filePath, undefined);
      assert.ok(result.filePath?.includes(".opencode/rules"));
      assert.ok(result.filePath?.startsWith(worktree));
      assert.ok(existsSync(result.filePath!));

      const content = readFileSync(result.filePath!, "utf-8");
      const parsed = parseMdc(content);
      assert.strictEqual(parsed.frontmatter.description, "Project rule description");
      assert.deepStrictEqual(parsed.frontmatter.globs, ["**/*.js"]);
    });

    test("uses provided worktree directory", async () => {
      const customWorktree = join(FIXTURES_DIR, "custom-project");
      mkdirSync(join(customWorktree, ".opencode", "rules"), {
        recursive: true,
      });

      const result = await createProjectRule(
        "custom-rule",
        "Custom rule",
        "Content.",
        [],
        false,
        customWorktree,
      );

      assert.strictEqual(result.success, true);
      assert.ok(result.filePath?.includes(customWorktree));
    });

    test("creates .opencode/rules/ directory structure if needed", async () => {
      const freshProjectDir = join(FIXTURES_DIR, "fresh-project");
      // Don't create the .opencode/rules directory - let the function do it

      const result = await createProjectRule(
        "auto-dir-rule",
        "Auto dir rule",
        "Content",
        undefined,
        undefined,
        freshProjectDir,
      );

      assert.strictEqual(result.success, true);
      assert.ok(existsSync(join(freshProjectDir, ".opencode", "rules")));
      assert.ok(existsSync(result.filePath!));
    });

    test("sanitizes project rule names correctly", async () => {
      const result = await createProjectRule(
        "My Project Rule!!!",
        "Sanitized project rule",
        "Content",
        undefined,
        undefined,
        FIXTURES_DIR,
      );

      assert.strictEqual(result.success, true);
      assert.ok(result.filePath?.includes("my-project-rule.mdc"));
    });

    test("handles file write errors gracefully for project rules", async () => {
      // Create a file where we expect a directory - this will cause mkdir to fail
      const blockingPath = join(FIXTURES_DIR, "project-blocking");
      writeFileSync(blockingPath, "blocking content", "utf-8");

      const result = await createProjectRule(
        "error-test",
        "Error test",
        "Content",
        undefined,
        undefined,
        blockingPath,
      );

      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes("Failed to create project rule"));
    });

    test("combines globs and alwaysApply for project rules", async () => {
      const result = await createProjectRule(
        "combined-project-rule",
        "Combined rule",
        "Content",
        ["src/**/*.ts", "lib/**/*.ts"],
        true,
        FIXTURES_DIR,
      );

      assert.strictEqual(result.success, true);

      const content = readFileSync(result.filePath!, "utf-8");
      assert.ok(content.includes("globs:"));
      assert.ok(content.includes("src/**/*.ts"));
      assert.ok(content.includes("lib/**/*.ts"));
      assert.ok(content.includes("alwaysApply: true"));
      assert.ok(content.includes("Combined rule"));

      const parsed = parseMdc(content);
      assert.strictEqual(parsed.frontmatter.description, "Combined rule");
      assert.deepStrictEqual(parsed.frontmatter.globs, ["src/**/*.ts", "lib/**/*.ts"]);
      assert.strictEqual(parsed.frontmatter.alwaysApply, true);
    });

    test("returns success message with correct project rule name", async () => {
      const result = await createProjectRule(
        "success-project-rule",
        "Success project rule",
        "Content",
        undefined,
        undefined,
        FIXTURES_DIR,
      );

      assert.strictEqual(result.success, true);
      assert.ok(result.message.includes("Created project-level rule"));
      assert.ok(result.message.includes("success-project-rule"));
    });
  });

  describe("listRules", () => {
    test("returns formatted list of all rules", async () => {
      // Mock the loadAll method to return test rules
      const mockRules: Rule[] = [
        {
          name: "user-rule",
          sourcePath: "/user/rules/user-rule.mdc",
          frontmatter: {
            description: "User rule",
            globs: [],
            alwaysApply: true,
          },
          body: "User content",
          source: "user",
        },
        {
          name: "project-rule",
          sourcePath: "/project/.opencode/rules/project-rule.mdc",
          frontmatter: {
            description: "Project rule",
            globs: ["**/*.ts"],
            alwaysApply: false,
          },
          body: "Project content",
          source: "project",
        },
        {
          name: "agent-rule",
          sourcePath: "/user/rules/agent-rule.mdc",
          frontmatter: {
            description: "Agent rule description",
            globs: [],
            alwaysApply: false,
          },
          body: "Agent content",
          source: "user",
        },
        {
          name: "manual-rule",
          sourcePath: "/user/rules/manual-rule.mdc",
          frontmatter: {
            description: "",
            globs: [],
            alwaysApply: false,
          },
          body: "Manual content",
          source: "user",
        },
      ];

      const mockLoader = {
        loadAll: async (): Promise<Rule[]> => mockRules,
      };

      const result = await listRules(TEST_USER_RULES, TEST_PROJECT_RULES, null, mockLoader);

      assert.strictEqual(result.success, true);
      assert.notStrictEqual(result.rules, undefined);
      assert.strictEqual(result.rules?.length, 4);

      // Check user rules
      const userRules = result.rules?.filter((r) => r.source === "user");
      assert.strictEqual(userRules?.length, 3);

      // Check project rules
      const projectRules = result.rules?.filter((r) => r.source === "project");
      assert.strictEqual(projectRules?.length, 1);

      // Check mode badges
      const alwaysRule = result.rules?.find((r) => r.name === "user-rule");
      assert.ok(alwaysRule?.mode.includes("always"));

      const globRule = result.rules?.find((r) => r.name === "project-rule");
      assert.ok(globRule?.mode.includes("glob"));

      const agentRule = result.rules?.find((r) => r.name === "agent-rule");
      assert.ok(agentRule?.mode.includes("agent"));

      const manualRule = result.rules?.find((r) => r.name === "manual-rule");
      assert.ok(manualRule?.mode.includes("manual"));
    });

    test("handles empty rules list", async () => {
      const mockLoader = {
        loadAll: async (): Promise<Rule[]> => [],
      };

      const result = await listRules(TEST_USER_RULES, TEST_PROJECT_RULES, null, mockLoader);

      assert.strictEqual(result.success, true);
      assert.deepStrictEqual(result.rules, []);
    });

    test("handles loader errors", async () => {
      const mockLoader = {
        loadAll: async (): Promise<Rule[]> => {
          throw new Error("Loader failed");
        },
      };

      const result = await listRules(TEST_USER_RULES, TEST_PROJECT_RULES, null, mockLoader);

      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes("Failed to list rules"));
    });

    test("groups rules by source with real loader (user, project, legacy)", async () => {
      const realLoader = new RuleLoader();

      // Create user rules directory and rule
      const userRulesDir = join(FIXTURES_DIR, "real-user", "opencode", "rules");
      mkdirSync(userRulesDir, { recursive: true });
      writeFileSync(
        join(userRulesDir, "user-rule.mdc"),
        `---
description: "User rule"
---
User content.`,
      );

      // Create project rules directory and rule
      const projectRulesDir = join(FIXTURES_DIR, "real-project", ".opencode", "rules");
      mkdirSync(projectRulesDir, { recursive: true });
      writeFileSync(
        join(projectRulesDir, "project-rule.mdc"),
        `---
description: "Project rule"
---
Project content.`,
      );

      // Create legacy file
      const legacyFile = join(FIXTURES_DIR, "real-legacy", ".cursorrules");
      mkdirSync(join(FIXTURES_DIR, "real-legacy"), { recursive: true });
      writeFileSync(legacyFile, "Legacy rules content");

      const result = await listRules(userRulesDir, projectRulesDir, legacyFile, realLoader);

      assert.strictEqual(result.success, true);
      assert.notStrictEqual(result.rules, undefined);
      assert.strictEqual(result.rules?.length, 3);

      const rules = result.rules!;
      // Verify order: user first, then project, then legacy
      assert.ok(rules.length >= 3);
      assert.strictEqual(rules[0]?.source, "user");
      assert.strictEqual(rules[0]?.name, "user-rule");

      assert.strictEqual(rules[1]?.source, "project");
      assert.strictEqual(rules[1]?.name, "project-rule");

      assert.strictEqual(rules[2]?.source, "legacy");
      assert.strictEqual(rules[2]?.name, ".cursorrules");
    });

    test("correctly identifies all mode badges with real loader", async () => {
      const realLoader = new RuleLoader();
      const rulesDir = join(FIXTURES_DIR, "modes-test", ".opencode", "rules");
      mkdirSync(rulesDir, { recursive: true });

      // Always mode
      writeFileSync(
        join(rulesDir, "always-rule.mdc"),
        `---
description: "Always rule"
alwaysApply: true
---
Always content.`,
      );

      // Glob mode
      writeFileSync(
        join(rulesDir, "glob-rule.mdc"),
        `---
description: "Glob rule"
globs: "*.ts"
---
Glob content.`,
      );

      // Agent mode (description only)
      writeFileSync(
        join(rulesDir, "agent-rule.mdc"),
        `---
description: "Agent rule"
---
Agent content.`,
      );

      // Manual mode (no frontmatter)
      writeFileSync(
        join(rulesDir, "manual-rule.mdc"),
        `---
---
Manual content.`,
      );

      const result = await listRules("", rulesDir, null, realLoader);

      assert.strictEqual(result.success, true);
      assert.notStrictEqual(result.rules, undefined);
      assert.strictEqual(result.rules?.length, 4);

      const rules = result.rules!;
      const alwaysRule = rules.find((r) => r.name === "always-rule");
      const globRule = rules.find((r) => r.name === "glob-rule");
      const agentRule = rules.find((r) => r.name === "agent-rule");
      const manualRule = rules.find((r) => r.name === "manual-rule");

      assert.notStrictEqual(alwaysRule, undefined);
      assert.strictEqual(alwaysRule?.mode, "always");
      assert.strictEqual(alwaysRule?.alwaysApply, true);

      assert.notStrictEqual(globRule, undefined);
      assert.strictEqual(globRule?.mode, "glob");
      assert.deepStrictEqual(globRule?.globs, ["*.ts"]);

      assert.notStrictEqual(agentRule, undefined);
      assert.strictEqual(agentRule?.mode, "agent");
      assert.strictEqual(agentRule?.description, "Agent rule");

      assert.notStrictEqual(manualRule, undefined);
      assert.strictEqual(manualRule?.mode, "manual");
    });

    test("correctly handles multiple globs with real loader", async () => {
      const realLoader = new RuleLoader();
      const rulesDir = join(FIXTURES_DIR, "multiglob-test", ".opencode", "rules");
      mkdirSync(rulesDir, { recursive: true });

      writeFileSync(
        join(rulesDir, "multiglob-rule.mdc"),
        `---
description: "Multi glob rule"
globs:
  - "*.ts"
  - "*.tsx"
  - "*.js"
---
Multi glob content.`,
      );

      const result = await listRules("", rulesDir, null, realLoader);

      assert.strictEqual(result.success, true);
      assert.notStrictEqual(result.rules, undefined);
      assert.strictEqual(result.rules?.length, 1);

      const rule = result.rules?.[0]!;
      assert.strictEqual(rule.name, "multiglob-rule");
      assert.strictEqual(rule.mode, "glob");
      assert.deepStrictEqual(rule.globs, ["*.ts", "*.tsx", "*.js"]);
    });

    test("includes correct file paths in output", async () => {
      const realLoader = new RuleLoader();
      const rulesDir = join(FIXTURES_DIR, "paths-test", ".opencode", "rules");
      mkdirSync(rulesDir, { recursive: true });

      writeFileSync(
        join(rulesDir, "path-test-rule.mdc"),
        `---
description: "Path test rule"
---
Content.`,
      );

      const result = await listRules("", rulesDir, null, realLoader);

      assert.strictEqual(result.success, true);
      assert.notStrictEqual(result.rules, undefined);
      assert.strictEqual(result.rules?.length, 1);

      const rule = result.rules?.[0]!;
      assert.ok(rule.filePath.includes("path-test-rule.mdc"));
      assert.ok(rule.filePath.includes("paths-test"));
    });

    test("handles legacy .cursorrules file correctly", async () => {
      const realLoader = new RuleLoader();
      const legacyDir = join(FIXTURES_DIR, "legacy-test");
      mkdirSync(legacyDir, { recursive: true });

      const legacyFile = join(legacyDir, ".cursorrules");
      writeFileSync(legacyFile, "Legacy cursor rules content line 1\nLine 2\nLine 3");

      const result = await listRules("", "", legacyFile, realLoader);

      assert.strictEqual(result.success, true);
      assert.notStrictEqual(result.rules, undefined);
      assert.strictEqual(result.rules?.length, 1);

      const legacyRule = result.rules?.[0]!;
      assert.strictEqual(legacyRule.name, ".cursorrules");
      assert.strictEqual(legacyRule.source, "legacy");
      assert.strictEqual(legacyRule.mode, "always");
      assert.strictEqual(legacyRule.alwaysApply, true);
      assert.deepStrictEqual(legacyRule.globs, []);
      assert.strictEqual(legacyRule.filePath, legacyFile);
    });
  });

  describe("getUserRulesDir", () => {
    test("returns default path when XDG_CONFIG_HOME not set", () => {
      const originalEnv = process.env.XDG_CONFIG_HOME;
      delete process.env.XDG_CONFIG_HOME;

      try {
        const dir = getUserRulesDir();
        assert.ok(dir.includes(".config/opencode/rules"));
      } finally {
        if (originalEnv) {
          process.env.XDG_CONFIG_HOME = originalEnv;
        }
      }
    });

    test("respects XDG_CONFIG_HOME", () => {
      const originalEnv = process.env.XDG_CONFIG_HOME;
      process.env.XDG_CONFIG_HOME = "/custom/config";

      try {
        const dir = getUserRulesDir();
        assert.strictEqual(dir, "/custom/config/opencode/rules");
      } finally {
        if (originalEnv) {
          process.env.XDG_CONFIG_HOME = originalEnv;
        } else {
          delete process.env.XDG_CONFIG_HOME;
        }
      }
    });
  });

  describe("getProjectRulesDir", () => {
    test("returns default path in current directory", () => {
      const dir = getProjectRulesDir();
      assert.ok(dir.includes(".opencode/rules"));
    });

    test("uses provided worktree", () => {
      const dir = getProjectRulesDir("/custom/project");
      assert.strictEqual(dir, "/custom/project/.opencode/rules");
    });
  });
});
