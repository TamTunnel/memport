// Read-only discovery (assessment §3.4 `scan`). Never writes, exits 0
// even when a tool is absent. Counts come from the same collectors the
// bundle command uses, so scan and bundle cannot disagree.

import * as fs from "node:fs";
import * as path from "node:path";
import { collectClaude } from "./adapters/claude.ts";
import { collectCodex } from "./adapters/codex.ts";
import { collectCursor } from "./adapters/cursor.ts";
import { claudeHome, codexHome } from "./adapters/common.ts";
import type { ItemKind } from "./format.ts";

export interface ToolLocation {
  path: string;
  exists: boolean;
}

export interface ToolScan {
  tool: "claude" | "codex" | "cursor";
  userLocations: ToolLocation[];
  projectLocations: ToolLocation[];
  found: boolean;
  countsByKind: Partial<Record<ItemKind, number>>;
  total: number;
  warnings: string[];
  notes: string[];
}

function kindCounts(items: { meta: { kind: ItemKind } }[]): Partial<Record<ItemKind, number>> {
  const out: Partial<Record<ItemKind, number>> = {};
  for (const item of items) {
    out[item.meta.kind] = (out[item.meta.kind] ?? 0) + 1;
  }
  return out;
}

function loc(p: string): ToolLocation {
  return { path: p, exists: fs.existsSync(p) };
}

export interface ScanOptions {
  projectDir: string;
  claudeHomeDir?: string;
  codexHomeDir?: string;
}

export function scanStores(opts: ScanOptions): ToolScan[] {
  const ch = opts.claudeHomeDir ?? claudeHome();
  const xh = opts.codexHomeDir ?? codexHome();
  const projectDir = opts.projectDir;
  const results: ToolScan[] = [];

  // Claude.
  {
    const warnings: string[] = [];
    const notes: string[] = [];
    let total = 0;
    let counts: Partial<Record<ItemKind, number>> = {};
    let found = false;
    for (const scope of ["user", "project"] as const) {
      try {
        const collected = collectClaude({
          scope,
          projectDir: scope === "project" ? projectDir : undefined,
          home: ch,
        });
        found = true;
        total += collected.items.length;
        const c = kindCounts(collected.items);
        for (const [k, v] of Object.entries(c)) counts[k as ItemKind] = (counts[k as ItemKind] ?? 0) + (v ?? 0);
        warnings.push(...collected.warnings);
      } catch {
        // Absent store: not an error for scan.
      }
    }
    results.push({
      tool: "claude",
      userLocations: [loc(path.join(ch, "CLAUDE.md")), loc(path.join(ch, "rules"))],
      projectLocations: [
        loc(path.join(projectDir, "CLAUDE.md")),
        loc(path.join(projectDir, ".claude", "CLAUDE.md")),
        loc(path.join(projectDir, ".claude", "rules")),
        loc(path.join(ch, "projects")),
      ],
      found,
      countsByKind: counts,
      total,
      warnings,
      notes,
    });
  }

  // Codex.
  {
    const warnings: string[] = [];
    const notes: string[] = ["Codex memories are generated state; import is summaries-only."];
    let total = 0;
    let counts: Partial<Record<ItemKind, number>> = {};
    let found = false;
    for (const scope of ["user", "project"] as const) {
      try {
        const collected = collectCodex({
          scope,
          projectDir: scope === "project" ? projectDir : undefined,
          home: xh,
        });
        found = true;
        total += collected.items.length;
        const c = kindCounts(collected.items);
        for (const [k, v] of Object.entries(c)) counts[k as ItemKind] = (counts[k as ItemKind] ?? 0) + (v ?? 0);
        warnings.push(...collected.warnings);
      } catch {
        // Absent store: not an error for scan.
      }
    }
    results.push({
      tool: "codex",
      userLocations: [loc(path.join(xh, "AGENTS.md")), loc(path.join(xh, "memories"))],
      projectLocations: [loc(path.join(projectDir, "AGENTS.md"))],
      found,
      countsByKind: counts,
      total,
      warnings,
      notes,
    });
  }

  // Cursor.
  {
    const warnings: string[] = [];
    const notes: string[] = [
      "Cursor has no durable memory store in current versions (Memories removed in 2.1.x); rules only.",
    ];
    let total = 0;
    let counts: Partial<Record<ItemKind, number>> = {};
    let found = false;
    try {
      const collected = collectCursor({ scope: "project", projectDir });
      found = true;
      total = collected.items.length;
      counts = kindCounts(collected.items);
      warnings.push(...collected.warnings);
    } catch {
      // Absent store: not an error for scan.
    }
    results.push({
      tool: "cursor",
      userLocations: [],
      projectLocations: [
        loc(path.join(projectDir, ".cursor", "rules")),
        loc(path.join(projectDir, ".cursorrules")),
        loc(path.join(projectDir, "AGENTS.md")),
      ],
      found,
      countsByKind: counts,
      total,
      warnings,
      notes,
    });
  }

  return results;
}
