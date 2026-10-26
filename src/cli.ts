#!/usr/bin/env node
// memport CLI: scan, bundle, apply, convert, merge, validate, list.
// Central safety rule: mutating commands (bundle, apply, convert,
// merge) default to PLAN mode — they print exactly what would change
// and write nothing; --apply executes. scan, validate, and list are
// read-only. `convert` materializes its intermediate bundle in a temp
// dir (or --out) even in plan mode; that scratch dir is reported and
// is never a target-tool write. Intermediate bundles are KEPT, not
// cleaned up — the plan describes that bundle, and --apply users may
// want it for audit. Delete it yourself when you are done with it.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { collectClaude } from "./adapters/claude.ts";
import { collectCodex } from "./adapters/codex.ts";
import { collectCursor } from "./adapters/cursor.ts";
import type { CollectResult } from "./adapters/common.ts";
import {
  findExistingId,
  MemportError,
  readBundle,
  refuseSymlink,
  validateBundle,
  writeBundle,
  type MemportItem,
} from "./format.ts";
import { mergeBundles } from "./merge.ts";
import { planApply, executeWrite, type ApplyPlan } from "./render.ts";
import { scanStores } from "./scan.ts";

type Tool = "claude" | "codex" | "cursor";
type Scope = "user" | "project";

interface Flags {
  json: boolean;
  apply: boolean;
  force: boolean;
  allowSecrets: boolean;
  strict: boolean;
  help: boolean;
  from?: string;
  to?: string;
  scope?: string;
  project?: string;
  out?: string;
  bundle?: string;
  kind?: string;
}

const VALUE_FLAGS = new Set(["from", "to", "scope", "project", "out", "bundle", "kind"]);
const BOOL_FLAGS = new Set(["json", "apply", "force", "allow-secrets", "strict", "help"]);

const USAGE = `memport — portable agent-memory interchange (memport/1)

Usage:
  memport scan [--project <dir>] [--json]
  memport bundle --from <tool> [--scope user|project] [--project <dir>] --out <dir> [--apply] [--json]
  memport apply --bundle <dir> --to <tool> [--scope user|project] [--project <dir>] [--apply] [--force] [--allow-secrets] [--json]
  memport convert --from <tool> --to <tool> [--scope user|project] [--project <dir>] [--out <dir>] [--apply] [--force] [--allow-secrets] [--json]
  memport merge <bundleA> <bundleB> --out <dir> [--apply] [--strict] [--allow-secrets] [--json]
  memport validate <dir> [--json]
  memport list <dir> [--kind <kind>] [--scope <scope>] [--json]

Mutating commands default to plan mode: they print what would change and
write nothing. Pass --apply to execute. Scope: project scope requires
--project <dir>; without --scope and without --project, convert/apply/
bundle refuse rather than guess (writing to the wrong scope is the
quietest data-loss bug in this product). Environment: CLAUDE_CONFIG_DIR
(default ~/.claude), CODEX_HOME (default ~/.codex).
`;

function fail(message: string, code = 1): never {
  console.error(`memport: ${message}`);
  process.exit(code);
}

function parseArgs(argv: string[]): { command: string; positionals: string[]; flags: Flags } {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    process.exit(0);
  }
  const flags: Flags = {
    json: false,
    apply: false,
    force: false,
    allowSecrets: false,
    strict: false,
    help: false,
  };
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === "--help" || tok === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      const name = eq === -1 ? tok.slice(2) : tok.slice(2, eq);
      const inlineVal = eq === -1 ? undefined : tok.slice(eq + 1);
      if (BOOL_FLAGS.has(name)) {
        const key = (name === "allow-secrets" ? "allowSecrets" : name) as keyof Flags;
        (flags as unknown as Record<string, unknown>)[key] = true;
        continue;
      }
      if (VALUE_FLAGS.has(name)) {
        const val = inlineVal ?? rest[++i];
        if (val === undefined) fail(`flag --${name} requires a value`, 2);
        (flags as unknown as Record<string, unknown>)[name] = val;
        continue;
      }
      fail(`unknown flag ${tok}`, 2);
    }
    positionals.push(tok);
  }
  return { command, positionals, flags };
}

function parseTool(value: string | undefined, flag: string): Tool {
  if (value === "claude" || value === "codex" || value === "cursor") return value;
  fail(`--${flag} must be one of: claude, codex, cursor`, 2);
}

function resolveScope(flags: Flags): { scope: Scope; projectDir: string | undefined } {
  if (flags.scope !== undefined) {
    if (flags.scope !== "user" && flags.scope !== "project") {
      fail("--scope must be user or project", 2);
    }
    if (flags.scope === "project" && !flags.project) {
      fail("project scope requires --project <dir>", 2);
    }
    return { scope: flags.scope, projectDir: flags.project };
  }
  if (flags.project) return { scope: "project", projectDir: flags.project };
  fail("refusing to guess scope: pass --scope user|project (or --project <dir> to imply project scope)", 2);
}

function collect(tool: Tool, scope: Scope, projectDir: string | undefined): CollectResult {
  if (tool === "claude") return collectClaude({ scope, projectDir });
  if (tool === "codex") return collectCodex({ scope, projectDir });
  return collectCursor({ scope, projectDir });
}

function importLosses(items: MemportItem[]): { class: string; count: number; examples: string[] }[] {
  const counts = new Map<string, { n: number; ex: string[] }>();
  const bump = (cls: string, title: string) => {
    const e = counts.get(cls) ?? { n: 0, ex: [] };
    e.n++;
    if (e.ex.length < 3) e.ex.push(title);
    counts.set(cls, e);
  };
  for (const item of items) {
    const sk = item.meta.source_kind ?? "";
    if (sk.startsWith("claude:type:") && item.meta.kind !== "reference") {
      bump("claude-type-flattened", item.meta.title);
    }
    if ((item.meta.tags ?? []).includes("codex-generated")) {
      bump("codex-summary-coarse", item.meta.title);
    }
  }
  return [...counts.entries()].map(([cls, e]) => ({ class: cls, count: e.n, examples: e.ex }));
}

function kindCounts(items: MemportItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[item.meta.kind] = (out[item.meta.kind] ?? 0) + 1;
  return out;
}

/** Merge freshly collected items into an output bundle dir, reusing ids
 *  for re-imports (source_tool, source_path, normalized title). Returns
 *  the merged item list plus counts. */
function mergeCollectedInto(
  collected: MemportItem[],
  outDir: string,
): { items: MemportItem[]; reused: number; added: number; kept: number } {
  let existing: MemportItem[] = [];
  const manifestPath = path.join(outDir, "memport.json");
  if (fs.existsSync(manifestPath)) {
    const loaded = readBundle(outDir);
    // H3: never merge into an unvalidated existing bundle — reading it
    // and rewriting fresh hashes would launder a forgery into a
    // valid-looking bundle. Refuse in plan mode too, so a forged item
    // is never reported as "kept".
    const errors = validateBundle(outDir);
    if (errors.length > 0) {
      throw new MemportError(`refusing to merge into invalid existing bundle at ${outDir}:\n${errors.join("\n")}`);
    }
    existing = loaded.items;
  } else if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
    throw new MemportError(`--out ${outDir} exists and is not a memport bundle (refusing to write into it)`);
  }
  let reused = 0;
  let added = 0;
  const merged: MemportItem[] = [...existing];
  for (const item of collected) {
    const match = findExistingId(existing, item.meta.source_tool, item.meta.source_path ?? "", item.meta.title);
    if (match) {
      reused++;
      const idx = merged.indexOf(match);
      // Re-import idempotence: the existing id is kept, and so is its
      // status — re-import must not silently reactivate a superseded
      // or disputed item.
      merged[idx] = {
        meta: { ...item.meta, id: match.meta.id, created: match.meta.created, updated: new Date().toISOString(), status: match.meta.status },
        body: item.body,
      };
    } else {
      added++;
      merged.push(item);
    }
  }
  return { items: merged, reused, added, kept: existing.length };
}

function printPlanOrJson(flags: Flags, human: string, jsonObj: unknown): void {
  if (flags.json) console.log(JSON.stringify(jsonObj, null, 2));
  else console.log(human);
}

function formatLosses(losses: { class: string; count: number; examples: string[] }[]): string {
  if (losses.length === 0) return "  (none)";
  return losses.map((l) => `  - ${l.class}: ${l.count} (e.g. ${l.examples.join(", ")})`).join("\n");
}

function cmdScan(flags: Flags): void {
  const projectDir = flags.project ?? process.cwd();
  const scans = scanStores({ projectDir });
  const jsonObj = { project: projectDir, tools: scans };
  let human = `Scan (project: ${projectDir})\n`;
  for (const s of scans) {
    human += `\n${s.tool}: ${s.found ? `${s.total} item(s)` : "store not found"}\n`;
    for (const loc of [...s.userLocations, ...s.projectLocations]) {
      human += `  ${loc.exists ? "found " : "absent"} ${loc.path}\n`;
    }
    if (s.found) {
      const kinds = Object.entries(s.countsByKind)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      human += `  kinds: ${kinds || "(none)"}\n`;
    }
    for (const w of s.warnings) human += `  warning: ${w}\n`;
    for (const n of s.notes) human += `  note: ${n}\n`;
  }
  printPlanOrJson(flags, human.trimEnd(), jsonObj);
}

function cmdBundle(flags: Flags): void {
  const tool = parseTool(flags.from, "from");
  if (!flags.out) fail("bundle requires --out <dir>", 2);
  const { scope, projectDir } = resolveScope(flags);
  const collected = collect(tool, scope, projectDir);
  const merged = mergeCollectedInto(collected.items, flags.out);
  const losses = importLosses(collected.items);
  const jsonObj = {
    mode: flags.apply ? "applied" : "plan",
    from: tool,
    scope,
    project: projectDir ?? null,
    out: flags.out,
    collected: collected.items.length,
    reused: merged.reused,
    added: merged.added,
    kept: merged.kept,
    kinds: kindCounts(collected.items),
    warnings: collected.warnings,
    losses,
    sources: collected.sources,
  };
  let human = `Bundle plan: ${tool} (${scope}) → ${flags.out}\n`;
  human += `  collected: ${collected.items.length} item(s) (${Object.entries(kindCounts(collected.items)).map(([k, v]) => `${k}=${v}`).join(", ") || "none"})\n`;
  human += `  reused ids: ${merged.reused}, new: ${merged.added}, kept from existing bundle: ${merged.kept}\n`;
  for (const w of collected.warnings) human += `  warning: ${w}\n`;
  human += `  import losses:\n${formatLosses(losses)}\n`;
  if (collected.ignoredMd !== undefined && collected.ignoredMd > 0) {
    human += `  ignored plain .md files: ${collected.ignoredMd}\n`;
  }
  if (!flags.apply) {
    human += "  PLAN MODE: nothing written. Pass --apply to write the bundle.";
    printPlanOrJson(flags, human, jsonObj);
    return;
  }
  writeBundle(flags.out, merged.items, {
    source_tool: tool,
    source_path: projectDir ?? null,
    project: scope === "project" ? (projectDir ?? null) : null,
    notes: collected.sources.map((s) => `read ${s}`),
  });
  human += `  WROTE bundle to ${flags.out} (${merged.items.length} items).`;
  printPlanOrJson(flags, human, jsonObj);
}

function printApplyPlan(flags: Flags, plan: ApplyPlan, extra: Record<string, unknown>): void {
  const jsonObj = {
    mode: flags.apply ? "applied" : "plan",
    target: plan.target,
    action: plan.action,
    refuseReason: plan.refuseReason ?? null,
    backup: plan.backup,
    backupExists: plan.backupExists,
    rendered: plan.renderedCount,
    renderedItems: plan.renderedItems,
    skippedSuperseded: plan.skippedSuperseded,
    skippedDisputed: plan.skippedDisputed,
    losses: plan.losses,
    secretFlags: plan.secretFlags,
    warnings: plan.warnings,
    ...extra,
  };
  let human = `Apply plan → ${plan.target}\n`;
  human += `  action: ${plan.action}${plan.refuseReason ? ` (${plan.refuseReason})` : ""}\n`;
  if (plan.backup) human += `  backup: will create ${plan.backup}\n`;
  else if (plan.backupExists) human += `  backup: existing backup kept (not overwritten; pass --force to replace)\n`;
  else if (plan.action !== "noop") human += `  backup: none needed (target does not exist yet)\n`;
  human += `  rendered: ${plan.renderedCount} active item(s); skipped: ${plan.skippedSuperseded} superseded, ${plan.skippedDisputed} disputed\n`;
  for (const it of plan.renderedItems) {
    human += `    - ${it.title} (${it.id})\n`;
  }
  human += `  losses:\n${formatLosses(plan.losses)}\n`;
  if (plan.secretFlags.length > 0) {
    human += `  SECRET FLAGS (review before applying):\n`;
    for (const f of plan.secretFlags) {
      human += `    - ${f.title}: ${f.patterns.join(", ")}\n`;
    }
  }
  for (const w of plan.warnings) human += `  warning: ${w}\n`;
  printPlanOrJson(flags, human.trimEnd(), jsonObj);
}

function cmdApply(flags: Flags): void {
  if (!flags.bundle) fail("apply requires --bundle <dir>", 2);
  const tool = parseTool(flags.to, "to");
  const { scope, projectDir } = resolveScope(flags);
  const bundle = readBundle(flags.bundle);
  const plan = planApply(bundle, { tool, scope, projectDir, force: flags.force });
  if (plan.action === "refuse") {
    printApplyPlan(flags, plan, {});
    fail(`apply refused: ${plan.refuseReason}`, 1);
  }
  if (plan.secretFlags.length > 0 && !flags.allowSecrets) {
    if (flags.apply) {
      printApplyPlan(flags, plan, {});
      fail("apply refused: secret-flagged items present; review the plan and pass --allow-secrets to proceed", 1);
    }
  }
  printApplyPlan(flags, plan, {});
  if (!flags.apply) {
    if (!flags.json) console.log("PLAN MODE: nothing written. Pass --apply to write.");
    return;
  }
  executeWrite(plan.writePlan);
  if (!flags.json) console.log(`WROTE ${plan.target} (${plan.action}).`);
}

function cmdConvert(flags: Flags): void {
  const from = parseTool(flags.from, "from");
  const to = parseTool(flags.to, "to");
  const { scope, projectDir } = resolveScope(flags);
  const collected = collect(from, scope, projectDir);
  // Materialize the intermediate bundle (temp dir, or --out). This is
  // scratch, not a target-tool write, and is reported either way.
  const bundleDir = flags.out ?? fs.mkdtempSync(path.join(os.tmpdir(), "memport-"));
  const merged = mergeCollectedInto(collected.items, bundleDir);
  writeBundle(bundleDir, merged.items, {
    source_tool: from,
    source_path: projectDir ?? null,
    project: scope === "project" ? (projectDir ?? null) : null,
    notes: collected.sources.map((s) => `read ${s}`),
  });
  const bundle = readBundle(bundleDir);
  const plan = planApply(bundle, { tool: to, scope, projectDir, force: flags.force });
  if (plan.action === "refuse") {
    if (!flags.json) {
      console.log(`Convert: intermediate bundle kept at ${bundleDir} (${merged.items.length} items).`);
    }
    printApplyPlan(flags, plan, { bundle: bundleDir, collected: collected.items.length });
    fail(`apply refused: ${plan.refuseReason}`, 1);
  }
  if (plan.secretFlags.length > 0 && !flags.allowSecrets && flags.apply) {
    printApplyPlan(flags, plan, { bundle: bundleDir, collected: collected.items.length });
    fail("apply refused: secret-flagged items present; review the plan and pass --allow-secrets to proceed", 1);
  }
  if (!flags.json) {
    console.log(`Convert: intermediate bundle kept at ${bundleDir} (${merged.items.length} items).`);
    for (const w of collected.warnings) console.log(`  import warning: ${w}`);
    console.log(`  import losses:\n${formatLosses(importLosses(collected.items))}`);
  }
  printApplyPlan(flags, plan, { bundle: bundleDir, collected: collected.items.length });
  if (!flags.apply) {
    if (!flags.json) console.log("PLAN MODE: nothing written to the target. Pass --apply to write.");
    return;
  }
  executeWrite(plan.writePlan);
  if (!flags.json) console.log(`WROTE ${plan.target} (${plan.action}).`);
}

function cmdMerge(flags: Flags, positionals: string[]): void {
  if (positionals.length !== 2) fail("merge requires exactly two bundle paths", 2);
  if (!flags.out) fail("merge requires --out <dir>", 2);
  const a = readBundle(positionals[0]);
  const b = readBundle(positionals[1]);
  const result = mergeBundles(a, b);
  const jsonObj = {
    mode: flags.apply ? "applied" : "plan",
    out: flags.out,
    outputItems: result.items.length,
    conflicts: result.conflicts,
    deduped: result.dedupedCount,
    possibleDuplicates: result.possibleDuplicates,
    secretFlags: result.secretFlags,
    supersededWinners: result.supersededWinners,
  };
  let human = `Merge plan: ${positionals[0]} + ${positionals[1]} → ${flags.out}\n`;
  human += `  output items: ${result.items.length}, deduped: ${result.dedupedCount}, conflicts: ${result.conflicts.length}, possible duplicates: ${result.possibleDuplicates.length}\n`;
  for (const c of result.conflicts) {
    const sup = result.supersededWinners.some((w) => w.id === c.id);
    human += `  conflict ${c.id}: winner "${c.winnerTitle}" over "${c.loserTitle}" (${c.reason}; loser preserved in merge-report.md)${sup ? " — winner is superseded; apply will skip it" : ""}\n`;
  }
  for (const p of result.possibleDuplicates) {
    human += `  possible duplicate "${p.title}": ${p.idA} and ${p.idB} (both kept)\n`;
  }
  if (result.secretFlags.length > 0) {
    human += `  SECRET FLAGS (review before sharing — merge-report.md preserves loser text verbatim and is NOT redacted):\n`;
    for (const f of result.secretFlags) {
      human += `    - ${f.role} ${f.id} "${f.title}": ${f.patterns.join(", ")}\n`;
    }
  }
  if (flags.strict && result.conflicts.length > 0) {
    printPlanOrJson(flags, human.trimEnd(), jsonObj);
    fail(`--strict: ${result.conflicts.length} conflict(s); nothing written`, 1);
  }
  if (!flags.apply) {
    human += "  PLAN MODE: nothing written. Pass --apply to write the merged bundle.";
    printPlanOrJson(flags, human.trimEnd(), jsonObj);
    return;
  }
  // H5 gate (same discipline as apply/convert): a merge that writes a
  // bundle whose report preserves secret-bearing loser text verbatim
  // needs an explicit override. Plan mode never refuses — it writes
  // nothing — so the flags above are the warning there.
  if (result.secretFlags.length > 0 && !flags.allowSecrets) {
    printPlanOrJson(flags, human.trimEnd(), jsonObj);
    fail("merge refused: secret-flagged items/losers present; review the plan and pass --allow-secrets to proceed", 1);
  }
  if (fs.existsSync(flags.out) && fs.readdirSync(flags.out).length > 0 && !fs.existsSync(path.join(flags.out, "memport.json"))) {
    fail(`--out ${flags.out} exists and is not a memport bundle (refusing to write into it)`, 1);
  }
  writeBundle(flags.out, result.items, {
    source_tool: "memport",
    source_path: null,
    project: result.project,
    notes: [`merged from ${positionals[0]} and ${positionals[1]}`],
  });
  // The report itself is a write target too: a planted symlink at
  // merge-report.md would route loser text (possibly secret-bearing)
  // into an arbitrary file. Refuse, like every other bundle write.
  refuseSymlink(path.join(flags.out, "merge-report.md"), "merge-report.md");
  fs.writeFileSync(path.join(flags.out, "merge-report.md"), result.report, "utf8");
  human += `  WROTE merged bundle to ${flags.out} (merge-report.md included).`;
  printPlanOrJson(flags, human.trimEnd(), jsonObj);
}

function cmdValidate(flags: Flags, positionals: string[]): void {
  if (positionals.length !== 1) fail("validate requires exactly one bundle path", 2);
  const errors = validateBundle(positionals[0]);
  if (errors.length > 0) {
    if (flags.json) console.log(JSON.stringify({ valid: false, errors }, null, 2));
    else {
      console.log(`INVALID ${positionals[0]}:`);
      for (const e of errors) console.log(`  - ${e}`);
    }
    process.exit(1);
  }
  const bundle = readBundle(positionals[0]);
  if (flags.json) console.log(JSON.stringify({ valid: true, items: bundle.items.length }, null, 2));
  else console.log(`VALID ${positionals[0]} (${bundle.items.length} items).`);
}

function cmdList(flags: Flags, positionals: string[]): void {
  if (positionals.length !== 1) fail("list requires exactly one bundle path", 2);
  const bundle = readBundle(positionals[0]);
  let items = bundle.items;
  if (flags.kind) items = items.filter((it) => it.meta.kind === flags.kind);
  if (flags.scope) items = items.filter((it) => it.meta.scope === flags.scope);
  // list is read-only, but it must not present an untrusted bundle as
  // legitimate: validate first and surface any failure prominently.
  const validationErrors = validateBundle(positionals[0]);
  if (flags.json) {
    console.log(JSON.stringify({ valid: validationErrors.length === 0, validationErrors, items: items.map((it) => ({ ...it.meta, body: it.body })) }, null, 2));
    return;
  }
  if (validationErrors.length > 0) {
    console.log(`WARNING: bundle ${positionals[0]} FAILED validation — contents below are untrusted:`);
    for (const e of validationErrors) console.log(`  - ${e}`);
  }
  if (items.length === 0) {
    console.log("(no items)");
    return;
  }
  for (const it of items) {
    console.log(`${it.meta.id} | ${it.meta.kind} | ${it.meta.title} | ${it.meta.scope} | ${it.meta.status} | ${it.meta.source_tool}`);
  }
}

export function main(argv: string[]): void {
  const { command, positionals, flags } = parseArgs(argv);
  try {
    switch (command) {
      case "scan":
        cmdScan(flags);
        break;
      case "bundle":
        cmdBundle(flags);
        break;
      case "apply":
        cmdApply(flags);
        break;
      case "convert":
        cmdConvert(flags);
        break;
      case "merge":
        cmdMerge(flags, positionals);
        break;
      case "validate":
        cmdValidate(flags, positionals);
        break;
      case "list":
        cmdList(flags, positionals);
        break;
      default:
        console.error(USAGE);
        fail(`unknown command: ${command}`, 2);
    }
  } catch (e) {
    if (e instanceof MemportError) fail(e.message, 1);
    throw e;
  }
}

import { fileURLToPath } from "node:url";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
