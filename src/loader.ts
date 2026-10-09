import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseMdc } from "./parser.ts";
import type { CacheEntry, Rule, RuleSource } from "./types.ts";

/** Rule file extensions recognized by the loader. */
const RULE_EXTENSIONS = new Set([".mdc", ".md"]);

/**
 * RuleLoader discovers and caches rules from disk.
 *
 * Uses mtime+size based cache invalidation: on each load, files are stat'd
 * and only re-parsed if mtime or size has changed. No file watchers needed.
 *
 * Runtime-agnostic: only Node.js builtins are used, so the loader works
 * under Node, Bun, and any OpenCode v2 host runtime.
 */
export class RuleLoader {
  private cache = new Map<string, CacheEntry>();

  /**
   * Load all rules from both user-level and project-level directories.
   *
   * @param userRulesDir    Absolute path to user rules (e.g. ~/.config/opencode/rules)
   * @param projectRulesDir Absolute path to project rules (e.g. <worktree>/.opencode/rules)
   * @param legacyFilePath  Absolute path to legacy .cursorrules file (optional)
   * @returns Array of rules, project rules taking precedence over user rules
   */
  async loadAll(
    userRulesDir: string | null,
    projectRulesDir: string | null,
    legacyFilePath: string | null,
  ): Promise<Rule[]> {
    const rulesByName = new Map<string, Rule>();

    // User rules loaded first (lower priority)
    if (userRulesDir) {
      const userRules = await this.loadFromDirectory(userRulesDir, "user");
      for (const rule of userRules) {
        rulesByName.set(rule.name, rule);
      }
    }

    // Project rules loaded second (higher priority, overrides user)
    if (projectRulesDir) {
      const projectRules = await this.loadFromDirectory(projectRulesDir, "project");
      for (const rule of projectRules) {
        rulesByName.set(rule.name, rule);
      }
    }

    // Legacy .cursorrules (always-apply, won't override named rules)
    if (legacyFilePath) {
      const legacyRule = await this.loadLegacyFile(legacyFilePath);
      if (legacyRule && !rulesByName.has(legacyRule.name)) {
        rulesByName.set(legacyRule.name, legacyRule);
      }
    }

    this.evictStaleEntries();
    return Array.from(rulesByName.values());
  }

  /**
   * Scan a directory for .mdc and .md rule files, parse them with caching.
   */
  private async loadFromDirectory(dir: string, source: RuleSource): Promise<Rule[]> {
    const rules: Rule[] = [];

    let files: string[];
    try {
      files = await this.scanRuleFiles(dir);
    } catch {
      // Directory doesn't exist or isn't readable
      return rules;
    }

    for (const filePath of files) {
      const rule = await this.loadSingleFile(filePath, source);
      if (rule) {
        rules.push(rule);
      }
    }

    return rules;
  }

  /**
   * Scan a directory for top-level .mdc and .md files.
   * Follows symlinks (both file and directory level).
   */
  private async scanRuleFiles(dir: string): Promise<string[]> {
    let entries: Dirent[];
    try {
      const s = await stat(dir);
      if (!s.isDirectory()) return [];
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const paths: string[] = [];
    for (const entry of entries) {
      // Skip hidden files and subdirectories (rules live at the top level)
      if (entry.name.startsWith(".")) continue;
      if (!(entry.isFile() || entry.isSymbolicLink())) continue;
      const dotIdx = entry.name.lastIndexOf(".");
      const ext = dotIdx > 0 ? entry.name.slice(dotIdx).toLowerCase() : "";
      if (!RULE_EXTENSIONS.has(ext)) continue;
      paths.push(join(dir, entry.name));
    }

    return paths.sort();
  }

  /**
   * Load a single rule file with mtime+size based caching.
   */
  private async loadSingleFile(filePath: string, source: RuleSource): Promise<Rule | null> {
    let mtimeMs: number;
    let size: number;
    try {
      const s = await stat(filePath);
      if (!s.isFile()) {
        this.cache.delete(filePath);
        return null;
      }
      mtimeMs = s.mtimeMs;
      size = s.size;
    } catch {
      // File doesn't exist or broken symlink
      this.cache.delete(filePath);
      return null;
    }

    // Check cache (mtime + size guard against coarse timestamp resolution)
    const cached = this.cache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      if (cached.source === source) return cached.rule;
    }

    // Parse file
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch {
      this.cache.delete(filePath);
      return null;
    }

    if (raw.length === 0) {
      this.cache.delete(filePath);
      return null;
    }

    const { frontmatter, body } = parseMdc(raw);
    const name = deriveRuleName(filePath);

    const rule: Rule = {
      name,
      sourcePath: filePath,
      source,
      frontmatter,
      body,
    };

    this.cache.set(filePath, { rule, mtimeMs, size, source });
    return rule;
  }

  /**
   * Load legacy .cursorrules flat file (always-apply, no frontmatter).
   */
  private async loadLegacyFile(filePath: string): Promise<Rule | null> {
    let mtimeMs: number;
    let size: number;
    try {
      const s = await stat(filePath);
      if (!s.isFile()) return null;
      mtimeMs = s.mtimeMs;
      size = s.size;
    } catch {
      return null;
    }

    const cached = this.cache.get(filePath);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      return cached.rule;
    }

    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch {
      return null;
    }

    if (raw.length === 0) return null;

    const rule: Rule = {
      name: ".cursorrules",
      sourcePath: filePath,
      source: "legacy",
      frontmatter: {
        globs: [],
        alwaysApply: true,
      },
      body: raw,
    };

    this.cache.set(filePath, { rule, mtimeMs, size, source: "legacy" });
    return rule;
  }

  /**
   * Drop cache entries whose files no longer exist or are no longer files.
   * Keeps memory bounded when rules are deleted between loads.
   */
  private evictStaleEntries(): void {
    if (this.cache.size === 0) return;
    const paths = Array.from(this.cache.keys());
    void Promise.all(
      paths.map(async (filePath) => {
        try {
          const s = await stat(filePath);
          if (!s.isFile()) this.cache.delete(filePath);
        } catch {
          this.cache.delete(filePath);
        }
      }),
    );
  }

  /**
   * Clear the entire cache. Useful for testing or forced reload.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get current cache size (for diagnostics).
   */
  get cacheSize(): number {
    return this.cache.size;
  }
}

/**
 * Derive rule name from file path: strip extension and directory.
 * e.g. "/path/to/typescript-standards.mdc" → "typescript-standards"
 */
function deriveRuleName(filePath: string): string {
  const base = basename(filePath);
  const dotIdx = base.lastIndexOf(".");
  return dotIdx > 0 ? base.slice(0, dotIdx) : base;
}
