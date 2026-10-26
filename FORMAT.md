# FORMAT.md — the `memport/1` bundle format

A Memport bundle is a **directory**, not a file. A directory keeps
every item human-readable, editable by hand, diffable in git, and
greppable — the properties that make a memory store trustworthy. A
single JSON blob would be easier to hash but opaque; a directory with
a manifest gets both.

```
example-bundle/
  memport.json            # manifest (format version, provenance, hashes)
  items/
    <ulid>.md             # one file per item
  merge-report.md         # only if produced by `merge`
```

## Manifest (`memport.json`)

JSON, keys:

| Key | Meaning |
|---|---|
| `format` | Always `"memport/1"` (major version in the string; see Versioning) |
| `created` | ISO 8601 creation timestamp |
| `source_tool` | Tool the bundle was imported from (`claude`, `codex`, `cursor`, or `memport` for merged bundles), or `null` for hand-written bundles |
| `source_path` | Absolute path the bundle was imported from (for audit; may be redacted by the user before sharing) |
| `project` | Project directory the bundle scopes to, or `null` for user scope |
| `items` | Array of `{ id, file, sha256 }` — SHA-256 of the item file's exact bytes, for integrity checking by `validate` |
| `notes` | Optional free-form provenance notes (e.g. paths read on import) |

## Item file (`items/<ulid>.md`)

Markdown with YAML frontmatter, then a markdown body. The filename
matches the id.

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | ULID, stable across tools (see Identity). The filename matches the id. |
| `kind` | yes | One of `fact`, `preference`, `decision`, `rule`, `reference`, `note` |
| `title` | yes | One-line human title (derived from the first line if the source had none) |
| `scope` | yes | `user` (applies everywhere) or `project` (applies to one project) |
| `origin` | yes | `human` (user wrote it), `agent-learned` (a tool wrote it), `imported` (carried from another tool's store) |
| `source_tool` | yes | Tool this item was first seen in (`claude`, `codex`, `cursor`, `hand`) |
| `source_path` | no | Original file the item came from, for audit |
| `source_kind` | no | Original category in the source tool (e.g. Claude `type: project`, Cursor activation mode) — preserved so re-export can restore it |
| `created` | yes | ISO 8601 |
| `updated` | yes | ISO 8601 (changes on any edit) |
| `supersedes` | no | Item id this item replaces, or null |
| `status` | yes | `active`, `superseded`, or `disputed` |
| `tags` | no | String list, free-form |

The body is the item's full markdown text. Readers **must ignore
unknown frontmatter fields** (forward compatibility) and **must reject
unknown major format versions** (a `memport/2` bundle is an error, not
a warning). V1 writers emit only the fields in this table. Frontmatter
parsing is tolerant (unparseable lines are ignored, mirroring Claude
Code); strictness lives in `validate`, which checks required fields
and vocabularies.

## Versioning

`memport/1` is the major version. Minor additions (new optional
frontmatter fields, new `kind` values) are allowed only if old readers
can still read the bundle by ignoring them; anything else is
`memport/2`. No `2` exists in v1.

## Identity

Identity is the **ULID**, assigned once at first import and preserved
forever after. It is not the text: edits change text, and two tools may
hold different texts for the same item.

- Import from a source that carries no id (all v1 sources) mints a
  fresh ULID and records the source path. Re-importing the same source
  file is idempotent: the importer matches on (source_tool,
  source_path, normalized title) and reuses the existing id instead of
  minting a duplicate — otherwise every re-import would double the
  bundle.
- Export to a format that preserves frontmatter (Claude topic files,
  Cursor `.mdc`) writes the id into it, so a later re-import recovers
  the same id.
- Export to a format that does not preserve it (AGENTS.md sections,
  Claude rules files) cannot round-trip identity: re-importing that
  rendered output mints new ids unless matched by the idempotence rule
  above. The plan output says this plainly for Codex exports.
- `supersedes` links a replacement to the item it replaces; superseded
  items are kept, never deleted, so merge history is auditable.

## Validation (`memport validate`)

`validate` fails (non-zero) on any of: missing or unparseable
manifest, unknown major format version, missing item file, manifest
entry whose `file` escapes the bundle (absolute path or `..`),
symlinked manifest, items directory, or item file (symlinks are
refused outright — a bundle must be regular files inside its own
directory), manifest id not matching the item id, file name not
matching the item id, manifest SHA-256 not matching file bytes
(forged or corrupted), extra unlisted files in `items/`, missing
required fields, unknown `kind`/`scope`/`origin`/`status`
values, non-ULID `id`/`supersedes`, non-string `tags`, duplicate ids,
or a `supersedes` target that does not exist in the bundle.

## Import (bundle)

Import reads a tool's native files into a bundle and **never modifies
the source**. `bundle` fails (non-zero) if the source layout is
unrecognized — never silently imports half a store. See MAPPINGS.md
for the per-tool source tables. Re-importing into an existing bundle
directory merges with id reuse (see Identity); writing into a
non-empty directory that is not a bundle is refused.

Symlinked tool-native files are skipped with a warning; Memport never
follows symlinks on import (following one would read content from
outside the project or tool directory). Symlinked directories are not
walked on the subdirectory search either.

## Export (apply)

Export renders a bundle into a tool's native files, plan-first
(`--apply` executes). Only active items render; superseded and
disputed items are skipped and counted in the plan. Targets:

| Tool | User scope | Project scope |
|---|---|---|
| Claude | `~/.claude/rules/memport.md` (own file, regenerated whole) | `<project>/.claude/rules/memport.md` (own file) |
| Codex | `~/.codex/AGENTS.md` (delimited section) | `<project>/AGENTS.md` (delimited section) |
| Cursor | — (User Rules live in settings) | `<project>/.cursor/rules/memport.mdc` (own file, `alwaysApply: true`) |

Write discipline (see README for the narrative version):

- Own files are regenerated whole on each apply; shared files get
  exactly one delimited section between `<!-- BEGIN MEMPORT -->` and
  `<!-- END MEMPORT -->`. Re-runs replace only that section.
- Missing, duplicated, misordered markers, or markers inside a fenced
  code block make apply **refuse** (fail closed). It never appends a
  second section and never rewrites surrounding content.
- An item body with an unclosed fenced code block renders fine the
  first time, but the next apply refuses: the marker scanner treats
  everything after the fence — including the END marker — as code.
  Nothing is lost (apply refuses rather than rewriting); close or
  remove the fence in the bundle item (or the rendered file) and
  re-apply. This is a documented limitation, not a bug to work around
  by weakening marker handling.
- Before the first write to any target file, Memport copies it to
  `<file>.memport-bak`. An existing backup is never overwritten
  without `--force`. A second apply that changes nothing writes
  nothing (byte-identical targets).
- Item bodies containing a literal marker line are escaped in rendered
  output and reported in the plan.
- Every rendered item carries a visible provenance line (id, source
  tool and path, origin, kind, scope) — not an HTML comment, because
  Claude strips HTML comments before injection.
- `convert` always materializes its intermediate bundle (temp dir, or
  `--out` if given) so the plan can be computed; only the target-tool
  write is plan-gated. The intermediate bundle is kept, not cleaned
  up — delete it yourself when you are done with it.

## Merge (`memport merge`)

Deterministic, no meaning-based resolution. Nothing is ever deleted
by a merge. Default exit 0 with conflicts recorded in
`merge-report.md` (written into the output bundle); `--strict` exits
non-zero on any conflict and writes nothing.

1. Same id, identical normalized body → one item (dedupe). Body
   normalization: line endings, per-line trailing space, blank-run
   collapsing, outer trim. Deliberately not semantic.
2. Same id, different body → conflict. Winner: `active` status beats
   `disputed` beats `superseded`, then `human` origin beats
   `agent-learned` beats `imported`; ties break by newer `updated`,
   then toward the first bundle. The loser is preserved as its
   original file text in `merge-report.md` (see deviation note below)
   and the winner is kept.
3. Different ids, identical normalized (kind, scope, body) text →
   dedupe to the older id (older `created`, then smaller id); the
   dropped source is noted in the merge report.
4. Different ids, similar-but-not-identical text → keep both, list as
   "possible duplicate" in `merge-report.md`. No semantic dedup in v1.
5. A merge never changes an item's id.

**Deviation note (rule 2, documented deliberately).** The assessment
sketch said the loser is "kept with status: superseded and the
winner's supersedes points at it." That cannot hold literally in a
`memport/1` bundle: one file per id, `validate` forbids duplicate ids,
and rule 5 forbids changing ids — winner and loser share one id, so
both cannot be items in the output bundle. The implementation
therefore preserves the loser's original file text in
`merge-report.md`, which ships inside the output bundle, and leaves
the winner's `supersedes` unset (a self-pointer would be a lie). The "nothing is ever deleted"
guarantee holds: the loser text is in the output bundle, auditable,
and re-importable by hand. `supersedes` in item frontmatter remains
for hand-authored replacement links (as in the golden-decision
fixture), which `validate` checks.

## Golden fixtures

Three hand-written bundles under `test/fixtures/` (fake data only;
project demo-shop):

- `golden-basic` — a `preference` ("Concise answers") and a `rule`
  ("Run tests before committing"), project scope.
- `golden-decision` — a `decision` ("Use GraphQL for billing") that
  `supersedes` an older `decision` ("Use REST for billing", status
  `superseded`), plus a `reference` ("Billing docs").
- `golden-user` — a `note` and a `preference`, user scope
  (`project: null`).

All three validate cleanly and are used by the test suite.

## CLI reference

```
memport scan [--project <dir>] [--json]
memport bundle --from <tool> [--scope user|project] [--project <dir>] --out <dir> [--apply] [--json]
memport apply --bundle <dir> --to <tool> [--scope user|project] [--project <dir>] [--apply] [--force] [--allow-secrets] [--json]
memport convert --from <tool> --to <tool> [--scope user|project] [--project <dir>] [--out <dir>] [--apply] [--force] [--allow-secrets] [--json]
memport merge <bundleA> <bundleB> --out <dir> [--apply] [--strict] [--allow-secrets] [--json]
memport validate <dir> [--json]
memport list <dir> [--kind <kind>] [--scope <scope>] [--json]
```

Note: `list --json` returns `{valid, validationErrors, items}` (not a bare
array), and item entries include full bodies — treat its output as
sensitive as the bundle itself.

Global flags: `--json` (machine-readable output for every command),
`--project <dir>` (project root; defaults to cwd for `scan` only).
Mutating commands default to plan mode; `--apply` executes.
`--force` allows overwriting an existing `.memport-bak` backup.
`--allow-secrets` overrides the secret-flag refusal on `apply` /
`convert` / `merge` (review the plan list first). `--strict` makes `merge`
fail on any conflict.
