// Merge engine (assessment §3.4). Deterministic, no meaning-based
// resolution. Nothing is ever deleted by a merge.
//
// DEVIATION (documented in FORMAT.md): rule 2 says the conflict loser
// is "kept with status: superseded and the winner's supersedes points
// at it". A memport/1 bundle holds one file per id and validate()
// forbids duplicate ids, so two items cannot share one id in the
// output bundle. The loser is therefore preserved as its ORIGINAL FILE
// TEXT in merge-report.md (which ships inside the output bundle) and
// the winner's supersedes is left unset — a self-pointer would be a
// lie. The "nothing is ever deleted" guarantee holds: the loser text
// is in the output bundle, auditable, and re-importable by hand.
//
// Secret-bearing items are flagged (pattern names only) in the result
// and the report; the CLI gates merge --apply on --allow-secrets, the
// same discipline as apply/convert. Loser text is NOT redacted —
// redaction would break the audit guarantee — so a flagged merge must
// be reviewed before the output bundle is shared.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  normalizeBody,
  normalizeTitle,
  serializeItem,
  validateBundle,
  validateOutputItems,
  type LoadedBundle,
  type MemportItem,
  MemportError,
} from "./format.ts";
import { findSecrets } from "./secrets.ts";

export interface MergeConflict {
  id: string;
  winnerTitle: string;
  loserTitle: string;
  reason: string;
}

export interface PossibleDuplicate {
  idA: string;
  idB: string;
  title: string;
}

export interface MergeSecretFlag {
  id: string;
  title: string;
  role: "item" | "loser";
  /** Pattern names only — excerpts never leave the secrets module. */
  patterns: string[];
}

export interface MergeResult {
  items: MemportItem[];
  report: string;
  conflicts: MergeConflict[];
  dedupedCount: number;
  possibleDuplicates: PossibleDuplicate[];
  project: string | null;
  secretFlags: MergeSecretFlag[];
  /** Conflict winners whose status is not active (apply will skip them). */
  supersededWinners: { id: string; title: string }[];
}

const ORIGIN_RANK: Record<string, number> = {
  human: 0,
  "agent-learned": 1,
  imported: 2,
};

function originRank(origin: string): number {
  return ORIGIN_RANK[origin] ?? 3;
}

/** A superseded item has already lost once: it must not beat an active
 *  item back into the output, or apply would render nothing for that
 *  id. Status ranks before origin and recency. */
function statusRank(status: string): number {
  switch (status) {
    case "active":
      return 0;
    case "disputed":
      return 1;
    case "superseded":
      return 2;
    default:
      return 3;
  }
}

/** Conflict winner: status first, then origin rank, then newer
 *  updated, then bundle A. */
function pickWinner(a: MemportItem, b: MemportItem): { winner: MemportItem; loser: MemportItem; reason: string } {
  const sa = statusRank(a.meta.status);
  const sb = statusRank(b.meta.status);
  if (sa !== sb) {
    return sa < sb
      ? { winner: a, loser: b, reason: `status ${a.meta.status} beats ${b.meta.status}` }
      : { winner: b, loser: a, reason: `status ${b.meta.status} beats ${a.meta.status}` };
  }
  const ra = originRank(a.meta.origin);
  const rb = originRank(b.meta.origin);
  if (ra !== rb) {
    return ra < rb
      ? { winner: a, loser: b, reason: `origin ${a.meta.origin} beats ${b.meta.origin}` }
      : { winner: b, loser: a, reason: `origin ${b.meta.origin} beats ${a.meta.origin}` };
  }
  const ta = Date.parse(a.meta.updated);
  const tb = Date.parse(b.meta.updated);
  if (tb !== ta) {
    return tb > ta
      ? { winner: b, loser: a, reason: "newer updated wins" }
      : { winner: a, loser: b, reason: "newer updated wins" };
  }
  return { winner: a, loser: b, reason: "tie broken toward the first bundle" };
}

function earlier(a: MemportItem, b: MemportItem): MemportItem {
  const ta = Date.parse(a.meta.created);
  const tb = Date.parse(b.meta.created);
  if (ta !== tb) return ta < tb ? a : b;
  return a.meta.id < b.meta.id ? a : b;
}

export function mergeBundles(a: LoadedBundle, b: LoadedBundle): MergeResult {
  for (const [label, bundle] of [
    ["first", a],
    ["second", b],
  ] as const) {
    const errors = validateBundle(bundle.dir);
    if (errors.length > 0) {
      throw new MemportError(`refusing to merge invalid ${label} bundle:\n${errors.join("\n")}`);
    }
  }
  const conflicts: MergeConflict[] = [];
  const supersededVersions: { item: MemportItem; text: string }[] = [];
  const supersededWinners: { id: string; title: string }[] = [];
  const dedupedNotes: string[] = [];
  let dedupedCount = 0;

  // Original file text per item object, for verbatim loser preservation
  // in the report (re-serialization would reorder/normalize frontmatter
  // and could drop unknown fields). Inputs were validated above, so
  // these reads succeed; fall back to serialization if one ever fails.
  const originalText = new Map<MemportItem, string>();
  for (const bundle of [a, b]) {
    for (let i = 0; i < bundle.items.length; i++) {
      try {
        originalText.set(
          bundle.items[i],
          fs.readFileSync(path.join(bundle.dir, bundle.entries[i].file), "utf8"),
        );
      } catch {
        originalText.set(bundle.items[i], serializeItem(bundle.items[i]));
      }
    }
  }

  // Phase 1: same-id resolution. Inputs are validated first, so a
  // duplicate id can only occur ACROSS the two bundles; `existing` is
  // therefore always the first bundle's item at conflict time.
  const byId = new Map<string, MemportItem>();
  const pushSameId = (item: MemportItem) => {
    const existing = byId.get(item.meta.id);
    if (!existing) {
      byId.set(item.meta.id, item);
      return;
    }
    if (normalizeBody(existing.body) === normalizeBody(item.body)) {
      // Rule 1: identical normalized body → dedupe. Keep the active
      // copy when statuses differ (a superseded copy must not displace
      // an active one), else the newer updated copy; preserve the
      // earliest created timestamp.
      dedupedCount++;
      const sa = statusRank(existing.meta.status);
      const sb = statusRank(item.meta.status);
      let keeper: MemportItem;
      if (sa !== sb) keeper = sa < sb ? existing : item;
      else keeper = Date.parse(item.meta.updated) > Date.parse(existing.meta.updated) ? item : existing;
      const created =
        Date.parse(item.meta.created) < Date.parse(existing.meta.created)
          ? item.meta.created
          : existing.meta.created;
      byId.set(item.meta.id, {
        meta: { ...keeper.meta, created },
        body: keeper.body,
      });
      return;
    }
    // Rule 2: same id, different body → conflict.
    const { winner, loser, reason } = pickWinner(existing, item);
    conflicts.push({
      id: item.meta.id,
      winnerTitle: winner.meta.title,
      loserTitle: loser.meta.title,
      reason,
    });
    if (winner.meta.status !== "active") {
      supersededWinners.push({ id: winner.meta.id, title: winner.meta.title });
    }
    supersededVersions.push({ item: loser, text: originalText.get(loser) ?? serializeItem(loser) });
    byId.set(item.meta.id, winner);
  };
  for (const item of a.items) pushSameId(item);
  for (const item of b.items) pushSameId(item);

  // Phase 2: different-id identical (kind, scope, body) → dedupe to older id.
  const byContent = new Map<string, MemportItem>();
  const droppedInto = new Map<string, string>();
  const survivors: MemportItem[] = [];
  for (const item of byId.values()) {
    const key = `${item.meta.kind}\0${item.meta.scope}\0${normalizeBody(item.body)}`;
    const existing = byContent.get(key);
    if (!existing) {
      byContent.set(key, item);
      survivors.push(item);
      continue;
    }
    const keep = earlier(existing, item);
    const drop = keep === existing ? item : existing;
    dedupedCount++;
    droppedInto.set(drop.meta.id, keep.meta.id);
    dedupedNotes.push(
      `kept ${keep.meta.id} (${keep.meta.title}); dropped ${drop.meta.id} (source: ${drop.meta.source_tool}${drop.meta.source_path ? ` ${drop.meta.source_path}` : ""})`,
    );
    if (keep === item) {
      const idx = survivors.indexOf(existing);
      survivors[idx] = item;
      byContent.set(key, item);
    }
  }

  // Phase-2 fixup (H2): a survivor's supersedes may point at an id
  // deduped away above. Dropping the link (with a report note) is the
  // safe repair — rewiring could self-point or cycle. Without it the
  // output bundle fails the tool's own validation.
  const droppedSupersedesNotes: string[] = [];
  for (let i = 0; i < survivors.length; i++) {
    const item = survivors[i];
    const target = item.meta.supersedes;
    if (target !== undefined && target !== null && droppedInto.has(target)) {
      droppedSupersedesNotes.push(
        `dropped supersedes link from ${item.meta.id} to ${target} (deduped into ${droppedInto.get(target)})`,
      );
      survivors[i] = { meta: { ...item.meta, supersedes: null }, body: item.body };
    }
  }

  // Validate the output BEFORE any write (and before returning): a
  // merge must never produce a bundle that fails its own validation.
  const outputErrors = validateOutputItems(survivors);
  if (outputErrors.length > 0) {
    throw new MemportError(`merge output failed validation:\n${outputErrors.join("\n")}`);
  }

  // Phase 3: same normalized title, different body → possible duplicate.
  const byTitle = new Map<string, MemportItem[]>();
  for (const item of survivors) {
    const key = normalizeTitle(item.meta.title);
    if (key === "") continue;
    const list = byTitle.get(key) ?? [];
    list.push(item);
    byTitle.set(key, list);
  }
  const possibleDuplicates: PossibleDuplicate[] = [];
  for (const [title, list] of byTitle) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (normalizeBody(list[i].body) !== normalizeBody(list[j].body)) {
          possibleDuplicates.push({ idA: list[i].meta.id, idB: list[j].meta.id, title });
        }
      }
    }
  }

  const project = a.manifest.project === b.manifest.project ? a.manifest.project : null;

  // Secret flags (pattern names only): output items and conflict
  // losers. Loser text below is preserved verbatim for audit and is
  // NOT redacted — review these before sharing the output bundle.
  const secretFlags: MergeSecretFlag[] = [];
  for (const item of survivors) {
    const patterns = findSecrets(item.body).map((m) => m.pattern);
    if (patterns.length > 0) {
      secretFlags.push({ id: item.meta.id, title: item.meta.title, role: "item", patterns });
    }
  }
  for (const loser of supersededVersions) {
    const patterns = findSecrets(loser.item.body).map((m) => m.pattern);
    if (patterns.length > 0) {
      secretFlags.push({ id: loser.item.meta.id, title: loser.item.meta.title, role: "loser", patterns });
    }
  }

  const lines: string[] = [];
  lines.push("# Memport merge report");
  lines.push("");
  lines.push(`- First bundle: ${a.dir} (${a.items.length} items)`);
  lines.push(`- Second bundle: ${b.dir} (${b.items.length} items)`);
  lines.push(`- Output items: ${survivors.length}`);
  lines.push(`- Deduped: ${dedupedCount}`);
  lines.push(`- Conflicts: ${conflicts.length}`);
  lines.push(`- Possible duplicates: ${possibleDuplicates.length}`);
  if (a.manifest.project !== b.manifest.project) {
    lines.push(`- Project scope: mixed (${a.manifest.project ?? "user"} vs ${b.manifest.project ?? "user"}) → output project set to null`);
  }
  lines.push("");
  if (secretFlags.length > 0) {
    lines.push("## Secret flags (review before sharing)");
    lines.push("");
    lines.push(
      "These items/losers matched high-confidence secret patterns (pattern names only; excerpts are never printed). Loser text below is preserved verbatim for audit and is NOT redacted — do not share this bundle without reviewing these items.",
    );
    lines.push("");
    for (const f of secretFlags) {
      lines.push(`- ${f.role} ${f.id} "${f.title}": ${f.patterns.join(", ")}`);
    }
    lines.push("");
  }
  if (conflicts.length > 0) {
    lines.push("## Conflicts (winner kept; loser preserved below, nothing deleted)");
    lines.push("");
    const supWinnerIds = new Set(supersededWinners.map((w) => w.id));
    for (const c of conflicts) {
      const note = supWinnerIds.has(c.id) ? " — winner is superseded; apply will skip it" : "";
      lines.push(`- id ${c.id}: winner "${c.winnerTitle}" over "${c.loserTitle}" (${c.reason})${note}`);
    }
    lines.push("");
    lines.push("## Superseded versions (original file text, preserved for audit)");
    lines.push("");
    for (const loser of supersededVersions) {
      lines.push(loser.text.replace(/\n+$/, ""));
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }
  if (droppedSupersedesNotes.length > 0) {
    lines.push("## Supersedes links dropped (dedupe)");
    lines.push("");
    for (const note of droppedSupersedesNotes) lines.push(`- ${note}`);
    lines.push("");
  }
  if (dedupedNotes.length > 0) {
    lines.push("## Deduped sources");
    lines.push("");
    for (const note of dedupedNotes) lines.push(`- ${note}`);
    lines.push("");
  }
  if (possibleDuplicates.length > 0) {
    lines.push("## Possible duplicates (kept both; user adjudicates)");
    lines.push("");
    for (const p of possibleDuplicates) {
      lines.push(`- "${p.title}": ${p.idA} and ${p.idB}`);
    }
    lines.push("");
  }
  return {
    items: survivors,
    report: lines.join("\n"),
    conflicts,
    dedupedCount,
    possibleDuplicates,
    project,
    secretFlags,
    supersededWinners,
  };
}
