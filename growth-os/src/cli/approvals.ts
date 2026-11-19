// npm run approvals                      → list pending approvals
// npm run approvals -- approve <id> "Name"   /   reject <id> "Name"
import { openStore } from "./_db";

const [cmd, id, by] = process.argv.slice(2);
const { db, store } = await openStore();
if (cmd === "approve" || cmd === "reject") {
  if (!id || !by) { console.error('usage: approvals approve|reject <id> "Your Name"'); process.exit(1); }
  const ap = store.decideApproval(id, cmd === "approve" ? "approved" : "rejected", by);
  if (!ap) { console.error("approval not found"); process.exit(1); }
  store.log({ agentKey: "founder_cli", action: `approval_${cmd}`, input: { id }, result: "done", providerRef: "crm", detail: by });
  await store.flush();
  console.log(`${ap.status.toUpperCase()}: ${ap.summary}`);
} else {
  const pending = store.approvals.filter((a) => a.status === "pending");
  if (!pending.length) console.log("No pending approvals.");
  for (const a of pending) console.log(`${a.id}  [${a.approverRole}]  ${a.action}  —  ${a.summary}  (by ${a.agentKey}, ${a.createdAt.toISOString().slice(0, 16)})`);
}
await db.close?.();
