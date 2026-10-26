# MAPPINGS.md — per-tool mappings and loss

Memport's bundle is lossless: everything the importer saw is preserved
in frontmatter or body. Rendering into a target tool is lossy by
nature. Every loss below appears in the plan output for the affected
items (count + examples), not buried here — this document is the
reference for what the plan means.

## Loss table

| Mapping | Loss | Mitigation |
|---|---|---|
| Claude `type: user` → kind `preference` | The user/feedback distinction is flattened | Original `type` kept in `source_kind` (`claude:type:user`); re-export to Claude restores it |
| Claude `type: feedback` → kind `preference` | Same flattening (a correction becomes a preference) | Same `source_kind` preservation |
| Claude `type: project` → kind `decision` | "Ongoing work" vs "decision" nuance flattened | `source_kind` preservation (`claude:type:project`) |
| Claude `type: reference` → kind `reference` | None | — |
| Claude memory with no/unknown `type` → kind `note` | Unknown category flattened to note | `source_kind` keeps `claude:type:<value>` (or `claude:memory`) |
| Codex durable entries → kind `note` | Fine-grained entry structure unknown (undocumented schema) → coarse notes | Provenance flag `codex-generated` (tag); body kept verbatim |
| Cursor activation (globs/description/alwaysApply) → other tools | No equivalent in Claude/Codex; activation becomes "always load" | Activation preserved in `source_kind`; re-export to Cursor restores it |
| Any item → Codex AGENTS.md section | Recall-vs-instruction nuance lost (target is instructions, per Codex docs' own advice) | Plan output labels these items "rendered as instructions" |
| Any item → Claude rules file | Learned items become always-loaded rules (no on-demand pull) | Plan output says so; auto-memory export (proper pull semantics) is v1.1 |
| Bundle → target → bundle round-trip | NOT identical: target rendering drops metadata (ids where the format lacks frontmatter, activation, source paths) | Documented; the guarantee is bundle → bundle identity and plan-time loss reporting, not round-trip identity |

Plan loss classes as printed (and in `--json` output):

- `claude-type-flattened` — a Claude-typed item whose kind flattened
  (any `claude:type:*` except `reference`).
- `codex-summary-coarse` — a Codex generated summary carried as a
  coarse note (`codex-generated` tag).
- `cursor-activation-flattened` — a Cursor item whose activation
  metadata has no equivalent in the target (any `cursor:*`
  `source_kind`).
- `rendered-as-instructions` — every item rendered into Codex.
- `learned-becomes-always-loaded-rule` — an `agent-learned` item
  rendered into Claude rules.

## Import mappings

### Claude Code

| Source | Becomes | Kind / `source_kind` | Notes |
|---|---|---|---|
| `CLAUDE.md` (project, user), `.claude/CLAUDE.md`, `CLAUDE.local.md` | One `rule` item per file, whole file as body | `rule` / `claude:instruction` | Load order respected (project layers in file order); subdirectory on-demand files are not walked in v1 — only the project root layers and `.claude/rules/` |
| `.claude/rules/*.md` (project and `~/.claude/rules/`) | One `rule` item per file, body minus frontmatter | `rule` / `claude:rules` (or `claude:rules:paths:<list>` when `paths` is set) | `paths` is the only frontmatter field Claude reads; other fields are ignored on import, matching Claude |
| Auto-memory topic file (`~/.claude/projects/<project>/memory/*.md`) | One item per file | Kind from frontmatter `type` (see loss table) / `claude:type:*` or `claude:memory` | Read-only; never modifies the memory directory. Unknown `type` values map to `note` with the value preserved in `source_kind` |
| Auto-memory index (`MEMORY.md`) | One `note` item per index line that is not a heading and does not reference a topic file | `note` / `claude:memory:index` | Lines referencing a topic file are skipped (the topic file itself is the item); duplicate titles are skipped |
| Transcripts (`*.jsonl`), `history.jsonl` | — (not imported) | — | Internal, unstable formats; use the tool's own resume/export |

Claude auto-memory import requires the project directory name to
resolve to `~/.claude/projects/<name>/memory` (working-directory path
with non-alphanumerics replaced by dashes). If that directory does not
exist, import continues without it and warns — it never guesses across
projects. `AGENTS.md` is not imported by the Claude adapter (it is
Codex/Cursor surface; Claude reads it only conditionally).

### Codex

| Source | Becomes | Kind / `source_kind` | Notes |
|---|---|---|---|
| Global chain file (`~/.codex/AGENTS.override.md`, else `AGENTS.md`, else fallback `.cursorrules`/`CLAUDE.md`/`CONVENTIONS.md`) | One `rule` item, first non-empty file only | `rule` / `codex:override`, `codex:agents`, or `codex:fallback:<name>` | Scope `user` |
| Project chain files (repo root → working dir, one file per directory, same selection rules) | One `rule` item per directory | `rule` / same roles | Scope `project`. Without a git root, only the working directory itself is read |
| `~/.codex/memories/*.md` | One `note` item per non-empty file | `note` / `codex:memory-summary`, tag `codex-generated` | Summaries only; internal record structure undocumented; never written to |
| Sessions (`~/.codex/sessions/`), Chronicle (`memories_extensions/chronicle/`) | — (not imported) | — | Sessions: unverified layout. Chronicle: ambient capture, not curation — never imported by default |

Import warns when the combined chain (global + project files) exceeds
32 KiB, because Codex itself truncates it (`project_doc_max_bytes`).

### Cursor

| Source | Becomes | Kind / `source_kind` | Notes |
|---|---|---|---|
| `.cursor/rules/*.mdc` | One `rule` item per file, body minus frontmatter | `rule` / activation (below) | Frontmatter decides activation; body is the rule prose |
| Plain `.md` files in `.cursor/rules/` | Ignored (with a count in the plan) | — | Cursor ignores them too (no frontmatter) |
| `.cursorrules` (legacy root file) | One `rule` item | `rule` / `cursor:legacy` | Deprecated upstream, still read |
| Repo `AGENTS.md` | One `rule` item | `rule` / `cursor:agents` | Cursor reads it natively |
| User Rules / Team Rules (settings) | — (not imported) | — | No documented file location; user-scope import is a hard error |
| Chat history / removed Memories store | — (not imported) | — | No documented on-disk location (2.1.x removed the feature) |

Cursor activation → `source_kind`:

| Frontmatter | `source_kind` | Meaning |
|---|---|---|
| `alwaysApply: true` | `cursor:alwaysApply` | Every chat session |
| `globs` set (string or list) | `cursor:globs:<globs>` | Auto-attached when a matching file is in context |
| `description` set, no globs | `cursor:description` | Agent decides relevance from the description |
| Neither | `cursor:manual` | Mention-only via `@rule-name` |

## Export mappings

| Target | File | Item rendering | Metadata survival |
|---|---|---|---|
| Claude (user/project) | `rules/memport.md` (own file, `# Memport rules` header, regenerated whole) | Each active item as `## <title>` + visible provenance line + body | Ids survive only in the provenance line text, not as re-importable frontmatter — re-importing a Claude rules file mints new ids unless the idempotence rule matches |
| Codex (user/project) | `AGENTS.md` (one delimited section) | Each active item as `## <title>` + provenance line + body, inside `<!-- BEGIN MEMPORT -->` / `<!-- END MEMPORT -->` | Same as Claude rules, plus: plan warns if the post-apply chain exceeds 32 KiB, and warns if an `AGENTS.override.md` exists that Codex would read instead |
| Cursor (project only) | `.cursor/rules/memport.mdc` (own file) | Frontmatter `alwaysApply: true` + `description: "Memport import: N item(s) from <source>"`, then items as `## <title>` + provenance line + body | The `.mdc` frontmatter does not carry per-item ids or activation; re-export to Cursor from a bundle restores activation from `source_kind` only when the bundle still holds it — rendered `.mdc` output itself flattens activation to `alwaysApply: true` |

Scope matrix (exact target per tool × scope; anything else is an
error, never a guess):

| Tool | `--scope user` | `--scope project` (requires `--project`) |
|---|---|---|
| Claude | `~/.claude/rules/memport.md` | `<project>/.claude/rules/memport.md` |
| Codex | `~/.codex/AGENTS.md` | `<project>/AGENTS.md` |
| Cursor | Error: User Rules live in settings | `<project>/.cursor/rules/memport.mdc` |

## Round-trip notes

- Bundle → bundle is identity-preserving (ids, kinds, metadata).
- Bundle → Claude rules → bundle: items re-import as new `rule`
  items (whole-file rule per file, not per item) unless idempotence
  matches on title — per-item identity does not survive.
- Bundle → Codex AGENTS.md → bundle: the delimited section
  re-imports as one `rule` item for the whole section file, not per
  item — same caveat, stated in the plan output.
- Bundle → Cursor `.mdc` → bundle: the `.mdc` file re-imports as one
  `rule` item with `cursor:alwaysApply` — per-item activation from
  the original bundle is not in the rendered file; only the bundle
  itself preserves it.
- Claude type and Cursor activation survive a bundle → bundle
  round trip via `source_kind`, and re-export to the originating tool
  restores them (Claude `type` on topic-file export is v1.1; v1
  Claude export is rules files, where `source_kind` is carried in
  the bundle but not re-emitted as topic frontmatter).
