# opencode-v2-cursor-rules - Technical Design

## Overview

An OpenCode **v2** Effect plugin that brings **full Cursor rules support** to OpenCode. It reads `.mdc` rule files from user-level and project-level directories, then injects matching rules into AI conversations, exactly how Cursor does it.

This project is a hard fork of [`zackBRAVE/opencode-cursor-rules`](https://github.com/zackBRAVE/opencode-cursor-rules) (OpenCode v1). Rule parsing and matching semantics are ported from the original; the plugin runtime layer is rewritten for the OpenCode v2 Effect API.

The plugin is designed as a **symlink-friendly bridge**: users symlink `.cursor/rules` into `.opencode/rules` (or `~/.config/opencode/rules`), and the plugin handles everything. No config, no migration, just works.

## Goals

1. **100% Cursor-compatible** - Same `.mdc` format, same frontmatter, same behavior
2. **All four rule application modes** - Always, auto-attach (glob), agent-requested (description), manual
3. **Both project and user/global rules** - Project: `<project>/.opencode/rules/`, User: `~/.config/opencode/rules/`
4. **Native v2** - Effect plugin (`Plugin.define`), session/tool hooks, command/tool transforms, Effect logging
5. **Performance** - Lazy loading, mtime+size caching, zero file watchers, minimal memory
6. **Robustness** - Total tool executors (failures become messages, never session errors), bounded session state, stale cache eviction, Node builtins only
7. **Legacy support** - `.cursorrules` flat file in project root

## Architecture

```text
index.ts          Effect plugin entry (Plugin.define: hooks, tools, commands)
src/
├── parser.ts     MDC frontmatter extraction + YAML parsing (pure)
├── loader.ts     Rule discovery, caching, mtime+size invalidation (Node builtins)
├── matcher.ts    Glob matching + rule selection logic (pure)
├── tools.ts      Rule file creation/listing helpers (shared by tool executors)
└── types.ts      TypeScript interfaces
tests/            node:test suites (parser, matcher, loader, tools, integration)
```

### Why This Structure

- **parser.ts** is pure: string in → structured data out. No I/O side effects, easily testable.
- **loader.ts** owns all filesystem access. Uses only `node:fs`/`node:path` (no `Bun.*`), so it runs on any host runtime. Caches parsed rules keyed by path with `(mtimeMs, size)` validation and evicts entries for deleted files.
- **matcher.ts** is pure: rules + context → selected rules. No I/O, easily testable.
- **tools.ts** holds the file-creation/listing logic shared by the Effect tool executors. Frontmatter is serialized with the `yaml` encoder so values containing quotes or newlines cannot break the file.
- **index.ts** is the Effect plugin definition: registers hooks, tools, and commands through `ctx`, owns per-session state.

## Core Components

### 1. Parser (`src/parser.ts`)

Unchanged semantics from the original. Extracts YAML frontmatter from MDC files and normalizes metadata.

```text
Input:  raw file content (string)
Output: { frontmatter: RuleFrontmatter, body: string }
```

**Frontmatter fields (Cursor MDC spec):**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `description` | `string` | `undefined` | Rule purpose; used for agent-requested selection |
| `globs` | `string \| string[]` | `[]` | Comma-separated or array of file glob patterns |
| `alwaysApply` | `boolean` | `false` | If true, always injected into system prompt |

### 2. Loader (`src/loader.ts`)

Discovers and caches rule files from disk using Node builtins only.

**Discovery paths:**

1. User rules: `~/.config/opencode/rules/*.mdc|*.md` (respects `XDG_CONFIG_HOME`)
2. Project rules: `<project>/.opencode/rules/*.mdc|*.md`
3. Legacy: `<project>/.cursorrules`

**Caching strategy:**

- Key: absolute file path
- Validation: `stat()` mtime **and** size (size guards against coarse timestamp resolution)
- Stale entries (deleted files) evicted on every `loadAll`
- No file watchers: `stat()` is ~0.01ms; symlink-compatible

**Merge order:**

1. User rules loaded first
2. Project rules loaded second (higher priority)
3. Legacy `.cursorrules` loaded last (always-apply, lowest priority)
4. On name collision: project rule wins over user rule

### 3. Matcher (`src/matcher.ts`)

Unchanged semantics from the original. Selects which rules to inject based on the current context.

**Selection algorithm (in priority order):**

1. **Always-apply rules** (`alwaysApply: true`) → injected (full content)
2. **Glob-matched rules** → suggested (path + reason; the agent reads the file)
3. **Agent-requested rules** (description only) → available (path + description)
4. **Manual rules** → only via `@rule-name` mention (always promoted to injected)

### 4. v1 → v2 Hook Mapping (`index.ts`)

| v1 | v2 |
|----|----|
| `tool.execute.before` (input/output pair) | `ctx.tool.hook("execute.before")` (single mutable event: `{ tool, sessionID, input }`) |
| `chat.message` | `ctx.session.hook("prompt")` (event `{ sessionID, prompt: { text, ... }, delivery }`) |
| `experimental.chat.system.transform` (`output.system: string[]`) | `ctx.session.hook("context")` (`event.system: SystemPart[]`, push `{ type: "text", text }`) |
| `config` hook registering `config.command` | `ctx.command.transform` (`editor.add({ name, description, execute })`) |
| `tool()` helper map | `ctx.tool.transform` (`editor.add({ name, description, input: Schema.Struct, execute })`) |
| `client.app.log` | `Effect.logInfo/logDebug/logWarning` |

**Context tracking:**

- `execute.before` hook collects file paths from tool inputs (same key heuristics as v1, normalized repo-relative)
- `prompt` hook stores the latest user text for `@`-mention extraction
- Session state is a `Map<sessionID, SessionState>` bounded by `maxSessions` (default 100, LRU-ish eviction)

**Failure policy:** every async boundary is total. Loader failures log a warning and yield `[]`; tool executors return failure *messages* as content instead of failing the tool call. A broken rules setup can never break a session.

### 5. Tools and Commands (`index.ts`)

Tools are registered with Effect `Schema.Struct` inputs and return `{ content: string }`:

- `create_user_rule`, `create_project_rule`, `list_rules`

Commands are owned plugin commands (v2 best practice for published plugins) that prompt the agent to drive the corresponding tool:

- `create-user-rule`, `create-project-rule`, `list-rules`

## System Prompt Injection Format

Same three-tier format as the original:

```markdown
<rules>
...
<user_rules>...full content for injected user rules...</user_rules>
<project_rules>...full content for injected project rules...</project_rules>
<suggested_rules>...paths + match reasons for glob-matched rules...</suggested_rules>
<available_rules>...paths + descriptions for agent-requested rules...</available_rules>
</rules>
```

The only change is transport: the section is pushed as a `{ type: "text", text }` system part instead of a raw string.

## Performance Budget

| Operation | Target | Actual |
|-----------|--------|--------|
| Plugin init (cold) | <50ms | ~20ms (scan + parse) |
| Rule injection (warm cache) | <5ms | ~1ms (map lookups + string concat) |
| Memory (50 rules) | <1MB | ~200KB |
| Per-session state | <1KB | ~500B (bounded count) |

## Error Handling

All errors are caught and logged, never thrown to OpenCode:

- Missing directories → skip silently
- Broken symlinks → skip file
- Malformed YAML → skip frontmatter, use body as content
- File read errors → skip file
- Empty files → skip
- Loader failure inside hooks → warn + continue with no rules
- Tool executor failure → failure message as tool content

## Dependencies

**Runtime:**

- `yaml` - YAML frontmatter parsing and safe frontmatter generation
- `picomatch` - Fast glob matching
- `@opencode/plugin` - v2 host API (redirected to the host runtime instance)

**Peer:**

- `effect >= 4.0.0-rc.112` - Must match the host OpenCode release's Effect version (a single copy; never bundled)

**Dev:**

- TypeScript, Node built-in test runner, Biome
