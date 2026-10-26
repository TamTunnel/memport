// memport/1 bundle format: manifest + one markdown file per item.
// See FORMAT.md for the full schema. This module is the single place
// that knows how bundles are read, written, hashed, and validated.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter, serializeFrontmatter } from "./frontmatter.ts";
import { generateUlid, isUlid } from "./ulid.ts";

export const FORMAT_VERSION = "memport/1";
export const ITEM_KINDS = ["fact", "preference", "decision", "rule", "reference", "note"] as const;
export const ITEM_SCOPES = ["user", "project"] as const;
export const ITEM_ORIGINS = ["human", "agent-learned", "imported"] as const;
export const ITEM_STATUSES = ["active", "superseded", "disputed"] as const;
export const SOURCE_TOOLS = ["claude", "codex", "cursor", "hand", "memport"] as const;

export type ItemKind = (typeof ITEM_KINDS)[number];
export type ItemScope = (typeof ITEM_SCOPES)[number];
export type ItemOrigin = (typeof ITEM_ORIGINS)[number];
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export type SourceTool = (typeof SOURCE_TOOLS)[number];

/** Frontmatter of one item file (body held separately). */
export interface ItemMeta {
  id: string;
  kind: ItemKind;
  title: string;
  scope: ItemScope;
  origin: ItemOrigin;
  source_tool: SourceTool | string;
  source_path?: string | null;
  source_kind?: string | null;
  created: string;
  updated: string;
  supersedes?: string | null;
  status: ItemStatus;
  tags?: string[];
  [extra: string]: unknown;
}

export interface MemportItem {
  meta: ItemMeta;
  body: string;
}

export interface ManifestEntry {
  id: string;
  file: string;
  sha256: string;
}

export interface Manifest {
  format: string;
  created: string;
  source_tool: SourceTool | string | null;
  source_path: string | null;
  project: string | null;
  items: ManifestEntry[];
  notes?: string[];
  [extra: string]: unknown;
}

export class MemportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemportError";
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256Hex(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/** Merge-dedupe normalization: line endings, per-line trailing space,
 *  blank-run collapsing, outer trim. Deliberately NOT semantic: two
 *  bodies that differ in wording are different bodies. */
export function normalizeBody(body: string): string {
  return body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Title normalization for idempotence matching and duplicate hints:
 *  lowercase, collapsed whitespace, punctuation stripped. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Derive a one-line title from markdown body: first `#` heading, else
 *  first non-empty line, markdown markers stripped, capped at 100 chars. */
export function titleFromBody(body: string): string {
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const text = (heading ? heading[1] : line)
      .replace(/[*_`~]+/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .trim();
    if (text !== "") return text.slice(0, 100);
  }
  return "Untitled";
}

/** Strip a leading `#` heading line from a body (used when the whole
 *  source file becomes one item whose title came from its heading). */
export function stripFirstHeading(body: string): string {
  const lines = body.split("\n");
  if (lines.length > 0 && /^#{1,6}\s+/.test(lines[0].trim())) {
    return lines.slice(1).join("\n").replace(/^\n+/, "");
  }
  return body;
}

export function itemFileName(id: string): string {
  return `${id}.md`;
}

/** Build a new item with a fresh ULID (import path). */
export function mintItem(fields: {
  kind: ItemKind;
  title: string;
  scope: ItemScope;
  origin: ItemOrigin;
  source_tool: SourceTool | string;
  source_path?: string | null;
  source_kind?: string | null;
  body: string;
  tags?: string[];
}): MemportItem {
  const now = nowIso();
  return {
    meta: {
      id: generateUlid(),
      kind: fields.kind,
      title: fields.title,
      scope: fields.scope,
      origin: fields.origin,
      source_tool: fields.source_tool,
      source_path: fields.source_path ?? null,
      source_kind: fields.source_kind ?? null,
      created: now,
      updated: now,
      supersedes: null,
      status: "active",
      tags: fields.tags ?? [],
    },
    body: fields.body,
  };
}

/** Serialize one item to its file text. */
export function serializeItem(item: MemportItem): string {
  const data: Record<string, unknown> = { ...item.meta };
  // Omit empty optionals for clean files (readers treat missing as null).
  if (!data.source_path) delete data.source_path;
  if (!data.source_kind) delete data.source_kind;
  if (!data.supersedes) delete data.supersedes;
  if (Array.isArray(data.tags) && data.tags.length === 0) delete data.tags;
  return serializeFrontmatter(data, item.body);
}

/** Parse one item file's text. Throws MemportError when frontmatter is
 *  absent (bundle items must carry it). */
export function parseItem(text: string, fileLabel: string): MemportItem {
  const parsed = parseFrontmatter(text);
  if (!parsed.hadFrontmatter) {
    throw new MemportError(`${fileLabel}: missing frontmatter (expected memport/1 item)`);
  }
  return { meta: parsed.data as unknown as ItemMeta, body: parsed.body };
}

/** Check an item's required fields and vocabularies. Returns error strings. */
export function validateItemFields(meta: ItemMeta, fileLabel: string): string[] {
  const errors: string[] = [];
  const req = (field: string, value: unknown) => {
    if (value === undefined || value === null || value === "") {
      errors.push(`${fileLabel}: missing required field '${field}'`);
    }
  };
  req("id", meta.id);
  req("kind", meta.kind);
  req("title", meta.title);
  req("scope", meta.scope);
  req("origin", meta.origin);
  req("source_tool", meta.source_tool);
  req("created", meta.created);
  req("updated", meta.updated);
  req("status", meta.status);
  if (meta.id !== undefined && meta.id !== "" && !isUlid(meta.id)) {
    errors.push(`${fileLabel}: id '${meta.id}' is not a ULID`);
  }
  if (meta.kind !== undefined && !(ITEM_KINDS as readonly string[]).includes(meta.kind)) {
    errors.push(`${fileLabel}: unknown kind '${meta.kind}'`);
  }
  if (meta.scope !== undefined && !(ITEM_SCOPES as readonly string[]).includes(meta.scope)) {
    errors.push(`${fileLabel}: unknown scope '${meta.scope}'`);
  }
  if (meta.origin !== undefined && !(ITEM_ORIGINS as readonly string[]).includes(meta.origin)) {
    errors.push(`${fileLabel}: unknown origin '${meta.origin}'`);
  }
  if (meta.status !== undefined && !(ITEM_STATUSES as readonly string[]).includes(meta.status)) {
    errors.push(`${fileLabel}: unknown status '${meta.status}'`);
  }
  for (const f of ["created", "updated"] as const) {
    const v = meta[f];
    if (v !== undefined && v !== "" && Number.isNaN(Date.parse(v))) {
      errors.push(`${fileLabel}: field '${f}' is not ISO 8601 ('${v}')`);
    }
  }
  if (meta.supersedes !== undefined && meta.supersedes !== null && !isUlid(meta.supersedes)) {
    errors.push(`${fileLabel}: supersedes '${meta.supersedes}' is not a ULID`);
  }
  if (meta.tags !== undefined && (!Array.isArray(meta.tags) || meta.tags.some((t) => typeof t !== "string"))) {
    errors.push(`${fileLabel}: tags must be a list of strings`);
  }
  return errors;
}

function manifestItemPath(bundleDir: string, entryFile: string): string {
  // Path traversal guard: manifest entries must stay inside items/.
  if (path.isAbsolute(entryFile)) {
    throw new MemportError(`manifest entry '${entryFile}' is an absolute path (refused)`);
  }
  const normalized = path.normalize(entryFile);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new MemportError(`manifest entry '${entryFile}' escapes the bundle (refused)`);
  }
  return path.join(bundleDir, normalized);
}

/** Refuse symlinked paths: bundle contents must be regular files inside
 *  the bundle directory, never links (in or out). Missing paths are the
 *  caller's problem (reported as missing, not as a symlink). */
export function refuseSymlink(filePath: string, label: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(filePath);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    throw new MemportError(`${label}: symlinked file refused (${filePath})`);
  }
}

/** Refuse any item path whose real location escapes the bundle dir
 *  (covers symlinked parent directories, not just symlinked files). */
function refuseEscape(bundleDir: string, filePath: string, label: string): void {
  let realFile: string;
  try {
    realFile = fs.realpathSync(filePath);
  } catch {
    return; // Missing: the caller's read reports it.
  }
  const realBase = fs.realpathSync(bundleDir);
  if (realFile !== realBase && !realFile.startsWith(realBase + path.sep)) {
    throw new MemportError(`${label}: item file resolves outside the bundle (refused): ${filePath}`);
  }
}

export interface LoadedBundle {
  dir: string;
  manifest: Manifest;
  items: MemportItem[];
  /** Raw manifest entries, aligned with items by index. */
  entries: ManifestEntry[];
}

/** Read a bundle directory. Throws MemportError on structural problems
 *  (missing manifest, bad JSON, unknown major version, unreadable or
 *  traversal-escaping item entries). Hash and semantic checks live in
 *  validateBundle(), not here. */
export function readBundle(bundleDir: string): LoadedBundle {
  const manifestPath = path.join(bundleDir, "memport.json");
  // The manifest is the bundle's trust root: a symlinked manifest would
  // let a "bundle" front for content living anywhere on disk.
  refuseSymlink(manifestPath, "memport.json");
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    throw new MemportError(`no memport.json found in ${bundleDir}`);
  }
  let manifest: Manifest;
  try {
    manifest = JSON.parse(raw) as Manifest;
  } catch {
    throw new MemportError(`memport.json in ${bundleDir} is not valid JSON`);
  }
  if (typeof manifest.format !== "string") {
    throw new MemportError(`memport.json in ${bundleDir} has no 'format' key`);
  }
  const major = manifest.format.split("/")[0];
  if (manifest.format !== FORMAT_VERSION) {
    if (major === "memport") {
      throw new MemportError(
        `unsupported bundle format '${manifest.format}' (this tool reads ${FORMAT_VERSION} only)`,
      );
    }
    throw new MemportError(`unknown bundle format '${manifest.format}'`);
  }
  if (!Array.isArray(manifest.items)) {
    throw new MemportError(`memport.json in ${bundleDir} has no 'items' array`);
  }
  // A symlinked items/ directory would route every item read outside
  // the bundle even though each file itself is regular.
  refuseSymlink(path.join(bundleDir, "items"), "items/");
  const items: MemportItem[] = [];
  const entries: ManifestEntry[] = [];
  for (const entry of manifest.items as ManifestEntry[]) {
    if (typeof entry.id !== "string" || typeof entry.file !== "string" || typeof entry.sha256 !== "string") {
      throw new MemportError(`memport.json in ${bundleDir} has a malformed items entry`);
    }
    const filePath = manifestItemPath(bundleDir, entry.file);
    refuseSymlink(filePath, entry.file);
    refuseEscape(bundleDir, filePath, entry.file);
    let text: string;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      throw new MemportError(`bundle item file missing: ${entry.file} (id ${entry.id})`);
    }
    items.push(parseItem(text, entry.file));
    entries.push(entry);
  }
  return { dir: bundleDir, manifest, items, entries };
}

/**
 * Write a bundle directory (manifest + item files). Items are sorted by
 * id for deterministic output. Overwrites item files and the manifest;
 * never touches other files in the directory (merge-report.md included).
 */
export function writeBundle(
  bundleDir: string,
  items: MemportItem[],
  meta: {
    source_tool: SourceTool | string | null;
    source_path: string | null;
    project: string | null;
    notes?: string[];
    created?: string;
  },
): Manifest {
  const sorted = [...items].sort((a, b) => (a.meta.id < b.meta.id ? -1 : a.meta.id > b.meta.id ? 1 : 0));
  const itemsDir = path.join(bundleDir, "items");
  // Refuse before mkdir: mkdirSync(recursive) silently succeeds on an
  // existing symlinked directory, and every write after it would land
  // in the link target. Same for pre-existing item/manifest links.
  refuseSymlink(itemsDir, "items/");
  fs.mkdirSync(itemsDir, { recursive: true });
  const entries: ManifestEntry[] = [];
  for (const item of sorted) {
    const file = `items/${itemFileName(item.meta.id)}`;
    const text = serializeItem(item);
    const dest = path.join(bundleDir, file);
    refuseSymlink(dest, file);
    fs.writeFileSync(dest, text, "utf8");
    entries.push({ id: item.meta.id, file, sha256: sha256Hex(text) });
  }
  const manifest: Manifest = {
    format: FORMAT_VERSION,
    created: meta.created ?? nowIso(),
    source_tool: meta.source_tool,
    source_path: meta.source_path,
    project: meta.project,
    items: entries,
    notes: meta.notes ?? [],
  };
  const manifestPath = path.join(bundleDir, "memport.json");
  refuseSymlink(manifestPath, "memport.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return manifest;
}

/** Full bundle validation: structural read + hashes + duplicate ids +
 *  supersedes targets + filename==id + required fields. Returns all
 *  errors found (empty means valid). */
export function validateBundle(bundleDir: string): string[] {
  let loaded: LoadedBundle;
  try {
    loaded = readBundle(bundleDir);
  } catch (e) {
    return [(e as Error).message];
  }
  const errors: string[] = [];
  const seen = new Map<string, string>();
  const ids = new Set<string>();
  for (let i = 0; i < loaded.items.length; i++) {
    const item = loaded.items[i];
    const entry = loaded.entries[i];
    const label = entry.file;
    ids.add(item.meta.id);
    if (seen.has(item.meta.id)) {
      errors.push(`${label}: duplicate id '${item.meta.id}' (also in ${seen.get(item.meta.id)})`);
    } else {
      seen.set(item.meta.id, label);
    }
    if (entry.id !== item.meta.id) {
      errors.push(`${label}: manifest id '${entry.id}' does not match item id '${item.meta.id}'`);
    }
    const expectedFile = `items/${itemFileName(item.meta.id)}`;
    if (entry.file !== expectedFile) {
      errors.push(`${label}: file name does not match item id (expected ${expectedFile})`);
    }
    const actual = fs.readFileSync(path.join(bundleDir, entry.file));
    if (sha256Hex(actual) !== entry.sha256) {
      errors.push(`${label}: manifest sha256 does not match file bytes (forged or corrupted)`);
    }
    errors.push(...validateItemFields(item.meta, label));
  }
  // Extra unlisted files in items/ (stale, planted, or forgotten): the
  // manifest is the bundle's inventory, and anything outside it is
  // untrusted content riding along with a valid-looking bundle.
  try {
    const listed = new Set(loaded.entries.map((e) => e.file));
    for (const name of fs.readdirSync(path.join(bundleDir, "items"))) {
      const rel = `items/${name}`;
      if (!listed.has(rel)) {
        errors.push(`${rel}: file in items/ is not listed in the manifest`);
      }
    }
  } catch {
    // No items/ dir: the item reads above already reported missing files.
  }
  for (const item of loaded.items) {
    const target = item.meta.supersedes;
    if (target !== undefined && target !== null && !ids.has(target)) {
      errors.push(`item ${item.meta.id}: supersedes target '${target}' does not exist in this bundle`);
    }
  }
  return errors;
}

/** Validate an in-memory item list (merge output, before any write):
 *  duplicate ids, supersedes targets, field vocabularies. No manifest
 *  or hash checks here — those belong to directory validation. */
export function validateOutputItems(items: MemportItem[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const seen = new Set<string>();
  for (const item of items) {
    const label = `items/${itemFileName(item.meta.id)}`;
    if (seen.has(item.meta.id)) {
      errors.push(`${label}: duplicate id '${item.meta.id}'`);
    }
    seen.add(item.meta.id);
    ids.add(item.meta.id);
    errors.push(...validateItemFields(item.meta, label));
  }
  for (const item of items) {
    const target = item.meta.supersedes;
    if (target !== undefined && target !== null && !ids.has(target)) {
      errors.push(`item ${item.meta.id}: supersedes target '${target}' does not exist in this bundle`);
    }
  }
  return errors;
}

/** Idempotence lookup for re-imports: same (source_tool, source_path,
 *  normalized title) reuses the existing id instead of minting a new one. */
export function findExistingId(
  items: MemportItem[],
  sourceTool: string,
  sourcePath: string,
  title: string,
): MemportItem | undefined {
  const norm = normalizeTitle(title);
  return items.find(
    (it) =>
      it.meta.source_tool === sourceTool &&
      (it.meta.source_path ?? "") === sourcePath &&
      normalizeTitle(it.meta.title) === norm,
  );
}
