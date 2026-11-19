// Central knowledge base with the authority hierarchy from the master spec:
//   1 founder-approved policy > 2 admin commercial settings > 3 verified product docs
//   > 4 approved sales scripts > 5 historical discussions (never quoted as fact).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface KbEntry {
  id: string;
  title: string;
  category: string;
  authority: 1 | 2 | 3 | 4 | 5;
  languages: string[];
  approved: boolean;
  body: string;
}

/** Parses a markdown file with a minimal `key: value` front-matter block. */
export function parseKbFile(id: string, raw: string): KbEntry {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error(`${id}: missing front-matter`);
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const authority = Number(meta.authority);
  if (![1, 2, 3, 4, 5].includes(authority)) throw new Error(`${id}: authority must be 1–5`);
  if (!meta.title || !meta.category) throw new Error(`${id}: title and category are required`);
  return {
    id,
    title: meta.title,
    category: meta.category,
    authority: authority as KbEntry["authority"],
    languages: (meta.languages ?? "en").split(",").map((s) => s.trim()),
    approved: meta.approved === "true",
    body: m[2]!.trim(),
  };
}

export function loadKnowledgeDir(dir: string): KbEntry[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && !f.startsWith("README"))
    .sort()
    .map((f) => parseKbFile(f.replace(/\.md$/, ""), readFileSync(join(dir, f), "utf8")));
}

const tokenize = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}₹%]+/gu) ?? [];

/**
 * Keyword retrieval ranked by relevance, then authority. Historical (level 5) and unapproved
 * entries are excluded unless explicitly requested for internal analysis.
 * (Swap for pgvector embeddings later; the authority filter stays the same.)
 */
export function retrieve(entries: KbEntry[], query: string, opts: { limit?: number; includeHistorical?: boolean } = {}): KbEntry[] {
  const q = new Set(tokenize(query));
  return entries
    .filter((e) => e.approved && (opts.includeHistorical || e.authority < 5))
    .map((e) => {
      const words = tokenize(`${e.title} ${e.category} ${e.body}`);
      let hits = 0;
      for (const w of words) if (q.has(w)) hits++;
      return { e, score: hits / Math.sqrt(words.length + 1) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.e.authority - b.e.authority)
    .slice(0, opts.limit ?? 4)
    .map((x) => x.e);
}

export function renderContext(entries: KbEntry[]): string {
  return entries.map((e) => `### ${e.title} [authority ${e.authority}]\n${e.body}`).join("\n\n");
}
