# Memport

Portable agent-memory interchange: convert and carry memory/context
between Claude Code, Codex, Cursor and other tools in one open format,
so switching tools doesn't wipe what your agents know.

## The problem

Every coding agent accumulates two kinds of memory, and only one of them
travels today:

- **Rules** — files you wrote (CLAUDE.md, AGENTS.md, Cursor rules).
  These copy across tools by hand, and mostly work.
- **Learned memory** — preferences, corrections, decisions and pointers
  the agent picked up across sessions. This is what is lost when you
  switch tools, because no vendor exports it in a portable form.

So you switch from Claude Code to Codex, or from Cursor to Claude, and
the new tool starts from zero on everything the old one had learned
about you and your project — your working preferences, the decisions
behind the code, the corrections you already gave once.

## The solution, in layman's terms

Memport reads a tool's memory files and writes them into a **bundle**:
a plain directory containing one small markdown file per memory item,
plus a manifest that lists them with SHA-256 hashes. The bundle is the
portable artifact — human-readable, editable by hand, diffable in git,
greppable. From a bundle, Memport renders the items back into another
tool's native files.

Nothing is ever deleted by a merge, nothing is written without showing
you the plan first, and every export says plainly what it loses (some
loss is unavoidable — see Honest limits). Memport is a local file
converter: no daemon, no network, no accounts, no model calls. It reads
your files, writes files, and stops.

## Honest limits (read before you trust a conversion)

1. **Exported items are context, not enforcement.** Every target tool
   treats these files as prompt text. Nothing Memport writes can force
   a tool to obey an item, and conflicting items may be followed
   arbitrarily.
2. **Codex import is summaries-only.** Codex's internal memory-record
   layout is undocumented, so Memport reads only markdown summaries
   from `~/.codex/memories/` as coarse notes — never fine-grained
   entries, and never writes there.
3. **Cursor import carries rules only.** Cursor removed its per-chat
   Memories feature in 2.1.x, so anything a Cursor user taught the
   agent in chat is unrecoverable by design. A Cursor→Claude conversion
   carries what Cursor was told in rules files, not what it learned.
4. **Conflicts are never resolved by meaning.** Merges follow fixed
   deterministic rules (see FORMAT.md). If two items genuinely
   contradict each other, the merge keeps the winner as the item and
   preserves the loser in full in `merge-report.md` (see FORMAT.md),
   and you adjudicate.
5. **Freshness is manual.** There is no live sync; a bundle goes stale
   the moment the source tool writes new memory. Re-import, don't
   assume.
6. **Budgets still bite.** Codex truncates instruction chains over
   32 KiB; Claude truncates long on-demand files. A giant bundle
   exported whole will be cut by the target tool, not by Memport —
   the plan output warns with sizes, and you curate.
7. **An unclosed fence self-bricks re-apply.** An item body with an
   unclosed fenced code block renders fine the first time, but the
   next apply refuses: the marker scanner treats everything after the
   fence — including the END marker — as code. Nothing is lost (apply
   refuses rather than rewriting); close or remove the fence in the
   bundle item (or the rendered file) and re-apply.

## Quick start

Memport needs Node 22 or newer. From a checkout:

```sh
npm install
npm run build
```

Then run `node dist/cli.js …` (or `npm link` once and use `memport`
directly). Every command accepts `--json` for machine-readable output.

```sh
# 1. See what each tool has (read-only, exit 0 even if a tool is absent)
memport scan --project ./demo-shop

# 2. Import Claude's project memory into a bundle (plan first, then apply)
memport bundle --from claude --scope project --project ./demo-shop --out ./demo-bundle
memport bundle --from claude --scope project --project ./demo-shop --out ./demo-bundle --apply

# 3. Render that bundle into Codex's AGENTS.md (plan first, then apply)
memport apply --bundle ./demo-bundle --to codex --scope project --project ./demo-shop
memport apply --bundle ./demo-bundle --to codex --scope project --project ./demo-shop --apply

# 4. Or do both steps at once (bundle kept at --out, else a temp dir)
memport convert --from cursor --to claude --scope project --project ./demo-shop --out ./conv-bundle --apply

# 5. Merge two bundles, inspect, validate, list
memport merge ./bundle-a ./bundle-b --out ./merged --apply
memport validate ./merged
memport list ./merged --kind decision
```

**Plan mode is the default.** `bundle`, `apply`, `convert` and `merge`
print exactly what would change — files, item counts, lossy warnings,
conflicts — and write nothing until you pass `--apply`. One documented
exception: `convert` always materializes its intermediate bundle (a
temp dir, or `--out` if given) so the plan can be computed; only the
target-tool write is plan-gated. The intermediate bundle is kept, not
cleaned up — delete it yourself when you are done with it.

**Scope is never guessed.** Project scope requires `--project <dir>`;
without `--scope` and without `--project`, `bundle`/`apply`/`convert`
refuse rather than write to the wrong scope. User-scope targets:

| Tool | User target | Project target |
|---|---|---|
| Claude | `~/.claude/rules/memport.md` | `<project>/.claude/rules/memport.md` |
| Codex | `~/.codex/AGENTS.md` (delimited section) | `<project>/AGENTS.md` (delimited section) |
| Cursor | — (User Rules live in settings, not files) | `<project>/.cursor/rules/memport.mdc` |

Environment overrides: `CLAUDE_CONFIG_DIR` (default `~/.claude`),
`CODEX_HOME` (default `~/.codex`).

## Architecture

Single npm package `@tamtunnel/memport`, TypeScript on Node 22+ LTS,
**zero runtime dependencies**. The format library is the core; the CLI
is a thin shell over it.

```
src/
  format.ts      memport/1 manifest + item schema, read/write/validate
  frontmatter.ts minimal YAML-subset parser/serializer (tolerant reads)
  ulid.ts        ULID generation/validation (Crockford base32, no deps)
  merge.ts       deterministic merge engine (FORMAT.md § merge rules)
  render.ts      renderers + write discipline (markers, backups, losses)
  scan.ts        read-only store discovery
  secrets.ts     high-confidence secret-pattern flagging
  cli.ts         scan/bundle/apply/convert/merge/validate/list
  adapters/
    common.ts    shared collector helpers, home-dir resolution
    claude.ts    CLAUDE.md layers, .claude/rules/, auto-memory
    codex.ts     AGENTS.md chain (32 KiB budget), memories summaries
    cursor.ts    .cursor/rules/*.mdc, .cursorrules, repo AGENTS.md
```

Write discipline (see FORMAT.md for the full rules):

- Own files (`memport.md`, `memport.mdc`) are regenerated whole on
  each apply; shared files (`AGENTS.md`) get exactly one delimited
  section between `<!-- BEGIN MEMPORT -->` and `<!-- END MEMPORT -->`.
  Re-runs replace only that section. Missing, duplicated, misordered,
  or code-fenced markers make apply **refuse** — it never appends a
  second section and never rewrites surrounding content.
- Before the first write to any target file, Memport copies it to
  `<file>.memport-bak`. An existing backup is never overwritten
  without `--force`. A second apply that changes nothing writes
  nothing.
- Item bodies containing a literal marker line are escaped in rendered
  output (and reported in the plan), so they can never break section
  parsing or escape the delimited section on a later apply.
- Every rendered item carries a visible provenance line (source tool,
  path, origin, kind, scope, id) — not an HTML comment, because
  Claude strips HTML comments before injection.
- Secret-pattern flagging: `apply` and `convert` scan item bodies for
  high-confidence secret shapes and list matches in the plan.
  `--apply` refuses when any item is flagged unless `--allow-secrets`
  is passed. This is a safety net, not a guarantee — Memport cannot
  detect every secret shape.

## FAQs

**Does Memport phone home?**
No. The shipped source contains no network calls (`fetch`, `http`,
`net` — only `fs`, `os`, `path`, `crypto`, `url` from Node). No
telemetry, no accounts, no daemon.

**Can I share a bundle?**
A bundle is a plain directory: anyone who receives it receives its
contents, exactly like a dotfiles repo. Treat bundles as private.
Redact `source_path` in `memport.json` before sharing (it may leak
machine paths), and review secret flags before exporting.

**Why a directory and not a single file?**
So every item stays readable, editable, diffable and greppable — the
properties that make a memory store trustworthy. Copy the directory
or check it into git; that is the portable artifact.

**Do item ids survive a round trip?**
Bundle → bundle identity is guaranteed. Target round trips are not:
formats that preserve frontmatter (Claude topic files, Cursor `.mdc`)
keep the id, so re-import recovers it; formats that don't (AGENTS.md
sections, Claude rules files) mint new ids on re-import unless the
idempotence rule matches (same source tool, source path, normalized
title). The plan output says this plainly for Codex exports.

**Why doesn't Memport write Claude auto-memory topic files?**
Writing `MEMORY.md` correctly means respecting its 200-line/25 KB
index budget and topic-file discipline. That is v1.1 work; v1 exports
to Claude as an always-loaded rules file and says so in the plan.

**What about Cursor User/Team Rules?**
They live in Cursor settings, not in files, and there is no documented
file location for them. V1 does not touch them.

**What about Windows?**
The code is path-portable (`os.homedir()` plus the `CODEX_HOME` /
`CLAUDE_CONFIG_DIR` overrides), but v1 is tested on macOS/Linux.
Windows is best-effort until tested.

**What if a vendor changes a format?**
Memport fails loudly: an unrecognized layout is a hard error, never a
silent partial import. Adapters are thin and isolated (one file per
tool), so drift is a one-file fix — but it is the product's permanent
maintenance cost, and versions are re-verified on each release.

**Should I import bundles from repos I don't trust?**
No. Imported items become another tool's context, and in the rules
targets they become instructions. A crafted item could carry an
instruction override. Memport keeps provenance visible and shows every
item in the plan before any write, but it cannot sanitize meaning —
review the plan on first import from any new source.

## Best practices

- Always read the plan output before `--apply`, especially the loss
  classes and secret flags.
- Keep bundles in git: they are small text files, and history is the
  audit trail merges preserve.
- Re-import regularly; never assume a bundle is fresh.
- Curate before exporting to Codex: the 32 KiB chain budget is real,
  and the plan warns with the computed size.
- Back up your tool files yourself before the first apply, even
  though Memport creates `.memport-bak` copies — belt and suspenders.
- When two tools disagree, adjudicate in the bundle (edit the item,
  supersede the loser) rather than editing rendered files, which the
  next apply will regenerate.

## See also

- `FORMAT.md` — the `memport/1` bundle spec, merge rules, validation.
- `MAPPINGS.md` — per-tool mappings, the loss table, scope matrix.
