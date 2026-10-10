# opencode-v2-cursor-rules

[![npm version](https://img.shields.io/npm/v/@aguarnac/opencode-v2-cursor-rules.svg?style=flat)](https://www.npmjs.com/package/@aguarnac/opencode-v2-cursor-rules)
[![CI](https://github.com/guarnacciaa/opencode-cursor-rules/actions/workflows/ci.yml/badge.svg)](https://github.com/guarnacciaa/opencode-cursor-rules/actions/workflows/ci.yml)
[![License MIT](https://img.shields.io/npm/l/@aguarnac/opencode-v2-cursor-rules.svg?style=flat)](https://opensource.org/licenses/MIT)

Bring **full Cursor rules support** to OpenCode v2. This plugin reads `.mdc` rule files and injects them into AI conversations, exactly how Cursor does it.

**No config needed if you already use Cursor.** Just symlink your rules and you're done.

> **Credits:** This project is a hard fork of [`zackBRAVE/opencode-cursor-rules`](https://github.com/zackBRAVE/opencode-cursor-rules) (the original OpenCode v1 plugin), rewritten from scratch for the OpenCode v2 plugin API. Rule parsing, matching semantics, and the symlink-first workflow are ported from the original; the plugin runtime, hooks, tools, commands, and packaging are new. Thank you to the original author and contributors.

## Why opencode-v2-cursor-rules?

- ✅ **100% Cursor-compatible** - Same `.mdc` format, same frontmatter, same behavior
- ✅ **All 4 rule modes** - always-apply, glob-matching, agent-requested, manual
- ✅ **Native OpenCode v2** - Built on the Effect plugin API (`Plugin.define`, session/tool hooks, transforms)
- ✅ **Zero config** - Works with your existing Cursor rules via symlinks
- ✅ **Runtime-agnostic** - Node.js builtins only, no Bun dependency
- ✅ **Robust** - mtime+size caching, stale-entry eviction, bounded session state, failures never break a session
- ✅ **Rule management** - Create and list rules via OpenCode tools and commands

## Installation

Add the plugin to your config (`~/.config/opencode/opencode.jsonc` for global, or `<project>/.opencode/opencode.jsonc` for project-local). See [`opencode.example.jsonc`](./opencode.example.jsonc):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "@aguarnac/opencode-v2-cursor-rules@2.0.0"
  ]
}
```

> ⚠️ **Important:** Always pin to a specific version (e.g., `@2.0.0`) to prevent breaking changes. OpenCode installs the latest version if no version is specified.

Requirements: **OpenCode v2** and **Node.js >= 22**.

## Quick Start

### Option 1: Use Your Existing Cursor Rules (Recommended)

```bash
# Project-level rules
cd your-project
ln -s ../.cursor/rules .opencode/rules

# User-level rules (global)
ln -s ~/.cursor/rules ~/.config/opencode/rules
```

### Option 2: Create Rules Directly

```bash
mkdir -p .opencode/rules
```

Create `.mdc` files in the directory (see Rule Format below).

### Restart OpenCode

Rules load on plugin initialization. Start a new session after adding/changing rules.

## Rule Format

Rules use **MDC format** (Markdown + YAML frontmatter), identical to Cursor:

```markdown
---
description: "Brief description of what this rule does"
globs: "*.ts, *.tsx"
alwaysApply: false
---

Your rule content in Markdown.
This gets injected into the AI's system prompt.
```

### Frontmatter Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `description` | `string` | — | Rule purpose; shown to AI for agent-requested selection |
| `globs` | `string \| string[]` | `[]` | Comma-separated or array of file glob patterns |
| `alwaysApply` | `boolean` | `false` | Always inject this rule into every conversation |

### Rule Application Modes

| Mode | Frontmatter | Behavior |
|------|------------|----------|
| **Always** | `alwaysApply: true` | Injected into every conversation |
| **Auto-Attach** | `globs` defined | Suggested when session files match patterns |
| **Agent-Requested** | `description` only (no globs) | Description listed; AI decides if relevant |
| **Manual** | No frontmatter | Only injected when user types `@rule-name` |

### Examples

**Always-apply rule:**

```markdown
---
description: "General coding standards"
alwaysApply: true
---

- Write clean, readable code
- Add JSDoc comments to exported functions
- Keep functions under 30 lines
```

**Glob-based rule:**

```markdown
---
description: "React component patterns"
globs: "*.tsx, src/components/**"
---

Use functional components with hooks.
Follow the container/presenter pattern.
Prefer composition over inheritance.
```

**Agent-requested rule:**

```markdown
---
description: "REST API design guidelines"
---

Use proper HTTP methods.
Version your APIs with /v1/ prefix.
Return consistent error response shapes.
```

**Manual rule:**

```markdown
# Legacy Migration Guide

When refactoring from v1 to v2:
1. Replace `useLegacyHook()` with `useNewHook()`
2. Update imports from `@/legacy` to `@/v2`
```

Trigger with: `@migration-guide help me migrate this file`

## Rule Priority

1. **Project rules** override **user rules** on name collision
2. **User rules** loaded first (lower priority)
3. **Legacy `.cursorrules`** loaded last (won't override named rules)
4. **@-mention** always promotes a rule to injected, regardless of its mode

## OpenCode Tools

The plugin registers tools (via `ctx.tool.transform` with Effect Schema) for managing rules programmatically:

### `create_user_rule`

Create a new user-level rule in `~/.config/opencode/rules/`.

```typescript
{
  name: "typescript-standards",
  description: "TypeScript coding standards",
  content: "- Use strict TypeScript\n- Prefer interfaces over types",
  globs: ["*.ts", "*.tsx"],
  alwaysApply: false
}
```

### `create_project_rule`

Create a new project-level rule in `.opencode/rules/`. Uses the current project directory automatically.

### `list_rules`

List all loaded rules with metadata, sources, and application modes.

## OpenCode Commands

The plugin registers owned commands (via `ctx.command.transform`):

| Command | Description |
|---------|-------------|
| `/create-user-rule` | Guided creation of a global rule (drives `create_user_rule`) |
| `/create-project-rule` | Guided creation of a project rule (drives `create_project_rule`) |
| `/list-rules` | Show loaded rules grouped by source (drives `list_rules`) |

## Plugin Options

All options are optional. Pass them with the object form in `opencode.jsonc`:

```jsonc
{
  "plugins": [
    {
      "package": "@aguarnac/opencode-v2-cursor-rules@2.0.0",
      "options": {
        "userRulesDir": "/custom/path/to/rules",
        "projectRulesDir": "/custom/project/.opencode/rules",
        "legacyFilePath": null,
        "maxSessions": 100
      }
    }
  ]
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `userRulesDir` | `string` | `~/.config/opencode/rules/` (respects `XDG_CONFIG_HOME`) | Override the user rules directory |
| `projectRulesDir` | `string` | `<project>/.opencode/rules/` | Override the project rules directory |
| `legacyFilePath` | `string \| null` | `<project>/.cursorrules` | Override the legacy file path; `null` disables it |
| `maxSessions` | `number` | `100` | Cap tracked sessions (LRU-ish eviction) |

## Project Structure

```text
index.ts          Effect plugin entry (Plugin.define: hooks, tools, commands)
src/
├── parser.ts     MDC frontmatter extraction + YAML parsing (pure)
├── loader.ts     Rule discovery + mtime/size caching (Node builtins only)
├── matcher.ts    Glob matching + rule selection (pure)
├── tools.ts      Rule file creation/listing helpers (shared by tool executors)
└── types.ts      TypeScript interfaces
tests/            node:test suites (parser, matcher, loader, tools, integration)
```

See [`DESIGN.md`](./DESIGN.md) for the full technical design.

## Available Scripts

```bash
# Run tests (Node built-in runner, no extra dependency)
npm test

# Type check
npm run typecheck

# Run Biome checks
npm run lint          # Check for issues
npm run lint:fix      # Auto-fix issues
npm run format        # Check formatting
npm run format:fix    # Auto-fix formatting
npm run check         # Run all checks (types + lint + format + tests)
```

## Performance

| Operation | Time |
|-----------|------|
| Cold start (scan + parse 20 rules) | ~20ms |
| Warm injection (cached rules) | <1ms |
| Memory per 50 rules | ~200KB |

- **No file watchers** - uses `stat()` mtime+size for cache invalidation
- **Lazy caching** - files parsed once, re-parsed only on modification; stale entries evicted
- **Minimal runtime dependencies** - only `yaml` and `picomatch` (plus `@opencode/plugin` host API)

## Differences from the Original

Compared to [`zackBRAVE/opencode-cursor-rules`](https://github.com/zackBRAVE/opencode-cursor-rules) v1:

- Rewritten for the **OpenCode v2 Effect plugin API** (`@opencode/plugin/effect`); the v1 implementation does not run on v2
- Hooks: `tool.execute.before` → `ctx.tool.hook`, `chat.message` → `ctx.session.hook("prompt")`, `experimental.chat.system.transform` → `ctx.session.hook("context")`, `config` commands → `ctx.command.transform`
- Tools use Effect `Schema` instead of the v1 `tool.schema` helpers
- No `Bun.*` APIs: file discovery/reading uses `node:fs` (works on any host runtime)
- Tests run with `node:test` + `node:assert/strict` (no Bun required)
- Renamed package to `@aguarnac/opencode-v2-cursor-rules`

## Contributing

Contributions are welcome! Please use [Conventional Commits](https://www.conventionalcommits.org/) (enforced by commitlint) and run `npm run check` before pushing.

## Release

Releases are automated with Release Please (Conventional Commits → changelog + version bump + GitHub release). See RELEASE.md for details.

## License

MIT - see [LICENSE](./LICENSE). The original project by zackBRAVE is also MIT-licensed.
