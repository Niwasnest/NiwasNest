// npm run demo → console on sample data in memory (password: "demo-password"). Nothing is saved.
import { serve } from "@hono/node-server";
import { randomBytes } from "node:crypto";
import { createApp } from "./app";
import { hashPassword } from "./auth";
import { demoStore } from "../planning/demo";

const store = demoStore();
const app = createApp({
  openStore: async () => store,
  setAgentFlag: async (k, p) => { if (k === "*") store.killSwitch.global = p; else if (p) store.killSwitch.agents.add(k); else store.killSwitch.agents.delete(k); },
  recentActions: async (n) => store.actions.slice(-n).reverse(),
  auth: { user: "Founder (demo)", passwordHash: hashPassword("demo-password"), sessionSecret: randomBytes(32).toString("hex"), secureCookies: false },
});
const port = Number(process.env.PORT || 8788);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (i) => console.log(`DEMO console on http://localhost:${i.port}  (password: demo-password; sample data, nothing saved)`));
