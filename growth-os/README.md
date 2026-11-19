# NiwasNest Growth OS

The AI Sales & Growth department for NiwasNest, built as a **separate system**.
It does not change, deploy into or share a database with the live NiwasNest app.

```
 Live app (unchanged)                       Growth OS (this folder)
 niwasnest.com + api.niwasnest.com  ◄──────  read-only bridge (allowlisted paths)
   listings, approvals, bookings,            + 2 optional writes, OFF by default:
   payouts = source of truth                   create PG lead, get claim link
                                             own database: leads, consent, calls,
                                             chats, campaigns, QR codes, spend,
                                             approvals, audit log
```

## What it does today (v0.1)

| Part | File | Status |
|---|---|---|
| One sales pipeline (16 statuses); agents can't set Approved/Live | `src/core/pipeline.ts` | ✅ tested |
| Duplicate detection (phone, address + name, GPS + name) | `src/core/dedupe.ts` | ✅ tested |
| Consent gate: opt-in, DND, 9am–9pm IST, frequency caps, opt-out detection (EN/TE/KN/HI) | `src/core/consent.ts` | ✅ tested |
| Commission/offer engine: quotes only approved, current records | `src/core/policy.ts` | ✅ tested |
| Referral eligibility (₹300 booking, ₹500 × 10 / ₹5,000 owner) + fraud signals | `src/core/referrals.ts` | ✅ tested, **locked until founder confirms** |
| Permission matrix + kill switch (spec Part 15) | `src/core/permissions.ts` | ✅ tested |
| Follow-up cadences (D0/1/3/7, onboarding nudges) | `src/core/followups.ts` | ✅ tested |
| Knowledge base with authority levels | `knowledge/*.md`, `src/core/knowledge.ts` | ✅ |
| Agent runtime: tools, approvals, audit log, **number guard** | `src/agents/*` | ✅ tested with scripted model |
| Gemini adapter (model is swappable) | `src/agents/llm.ts` | written, needs API key |
| Main-app bridge (read allowlist, writes off) | `src/integrations/niwasnest-api.ts` | ✅ tested |
| Morning brief, funnel, campaign ROI, locality gaps | `src/planning/daily-plan.ts` | ✅ demo |
| Postgres schema (own DB, RLS, append-only audit) | `db/migrations/*.sql` | ✅ applied to Supabase |
| Database persistence (every change written through; `flush()` fails loudly) | `src/store/postgres.ts`, `src/store/sql.ts` | ✅ tested + live round-trip |
| Lead import from spreadsheet (CSV) with dedupe + evidenced consent | `src/planning/import-leads.ts`, `templates/leads-template.csv` | ✅ tested |

### Safety built into the code, not the prompt
- **Number guard:** a reply containing a ₹ amount or % that did not come from an approved source in that turn is replaced with "let me confirm".
- **Opt-out handling doesn't depend on the AI:** "STOP", "call vaddu", "phone beda" or "call mat karo" stop all channels immediately, even when the kill switch is on.
- **Nothing is reported as sent** without a provider confirmation ID. With no provider configured, every send is a logged dry run.
- **Human-only actions:** listing approval, agreements, identity documents and record deletion. Money and offers go to the founder's approval queue.

## Founder console (web, phone-friendly)
Pages: **Today** (funnel, today's call list with Call/WhatsApp buttons, onboarding to chase, campaign ROI, area gaps) ·
**Approvals** (approve/reject) · **Leads** (search, status, follow-ups, consent, opt-out) · **+ Lead** · **Import** (CSV preview → import) ·
**AI activity** (audit log) · **Controls** (global kill switch + per-agent pause).

Security: single founder login (scrypt hash), signed HttpOnly SameSite=Strict cookie, CSRF token on every form,
login throttling, strict CSP, `noindex`, all output HTML-escaped. Nobody can set Approved/Live by hand here.

```bash
npm run demo           # sample data in memory, password "demo-password" → http://localhost:8788
npm run hash-password  # creates ADMIN_PASSWORD_HASH for your real password
npm start              # real console on the Growth OS database (needs .env)
```

### Deploy (e.g. Render or Railway, ~10 min)
1. New Web Service from this GitHub repo, root directory `growth-os`, build `npm ci`, start `npm start`.
2. Environment: `DATABASE_URL` (Supabase → Connect → Transaction pooler, Mumbai), `ADMIN_PASSWORD_HASH`, `SESSION_SECRET` (48+ random chars), `ADMIN_NAME`.
3. Point a subdomain such as `grow.niwasnest.com` at it (a DNS CNAME; no change to the main app).

## Commands
```bash
npm install
npm test           # 48 tests
npm run typecheck
npm run migrate                                  # apply new db/migrations
npm run brief                                    # morning brief from the database (--demo for sample data)
npm run import:leads -- leads.csv [--dry-run]    # add PG owners from a spreadsheet
npm run approvals                                # list what is waiting for you
npm run approvals -- approve <id> "Your Name"    # or: reject <id> "Your Name"
npm run kb:check   # validate knowledge base; scripts may not contain ₹/% figures
```

## To go live (founder checklist)
1. ✅ Separate Supabase project `niwasnest-growth-os` (ref `rznsuobewwmmvbvfatuc`, Mumbai) created; `0001_growth_os.sql` applied on 2026-11-19 — 24 tables, RLS on all, audit log append-only.
2. Create a **staff account** (marketing role) in the main app for Growth OS and put its token in `.env` (see `.env.example`). Keep `NIWASNEST_API_WRITES_ENABLED=false` at first.
3. Add a Gemini API key and set `LLM_PROVIDER=gemini`.
4. Approve `knowledge/80-referrals.md` (set `approved: true`) once the amounts match what the app pays.
5. Enter the one active commission policy in `commercial_policies` with its approved wording.
6. Channels, in this order: WhatsApp Business (Meta verification + templates) → inbound / missed-call number → outbound AI voice (Exotel/MyOperator + TRAI/DLT registration, confirmed by counsel).

## Running in the Claude cloud sandbox
Node's `fetch` needs `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt` here; credentials are injected by the sandbox proxy (use `SUPABASE_ACCESS_TOKEN=proxy-injected`). Not needed on a normal server.

## Next build steps
- WhatsApp Cloud API webhook + sender (implements `ChannelSender`).
- Small admin web UI on its own subdomain: approvals inbox, kill switch, brief, leads.
- QR redirect service (`/q/:code` → niwasnest.com with UTM) feeding `qr_scans`.
- Nightly sync from the main app: lead/listing status → `live` via `main_app_sync`.
