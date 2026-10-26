// Renderers + write discipline (assessment §3.3, §3.6).
// - Own files (Claude memport.md, Cursor memport.mdc) are regenerated
//   whole on each apply.
// - Shared files (AGENTS.md) get one delimited Memport section; re-runs
//   replace only that section. Missing/duplicated/misordered markers,
//   or markers inside a fenced code block, make apply REFUSE (fail closed).
// - Backups: before the first write to a target file, copy it to
//   <file>.memport-bak. An existing backup is never overwritten without
//   --force. A second apply that changes nothing writes nothing.
// - Item bodies containing a literal marker line are ESCAPED in rendered
//   output (and reported in the plan) so they can never break section
//   parsing or escape the delimited section on a later apply.
// - Provenance: every rendered item carries a VISIBLE provenance line
//   (HTML comments are stripped by Claude before injection, so comments
//   alone would hide provenance from the receiving tool).

import * as fs from "node:fs";
import * as path from "node:path";
import {
  MemportError,
  type MemportItem,
  type LoadedBundle,
  validateBundle,
} from "./format.ts";
import { findSecrets, type SecretMatch } from "./secrets.ts";
import { claudeHome, codexHome } from "./adapters/common.ts";
import { chainTotalBytes, inspectCodexChain, pickChainFile } from "./adapters/codex.ts";

export const BEGIN_MARKER = "<!-- BEGIN MEMPORT -->";
export const END_MARKER = "<!-- END MEMPORT -->";
export const BACKUP_SUFFIX = ".memport-bak";

export interface TargetOptions {
  tool: "claude" | "codex" | "cursor";
  scope: "user" | "project";
  projectDir?: string;
  claudeHomeDir?: string;
  codexHomeDir?: string;
}

/** Resolve the exact target path for a (tool, scope) pair. Throws for
 *  Cursor user scope (User Rules live in settings, not files). */
export function targetFor(opts: TargetOptions): string {
  const ch = opts.claudeHomeDir ?? claudeHome();
  const xh = opts.codexHomeDir ?? codexHome();
  if (opts.tool === "claude") {
    if (opts.scope === "user") return path.join(ch, "rules", "memport.md");
    if (!opts.projectDir) throw new MemportError("Claude project apply requires --project <dir>");
    return path.join(opts.projectDir, ".claude", "rules", "memport.md");
  }
  if (opts.tool === "codex") {
    if (opts.scope === "user") return path.join(xh, "AGENTS.md");
    if (!opts.projectDir) throw new MemportError("Codex project apply requires --project <dir>");
    return path.join(opts.projectDir, "AGENTS.md");
  }
  // cursor
  if (opts.scope === "user") {
    throw new MemportError(
      "Cursor has no user-level rules file (User Rules live in settings) — apply with --scope project instead.",
    );
  }
  if (!opts.projectDir) throw new MemportError("Cursor project apply requires --project <dir>");
  return path.join(opts.projectDir, ".cursor", "rules", "memport.mdc");
}

/** Escape exact marker lines inside an item body. Mid-line occurrences
 *  are inert (marker scanning matches whole lines only) and left alone. */
export function escapeMarkerLines(body: string): { text: string; escaped: boolean } {
  let escaped = false;
  const lines = body.split("\n").map((line) => {
    const trimmed = line.trim();
    if (trimmed === BEGIN_MARKER || trimmed === END_MARKER) {
      escaped = true;
      return "<!-- MEMPORT MARKER (escaped, was a section marker line) -->";
    }
    return line;
  });
  return { text: lines.join("\n"), escaped };
}

export function provenanceLine(item: MemportItem): string {
  const from = item.meta.source_path
    ? `${item.meta.source_tool} (${item.meta.source_path})`
    : `${item.meta.source_tool} (hand-written)`;
  return (
    `*Memport · id ${item.meta.id} · from ${from} · ` +
    `origin ${item.meta.origin} · kind ${item.meta.kind} · scope ${item.meta.scope}*`
  );
}

export function renderItemMarkdown(item: MemportItem): string {
  const { text } = escapeMarkerLines(item.body.trim());
  return `## ${item.meta.title}\n\n${provenanceLine(item)}\n\n${text}`;
}

/** Render active items to one markdown document. Returns the text and
 *  the titles of items whose bodies had marker lines escaped. */
export function renderDocument(items: MemportItem[]): { text: string; escapedTitles: string[] } {
  const escapedTitles: string[] = [];
  const parts: string[] = [];
  const sorted = [...items].sort((a, b) => {
    if (a.meta.title < b.meta.title) return -1;
    if (a.meta.title > b.meta.title) return 1;
    return a.meta.id < b.meta.id ? -1 : 1;
  });
  for (const item of sorted) {
    const { text, escaped } = escapeMarkerLines(item.body.trim());
    if (escaped) escapedTitles.push(item.meta.title);
    parts.push(`## ${item.meta.title}\n\n${provenanceLine(item)}\n\n${text}`);
  }
  return { text: parts.length > 0 ? parts.join("\n\n") + "\n" : "", escapedTitles };
}

export interface WritePlan {
  target: string;
  action: "create" | "replace" | "noop" | "refuse";
  refuseReason?: string;
  /** Backup path that will be created (null when no backup needed). */
  backup: string | null;
  backupExists: boolean;
  /** Full new file content for create/replace. */
  content?: string;
}

function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function backupPlan(target: string, force: boolean): { backup: string | null; backupExists: boolean } {
  const backup = target + BACKUP_SUFFIX;
  const exists = fs.existsSync(backup);
  if (!fs.existsSync(target)) return { backup: null, backupExists: exists };
  if (exists && !force) return { backup: null, backupExists: true };
  return { backup, backupExists: exists };
}

/** Plan a whole-file write (own files). Never writes. */
export function planOwnFile(target: string, content: string, force: boolean): WritePlan {
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(target, "utf8");
  } catch {
    existing = null;
  }
  if (existing !== null && existing === content) {
    return { target, action: "noop", backup: null, backupExists: fs.existsSync(target + BACKUP_SUFFIX) };
  }
  const bp = backupPlan(target, force);
  return {
    target,
    action: existing === null ? "create" : "replace",
    backup: bp.backup,
    backupExists: bp.backupExists,
    content,
  };
}

/** Find marker lines, refusing on duplication, wrong order, or markers
 *  inside fenced code blocks. Returns indices or a refusal reason. */
export function scanMarkers(
  lines: string[],
): { begin: number; end: number } | { refuse: string } {
  let fence: { char: string; len: number } | null = null;
  const begins: number[] = [];
  const ends: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const fenceMatch = /^(```+|~~~+)/.exec(trimmed);
    if (fenceMatch) {
      const char = fenceMatch[1][0];
      const len = fenceMatch[1].length;
      if (fence && fence.char === char && len >= fence.len) {
        fence = null;
      } else if (!fence) {
        fence = { char, len };
      }
      continue;
    }
    if (trimmed === BEGIN_MARKER || trimmed === END_MARKER) {
      if (fence) {
        return { refuse: `Memport marker on line ${i + 1} is inside a fenced code block — refusing` };
      }
      if (trimmed === BEGIN_MARKER) begins.push(i);
      else ends.push(i);
    }
  }
  if (begins.length === 0 && ends.length === 0) return { begin: -1, end: -1 };
  if (begins.length !== 1 || ends.length !== 1) {
    return { refuse: `duplicated Memport markers (begin: ${begins.length}, end: ${ends.length}) — refusing` };
  }
  if (begins[0] > ends[0]) {
    return { refuse: "Memport end marker appears before the begin marker — refusing" };
  }
  return { begin: begins[0], end: ends[0] };
}

/** Byte length of the existing Memport section in a file (0 when the
 *  file has no markers or cannot be read). Used to compute chain size
 *  after a replace (replace, not add). */
export function existingSectionBytes(target: string): number {
  try {
    const text = fs.readFileSync(target, "utf8");
    const eol = detectEol(text);
    const lines = text.split(eol);
    const bodyLines = lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
    const scanned = scanMarkers(bodyLines);
    if ("refuse" in scanned || scanned.begin === -1) return 0;
    const section = bodyLines.slice(scanned.begin, scanned.end + 1).join(eol) + eol;
    return Buffer.byteLength(section, "utf8");
  } catch {
    return 0;
  }
}

/** Plan a delimited-section write into a shared file. Never writes. */
export function planDelimitedSection(target: string, sectionDoc: string, force: boolean): WritePlan {
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(target, "utf8");
  } catch {
    existing = null;
  }
  if (existing === null) {
    const content = `${BEGIN_MARKER}\n${sectionDoc}${END_MARKER}\n`;
    return { target, action: "create", backup: null, backupExists: false, content };
  }
  const eol = detectEol(existing);
  const lines = existing.split(eol);
  // Drop the phantom empty line produced by a trailing EOL.
  const hasTrailing = lines.length > 0 && lines[lines.length - 1] === "";
  const bodyLines = hasTrailing ? lines.slice(0, -1) : lines;
  const scanned = scanMarkers(bodyLines);
  if ("refuse" in scanned) {
    return { target, action: "refuse", refuseReason: scanned.refuse, backup: null, backupExists: false };
  }
  const sectionLines = sectionDoc.split("\n").filter((l, i, a) => !(i === a.length - 1 && l === ""));
  let newLines: string[];
  if (scanned.begin === -1) {
    newLines = [...bodyLines, "", BEGIN_MARKER, ...sectionLines, END_MARKER];
  } else {
    newLines = [
      ...bodyLines.slice(0, scanned.begin),
      BEGIN_MARKER,
      ...sectionLines,
      END_MARKER,
      ...bodyLines.slice(scanned.end + 1),
    ];
  }
  const content = newLines.join(eol) + eol;
  if (content === existing) {
    return { target, action: "noop", backup: null, backupExists: fs.existsSync(target + BACKUP_SUFFIX) };
  }
  const bp = backupPlan(target, force);
  return { target, action: "replace", backup: bp.backup, backupExists: bp.backupExists, content };
}

/** Execute a create/replace plan: backup (unless noop/refuse), then write. */
export function executeWrite(plan: WritePlan): void {
  if (plan.action === "noop" || plan.action === "refuse" || plan.content === undefined) return;
  fs.mkdirSync(path.dirname(plan.target), { recursive: true });
  if (plan.backup !== null) {
    fs.copyFileSync(plan.target, plan.backup);
  }
  fs.writeFileSync(plan.target, plan.content, "utf8");
}

export interface PlanLoss {
  class: string;
  count: number;
  examples: string[];
}

function addLoss(map: Map<string, string[]>, cls: string, title: string): void {
  const list = map.get(cls) ?? [];
  if (list.length < 3) list.push(title);
  map.set(cls, list);
}

/** Loss classes (§3.5) for rendering items into a target tool. Counts
 *  are per item; examples are the first three titles per class. */
export function computeLosses(items: MemportItem[], targetTool: string): PlanLoss[] {
  const counts = new Map<string, number>();
  const examples = new Map<string, string[]>();
  const bump = (cls: string, title: string) => {
    counts.set(cls, (counts.get(cls) ?? 0) + 1);
    addLoss(examples, cls, title);
  };
  for (const item of items) {
    const sk = item.meta.source_kind ?? "";
    if (sk.startsWith("claude:type:") && item.meta.kind !== "reference") {
      bump("claude-type-flattened", item.meta.title);
    }
    if (sk.startsWith("cursor:")) {
      bump("cursor-activation-flattened", item.meta.title);
    }
    if ((item.meta.tags ?? []).includes("codex-generated")) {
      bump("codex-summary-coarse", item.meta.title);
    }
    if (targetTool === "codex") {
      bump("rendered-as-instructions", item.meta.title);
    }
    if (targetTool === "claude" && item.meta.origin === "agent-learned") {
      bump("learned-becomes-always-loaded-rule", item.meta.title);
    }
  }
  return [...counts.entries()].map(([cls, count]) => ({
    class: cls,
    count,
    examples: examples.get(cls) ?? [],
  }));
}

export interface ApplyPlan {
  target: string;
  action: "create" | "replace" | "noop" | "refuse";
  refuseReason?: string;
  backup: string | null;
  backupExists: boolean;
  renderedCount: number;
  skippedSuperseded: number;
  skippedDisputed: number;
  losses: PlanLoss[];
  secretFlags: { title: string; matches: SecretMatch[] }[];
  warnings: string[];
  escapedTitles: string[];
  writePlan: WritePlan;
}

export interface ApplyOptions {
  tool: "claude" | "codex" | "cursor";
  scope: "user" | "project";
  projectDir?: string;
  force?: boolean;
  claudeHomeDir?: string;
  codexHomeDir?: string;
}

/** Build the full apply plan for a bundle (no writes). Refuses on an
 *  invalid bundle or corrupted markers. Secret flags are reported here;
 *  the CLI enforces the --allow-secrets refusal. */
export function planApply(bundle: LoadedBundle, opts: ApplyOptions): ApplyPlan {
  const errors = validateBundle(bundle.dir);
  if (errors.length > 0) {
    throw new MemportError(`refusing to apply invalid bundle:\n${errors.join("\n")}`);
  }
  const target = targetFor(opts);
  const active = bundle.items.filter((it) => it.meta.status === "active");
  const skippedSuperseded = bundle.items.filter((it) => it.meta.status === "superseded").length;
  const skippedDisputed = bundle.items.filter((it) => it.meta.status === "disputed").length;
  if (active.length === 0) {
    const noopPlan: WritePlan = {
      target,
      action: "noop",
      backup: null,
      backupExists: fs.existsSync(target + BACKUP_SUFFIX),
    };
    return {
      target,
      action: "noop",
      backup: null,
      backupExists: noopPlan.backupExists,
      renderedCount: 0,
      skippedSuperseded,
      skippedDisputed,
      losses: [],
      secretFlags: [],
      warnings: ["no active items to render — nothing will be written"],
      escapedTitles: [],
      writePlan: noopPlan,
    };
  }
  const { text: doc, escapedTitles } = renderDocument(active);
  const losses = computeLosses(active, opts.tool);
  const secretFlags: ApplyPlan["secretFlags"] = [];
  for (const item of active) {
    const matches = findSecrets(item.body);
    if (matches.length > 0) secretFlags.push({ title: item.meta.title, matches });
  }
  const warnings: string[] = [];
  if (escapedTitles.length > 0) {
    warnings.push(
      `${escapedTitles.length} item body(ies) contained a literal Memport marker line; escaped in rendered output (${escapedTitles.slice(0, 3).join(", ")})`,
    );
  }
  if (skippedSuperseded > 0) warnings.push(`${skippedSuperseded} superseded item(s) skipped (not rendered)`);
  if (skippedDisputed > 0) warnings.push(`${skippedDisputed} disputed item(s) skipped (not rendered)`);
  const force = opts.force ?? false;
  let writePlan: WritePlan;
  if (opts.tool === "codex") {
    writePlan = planDelimitedSection(target, doc, force);
    // Chain budget: current chain total, minus the section a replace
    // would remove, plus the new section. Warn when the result exceeds
    // Codex's 32 KiB truncation budget.
    const chainFiles = inspectCodexChain(
      opts.scope === "project" ? (opts.projectDir ?? null) : null,
      opts.codexHomeDir ?? codexHome(),
    );
    const newSectionBytes = Buffer.byteLength(`${BEGIN_MARKER}\n${doc}${END_MARKER}\n`, "utf8");
    const after = chainTotalBytes(chainFiles) - existingSectionBytes(target) + newSectionBytes;
    if (after > 32768) {
      warnings.push(
        `Codex chain would be ${after} bytes after this apply, over the 32768 byte budget — Codex itself truncates it.`,
      );
    }
    // Override trap: when AGENTS.override.md exists for the target dir,
    // Codex reads it instead of AGENTS.md, so this section would be ignored.
    const dirToCheck = opts.scope === "project" ? opts.projectDir : (opts.codexHomeDir ?? codexHome());
    if (dirToCheck) {
      const picked = pickChainFile(dirToCheck);
      if (picked && picked.role === "codex:override" && picked.file !== target) {
        warnings.push(
          `AGENTS.override.md exists at ${picked.file}; Codex reads the override, not AGENTS.md — this section would be ignored by Codex unless moved there.`,
        );
      }
    }
  } else if (opts.tool === "claude") {
    const header = "# Memport rules\n\n";
    writePlan = planOwnFile(target, header + doc, force);
  } else {
    const desc = `Memport import: ${active.length} item(s) from ${bundle.manifest.source_tool ?? "a bundle"}`;
    const content = `---\nalwaysApply: true\ndescription: ${JSON.stringify(desc)}\n---\n${doc}`;
    writePlan = planOwnFile(target, content, force);
  }
  return {
    target,
    action: writePlan.action,
    refuseReason: writePlan.refuseReason,
    backup: writePlan.backup,
    backupExists: writePlan.backupExists,
    renderedCount: active.length,
    skippedSuperseded,
    skippedDisputed,
    losses,
    secretFlags,
    warnings,
    escapedTitles,
    writePlan,
  };
}
