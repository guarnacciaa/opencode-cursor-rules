import { homedir } from "node:os";
import { join } from "node:path";
import { Plugin } from "@opencode/plugin/effect";
import { Effect, Schema } from "effect";
import { RuleLoader } from "./src/loader.ts";
import { formatSystemPromptSection, selectRules } from "./src/matcher.ts";
import { createProjectRule, createUserRule, listRules } from "./src/tools.ts";
import type { SessionState } from "./src/types.ts";

const PLUGIN_ID = "cursor-rules";
const DEFAULT_MAX_SESSIONS = 100;

/** File-path argument names observed across OpenCode tools. */
const FILE_PATH_KEYS = ["path", "file_path", "filePath", "file", "target"] as const;
/** Pattern/directory argument names that carry location context. */
const LOCATION_KEYS = ["pattern", "glob", "directory", "dir", "cwd"] as const;

/**
 * OpenCode v2 plugin that brings full Cursor rules (.mdc) support to OpenCode.
 *
 * Reads rules from:
 * - User level:    ~/.config/opencode/rules/
 * - Project level: <project>/.opencode/rules/
 * - Legacy:        <project>/.cursorrules
 *
 * Supports all four Cursor rule modes:
 * - Always apply (alwaysApply: true)
 * - Auto-attach via glob patterns
 * - Agent-requested via description
 * - Manual via @rule-name mention
 *
 * Optional plugin options (via `plugins: [{ package, options }]`):
 * - userRulesDir:    override the user rules directory
 * - projectRulesDir: override the project rules directory
 * - legacyFilePath:  override the legacy .cursorrules path (null to disable)
 * - maxSessions:     cap tracked sessions (default 100)
 */
export default Plugin.define({
  id: PLUGIN_ID,
  effect: (ctx) =>
    Effect.gen(function* () {
      const loader = new RuleLoader();
      const sessions = new Map<string, SessionState>();
      const options = (ctx.options ?? {}) as Record<string, unknown>;

      // Resolve paths (location-aware, option-overridable)
      const projectRoot = String(ctx.location.project?.canonical ?? ctx.location.directory);
      const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
      const userRulesDir = asString(options.userRulesDir) ?? join(configHome, "opencode", "rules");
      const projectRulesDir =
        asString(options.projectRulesDir) ?? join(projectRoot, ".opencode", "rules");
      const legacyFilePath =
        options.legacyFilePath === null
          ? null
          : (asString(options.legacyFilePath) ?? join(projectRoot, ".cursorrules"));
      const maxSessions = asPositiveInt(options.maxSessions) ?? DEFAULT_MAX_SESSIONS;

      yield* Effect.logInfo("Initializing cursor rules plugin", {
        projectRulesDir,
        userRulesDir,
        legacyFilePath,
      });

      /**
       * Get or create session state (bounded LRU-ish eviction).
       */
      const getSession = (sessionID: string): SessionState => {
        let state = sessions.get(sessionID);
        if (!state) {
          state = { filePaths: new Set(), lastUserMessage: "" };
          sessions.set(sessionID, state);
          if (sessions.size > maxSessions) {
            const firstKey = sessions.keys().next().value;
            if (firstKey !== undefined) sessions.delete(firstKey);
          }
        }
        return state;
      };

      const loadRulesSafe = () =>
        Effect.tryPromise(() => loader.loadAll(userRulesDir, projectRulesDir, legacyFilePath)).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Failed to load cursor rules, continuing without them", {
              error: error instanceof Error ? error.message : String(error),
            }).pipe(Effect.as([] as Awaited<ReturnType<typeof loader.loadAll>>)),
          ),
        );

      // Pre-warm cache (non-blocking for sessions; failures only logged)
      const initialRules = yield* loadRulesSafe();
      if (initialRules.length > 0) {
        yield* Effect.logInfo(`Loaded ${initialRules.length} cursor rule(s)`);
      } else {
        yield* Effect.logDebug("No cursor rules found in any directory");
      }

      /**
       * Track files accessed by tool calls to enable glob-based matching.
       */
      yield* ctx.tool.hook("execute.before", (event) =>
        Effect.sync(() => {
          const session = getSession(String(event.sessionID));
          collectFilePaths(event.input, projectRoot, session.filePaths);
        }),
      );

      /**
       * Capture user messages for @rule-name mention detection.
       * Runs before durable prompt admission.
       */
      yield* ctx.session.hook("prompt", (event) =>
        Effect.sync(() => {
          const session = getSession(String(event.sessionID));
          const text = event.prompt?.text;
          if (typeof text === "string") {
            session.lastUserMessage = text;
          }
        }),
      );

      /**
       * Inject matching rules into the agent-loop system instructions.
       * Runs immediately before each model dispatch.
       */
      yield* ctx.session.hook("context", (event) =>
        Effect.gen(function* () {
          const session = getSession(String(event.sessionID));
          const rules = yield* loadRulesSafe();
          if (rules.length === 0) return;

          const { injected, suggested, available } = selectRules(rules, session);
          yield* Effect.logDebug("Selected rules for system prompt", {
            totalRules: rules.length,
            injected: injected.map((m) => m.rule.name),
            suggested: suggested.map((m) => m.rule.name),
            available: available.map((r) => r.name),
          });

          if (injected.length === 0 && suggested.length === 0 && available.length === 0) return;

          const section = formatSystemPromptSection(injected, suggested, available);
          if (section.length > 0) {
            event.system.push({ type: "text", text: section });
          }
        }),
      );

      // --- Tools (Effect Schema, structured results) ---

      const RuleInputSchema = Schema.Struct({
        name: Schema.String,
        description: Schema.String,
        content: Schema.String,
        globs: Schema.optional(Schema.Array(Schema.String)),
        alwaysApply: Schema.optional(Schema.Boolean),
      });

      const createUserRuleExecute = (input: typeof RuleInputSchema.Type) =>
        Effect.gen(function* () {
          yield* Effect.logInfo(`Creating user-level rule: ${input.name}`);
          const result = yield* Effect.tryPromise(() =>
            createUserRule(
              input.name,
              input.description,
              input.content,
              input.globs,
              input.alwaysApply,
            ),
          ).pipe(
            Effect.catch(() =>
              Effect.succeed({
                success: false as const,
                message: "Unexpected internal error while creating user rule",
                filePath: undefined as string | undefined,
              }),
            ),
          );
          if (result.success) {
            yield* Effect.logInfo(`Created user-level rule: ${input.name}`, {
              filePath: result.filePath,
            });
            return { content: `Created user-level rule "${input.name}" at ${result.filePath}` };
          }
          yield* Effect.logWarning(`Failed to create user-level rule: ${input.name}`, {
            error: result.message,
          });
          return { content: `Failed to create user rule: ${result.message}` };
        });

      const createProjectRuleExecute = (input: typeof RuleInputSchema.Type) =>
        Effect.gen(function* () {
          yield* Effect.logInfo(`Creating project-level rule: ${input.name}`);
          const result = yield* Effect.tryPromise(() =>
            createProjectRule(
              input.name,
              input.description,
              input.content,
              input.globs,
              input.alwaysApply,
              projectRoot,
            ),
          ).pipe(
            Effect.catch(() =>
              Effect.succeed({
                success: false as const,
                message: "Unexpected internal error while creating project rule",
                filePath: undefined as string | undefined,
              }),
            ),
          );
          if (result.success) {
            yield* Effect.logInfo(`Created project-level rule: ${input.name}`, {
              filePath: result.filePath,
            });
            return { content: `Created project-level rule "${input.name}" at ${result.filePath}` };
          }
          yield* Effect.logWarning(`Failed to create project-level rule: ${input.name}`, {
            error: result.message,
          });
          return { content: `Failed to create project rule: ${result.message}` };
        });

      const listRulesExecute = () =>
        Effect.gen(function* () {
          const result = yield* Effect.tryPromise(() =>
            listRules(userRulesDir, projectRulesDir, legacyFilePath, loader),
          ).pipe(
            Effect.catch(() =>
              Effect.succeed({
                success: false as const,
                message: "Unexpected internal error while listing rules",
                rules: undefined as
                  | Array<{
                      name: string;
                      source: string;
                      mode: string;
                      description?: string;
                      globs: string[];
                      alwaysApply: boolean;
                      filePath: string;
                    }>
                  | undefined,
              }),
            ),
          );
          if (!result.success || !result.rules) {
            yield* Effect.logWarning("Failed to list rules", { error: result.message });
            return { content: `Failed to list rules: ${result.message}` };
          }
          yield* Effect.logInfo(`Listed ${result.rules.length} cursor rule(s)`);
          return { content: formatRulesList(result.rules) };
        });

      yield* ctx.tool.transform((editor) => {
        editor.add({
          name: "create_user_rule",
          description: "Create a new user-level (global) rule for OpenCode",
          input: RuleInputSchema,
          execute: createUserRuleExecute,
        });
        editor.add({
          name: "create_project_rule",
          description: "Create a new project-level rule for OpenCode",
          input: RuleInputSchema,
          execute: createProjectRuleExecute,
        });
        editor.add({
          name: "list_rules",
          description: "List all currently loaded cursor rules with their loading strategies",
          input: Schema.Struct({}),
          execute: listRulesExecute,
        });
      });

      // --- Commands (best practice: owned commands via transform) ---

      yield* ctx.command.transform((editor) => {
        editor.add({
          name: "create-user-rule",
          description: "Create a new user-level rule that applies globally",
          execute: (input) =>
            ctx.session
              .prompt({
                ...input.prompt,
                sessionID: input.sessionID,
                text: `Create a new user-level rule for OpenCode. Ask the user for:
1. Rule name (e.g., "typescript-standards", "bun-preference")
2. Brief description of what the rule does
3. Rule content (the actual instructions)
4. Whether it should always apply (optional, default: false)
5. File glob patterns if it should auto-attach to specific files (optional)

Use the create_user_rule tool to create the rule file at the user level (~/.config/opencode/rules/).

${input.prompt.text}`,
                delivery: input.delivery,
              })
              .pipe(Effect.asVoid),
        });
        editor.add({
          name: "create-project-rule",
          description: "Create a new project-level rule for the current workspace",
          execute: (input) =>
            ctx.session
              .prompt({
                ...input.prompt,
                sessionID: input.sessionID,
                text: `Create a new project-level rule for OpenCode. Ask the user for:
1. Rule name (e.g., "api-conventions", "component-patterns")
2. Brief description of what the rule does
3. Rule content (the actual instructions)
4. Whether it should always apply (optional, default: false)
5. File glob patterns if it should auto-attach to specific files (optional)

Use the create_project_rule tool to create the rule file at the project level (.opencode/rules/).

${input.prompt.text}`,
                delivery: input.delivery,
              })
              .pipe(Effect.asVoid),
        });
        editor.add({
          name: "list-rules",
          description: "List all currently loaded rules with their loading strategies",
          execute: (input) =>
            ctx.session
              .prompt({
                ...input.prompt,
                sessionID: input.sessionID,
                text: `Show all loaded cursor rules for the current session, including:
- Rule name
- Source (user-level, project-level, or legacy .cursorrules)
- Loading mode (always, glob, agent-requested, manual)
- File patterns (for glob mode)
- Description

Use the list_rules tool to retrieve and display this information.

${input.prompt.text}`,
                delivery: input.delivery,
              })
              .pipe(Effect.asVoid),
        });
      });
    }),
});

/**
 * Extract file paths from a tool input payload and add them (repo-relative)
 * to the session's observed set.
 */
function collectFilePaths(input: unknown, projectRoot: string, into: Set<string>): void {
  if (!input || typeof input !== "object") return;
  const args = input as Record<string, unknown>;
  for (const key of [...FILE_PATH_KEYS, ...LOCATION_KEYS]) {
    const val = args[key];
    if (typeof val === "string" && val.length > 0) {
      into.add(toRelative(val, projectRoot));
    }
  }
}

function toRelative(val: string, projectRoot: string): string {
  return val.startsWith(projectRoot) ? val.slice(projectRoot.length + 1) : val;
}

function asString(val: unknown): string | undefined {
  return typeof val === "string" && val.length > 0 ? val : undefined;
}

function asPositiveInt(val: unknown): number | undefined {
  return typeof val === "number" && Number.isInteger(val) && val > 0 ? val : undefined;
}

/**
 * Format loaded rules into a readable Markdown listing.
 */
function formatRulesList(
  rules: Array<{
    name: string;
    source: string;
    mode: string;
    description?: string;
    globs: string[];
    alwaysApply: boolean;
    filePath: string;
  }>,
): string {
  const lines: string[] = [];
  lines.push("# Loaded Cursor Rules\n");

  if (rules.length > 0) {
    const userRules = rules.filter((r) => r.source === "user");
    const projectRules = rules.filter((r) => r.source === "project");
    const legacyRules = rules.filter((r) => r.source === "legacy");

    if (userRules.length > 0) {
      lines.push("## User-Level Rules (~/.config/opencode/rules/)\n");
      for (const rule of userRules) {
        lines.push(formatRuleEntry(rule));
      }
      lines.push("");
    }

    if (projectRules.length > 0) {
      lines.push("## Project-Level Rules (.opencode/rules/)\n");
      for (const rule of projectRules) {
        lines.push(formatRuleEntry(rule));
      }
      lines.push("");
    }

    if (legacyRules.length > 0) {
      lines.push("## Legacy Rules (.cursorrules)\n");
      for (const rule of legacyRules) {
        lines.push(formatRuleEntry(rule));
      }
      lines.push("");
    }

    lines.push(`\n**Total: ${rules.length} rule(s)**`);
  } else {
    lines.push("No rules loaded.");
    lines.push("\nCreate rules using:");
    lines.push("- `/create-user-rule` - for global rules");
    lines.push("- `/create-project-rule` - for project-specific rules");
  }

  return lines.join("\n");
}

/**
 * Format a single rule entry for display.
 */
function formatRuleEntry(rule: {
  name: string;
  source: string;
  mode: string;
  description?: string;
  globs: string[];
  alwaysApply: boolean;
  filePath: string;
}): string {
  const parts: string[] = [];

  // Name and mode badge
  const modeBadge =
    rule.mode === "always"
      ? "always"
      : rule.mode === "glob"
        ? "glob"
        : rule.mode === "agent"
          ? "agent"
          : "manual";
  parts.push(`### ${rule.name} [${modeBadge}]`);

  // Description
  if (rule.description) {
    parts.push(`> ${rule.description}`);
  }

  // Details
  const details: string[] = [];
  if (rule.globs.length > 0) {
    details.push(`**Globs:** ${rule.globs.join(", ")}`);
  }
  details.push(`**File:** \`${rule.filePath}\``);
  parts.push(details.join(" | "));

  return parts.join("\n");
}
