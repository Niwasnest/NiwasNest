// Server-rendered HTML. Every dynamic value goes through esc(). Mobile-first, NiwasNest brand.
import { STATUS_LABELS } from "../core/pipeline";
import type { LeadStatus } from "../core/types";

export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CSS = `
:root{--brand:#F67900;--brand-ink:#9a4a00;--bg:#faf8f5;--card:#fff;--ink:#1d1b18;--muted:#6b665f;--line:#e8e3dc;--ok:#1f7a4d;--bad:#b42318;--warn:#a15c00;--chip:#f3efe9}
@media (prefers-color-scheme:dark){:root{--bg:#141210;--card:#1e1b18;--ink:#f3efe9;--muted:#a59e95;--line:#33302b;--chip:#2a2622;--brand-ink:#ffb066;--ok:#4cc38a;--bad:#ff6b5e;--warn:#f0a94b}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--brand-ink)}
header{position:sticky;top:0;z-index:5;background:var(--card);border-bottom:1px solid var(--line)}
.bar{display:flex;align-items:center;gap:12px;max-width:960px;margin:0 auto;padding:10px 16px}
.logo{font-weight:800;letter-spacing:-.02em;color:var(--brand);text-decoration:none;font-size:18px}
.logo small{color:var(--muted);font-weight:600;font-size:12px;margin-left:4px}
nav{display:flex;gap:4px;overflow-x:auto;max-width:960px;margin:0 auto;padding:0 12px 8px;scrollbar-width:none}
nav a{white-space:nowrap;text-decoration:none;color:var(--muted);padding:6px 10px;border-radius:999px;font-weight:600;font-size:14px}
nav a.on{background:var(--chip);color:var(--ink)}
main{max-width:960px;margin:0 auto;padding:16px}
h1{font-size:22px;margin:4px 0 14px;letter-spacing:-.01em}h2{font-size:16px;margin:22px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px}
.stat b{display:block;font-size:24px;font-variant-numeric:tabular-nums}.stat span{color:var(--muted);font-size:13px}
.stat.hero{border-color:var(--brand)}.stat.hero b{color:var(--brand-ink)}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.grow{flex:1;min-width:0}
.muted{color:var(--muted)}.small{font-size:13px}
.chip{display:inline-block;background:var(--chip);border-radius:999px;padding:2px 9px;font-size:12px;font-weight:600}
.chip.live{background:#e3f4ea;color:#14532d}.chip.dnc{background:#fde8e6;color:#7a1a12}
@media (prefers-color-scheme:dark){.chip.live{background:#173a28;color:#9be3bd}.chip.dnc{background:#3d1a16;color:#ffb3aa}}
.btn{appearance:none;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:10px;padding:9px 14px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;display:inline-block;min-height:40px}
.btn.primary{background:var(--brand);border-color:var(--brand);color:#fff}.btn.danger{color:var(--bad)}.btn.ok{color:var(--ok)}
input,select,textarea{width:100%;font:inherit;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:10px;padding:9px 11px;min-height:40px}
label{display:block;font-weight:600;font-size:13px;margin:10px 0 4px}
.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0 12px}
.flash{border-radius:10px;padding:10px 12px;margin-bottom:12px;border:1px solid var(--line)}
.flash.ok{border-color:var(--ok);color:var(--ok)}.flash.bad{border-color:var(--bad);color:var(--bad)}
.banner{background:var(--bad);color:#fff;text-align:center;padding:6px;font-weight:700;font-size:13px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600}
.list>.card{display:block;text-decoration:none;color:inherit}
pre{white-space:pre-wrap;word-break:break-word;font-size:12px;background:var(--chip);padding:8px;border-radius:8px;max-height:200px;overflow:auto}
`;

const NAV: [string, string][] = [
  ["/", "Today"],
  ["/approvals", "Approvals"],
  ["/leads", "Leads"],
  ["/leads/new", "+ Lead"],
  ["/import", "Import"],
  ["/activity", "AI activity"],
  ["/settings", "Controls"],
];

export function page(opts: { title: string; path: string; body: string; flash?: { kind: "ok" | "bad"; text: string }; killed?: boolean; pending?: number; anon?: boolean }): string {
  const nav = opts.anon
    ? ""
    : `<nav>${NAV.map(([href, label]) => `<a href="${href}" class="${opts.path === href ? "on" : ""}">${esc(label)}${href === "/approvals" && opts.pending ? ` (${opts.pending})` : ""}</a>`).join("")}</nav>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><meta name="theme-color" content="#F67900"><title>${esc(opts.title)} · NiwasNest Growth</title><style>${CSS}</style></head>
<body>${opts.killed ? `<div class="banner">ALL AI AGENTS PAUSED (kill switch on)</div>` : ""}
<header><div class="bar"><a class="logo" href="/">NiwasNest<small>Growth OS</small></a><span class="grow"></span>${opts.anon ? "" : `<form method="post" action="/logout" style="margin:0"><button class="btn small" type="submit">Log out</button></form>`}</div>${nav}</header>
<main>${opts.flash ? `<div class="flash ${opts.flash.kind}" role="status">${esc(opts.flash.text)}</div>` : ""}${opts.body}</main></body></html>`;
}

export const csrfField = (token: string) => `<input type="hidden" name="_csrf" value="${esc(token)}">`;

export function statusChip(s: LeadStatus): string {
  const cls = s === "live" ? "live" : s === "do_not_contact" ? "dnc" : "";
  return `<span class="chip ${cls}">${esc(STATUS_LABELS[s])}</span>`;
}

export const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;
