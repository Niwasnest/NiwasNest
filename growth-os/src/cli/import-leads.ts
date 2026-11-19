// npm run import:leads -- leads.csv [--dry-run]
import { readFileSync } from "node:fs";
import { parseCsv } from "../core/csv";
import { importLeads } from "../planning/import-leads";
import { GrowthStore } from "../store/memory";
import { loadStore } from "../store/postgres";
import { requireDb } from "./_db";

const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
const dry = process.argv.includes("--dry-run");
if (!file) { console.error("usage: npm run import:leads -- leads.csv [--dry-run]"); process.exit(1); }
const rows = parseCsv(readFileSync(file, "utf8"));
const db = requireDb();
const live = await loadStore(db);
// Dry run: copy existing leads into an unsaved store so duplicates are still detected.
const store = dry ? Object.assign(new GrowthStore(), { leads: new Map(live.leads) }) : live;
const rep = importLeads(store, rows, "csv_import");
if (!dry) await store.flush();
console.log(`${dry ? "[DRY RUN] would create" : "Created"} ${rep.created.length} leads from ${rows.length} rows; consents recorded: ${rep.consentsRecorded}`);
for (const x of rep.skippedDuplicates) console.log(`  skipped row ${x.row} "${x.name}": already in CRM (${x.reason})`);
for (const x of rep.possibleDuplicates) console.log(`  check row ${x.row} "${x.name}": possible duplicate of ${x.matches.join(", ")}`);
for (const x of rep.invalid) console.log(`  invalid row ${x.row}: ${x.reason}`);
await db.close?.();
