// Validates the knowledge base: front-matter, and no money figures in scripts (they must come from tools).
import { join } from "node:path";
import { loadKnowledgeDir } from "../core/knowledge";
import { extractFigures } from "../agents/orchestrator";

const entries = loadKnowledgeDir(join(import.meta.dirname, "..", "..", "knowledge"));
let problems = 0;
for (const e of entries) {
  const figs = extractFigures(e.body);
  if (e.authority === 4 && figs.length) {
    console.error(`✗ ${e.id}: scripts must not contain money figures (${figs.join(", ")}) — use the policy engine`);
    problems++;
  }
}
console.log(`${entries.length} entries · ${entries.filter((e) => e.approved).length} approved · ${entries.filter((e) => !e.approved).length} awaiting approval`);
for (const e of entries.filter((x) => !x.approved)) console.log(`  awaiting approval: ${e.id} (${e.title})`);
process.exit(problems ? 1 : 0);
