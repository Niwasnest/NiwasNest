# NiwasNest AI Sales & Growth Command Center
## Step 1: Repository audit and implementation plan

Status: **Plan only. No production code was changed.**
Date: 19 Nov 2026

---

## 1. What the audit found

### 1.1 The source code is not in the repository I can access

| Check | Result |
|---|---|
| `github.com/Niwasnest/NiwasNest` | **Empty.** It has no commits on any branch. |
| Other repos visible to this session | None. |
| Frontend source | Not available. |
| Backend source | Not available. |
| Database schema / migrations | Not available. |

Without the source I cannot complete steps 1–9 of the brief's development method: the database tables, auth internals and integrations. The brief itself says not to build before that. So the audit below is limited to what the **public production site** reveals: page HTML, the JS bundle and the API paths it calls. It is reliable for *what exists*. It is not reliable for *how it is built*.

### 1.2 The live stack differs from the brief

| The brief assumes | What production actually shows |
|---|---|
| Next.js on Vercel | **React + Vite single-page PWA**, served from **AWS S3 + CloudFront** |
| Supabase / Supabase Auth | **Custom REST backend at `api.niwasnest.com`**. There are no Supabase calls in the frontend. It has its own `/auth/login`, `/auth/otp/*`, `/auth/google` and `/auth/refresh` endpoints. |
| Backend unknown | `skip`/`limit` pagination and JSON 404s point to **FastAPI (Python)**. API docs are correctly disabled in production. Needs confirmation. |
| Bengaluru first, other cities in Phase 2 | The site already markets **Bangalore, Hyderabad, Pune, Mumbai, Delhi, Chennai**, plus **hotels**. |

**Consequence:** the brief's technology table (Next.js, Supabase, Vercel) should not be followed literally. The Command Center must be built **inside the existing backend and admin app**, on the same database, auth and role system. Otherwise it becomes the "separate system with a separate CRM" the brief warns against.

### 1.3 A lot of the brief already exists

The production frontend calls these backend modules. Each one maps to a part of the brief.

| Brief requirement | Already exists in production (API paths) | Verdict |
|---|---|---|
| Roles / RBAC | Roles `super_admin`, `admin`, `owner`, `tenant`, `marketing`, `telecaller`, `counter`, `partner`; `/admin/admins`, `/admin/users/{id}/listing-staff` | **Reuse.** Add agent and finance roles. |
| OTP owner registration | `/auth/otp/request`, `/verify`, `/resend` | **Reuse.** |
| PG owner leads (CRM core) | `/marketing/leads`, `/marketing/leads/new-pg`, `…/claim-link`, `…/mark-coming-soon`, `…/publish-live`, `…/deactivate`, `/marketing/hotel-leads` | **Extend.** This is the existing lead table. |
| Telecaller workflow | `/telecaller/leads`, `…/{id}/claim`, `/telecaller/partner-leads`, `/telecaller/properties/{id}/room-matrix`, `/telecaller/requests`, `/admin/telecaller-team`, `/admin/telecaller-activity`, `/properties/{id}/telecaller` | **Extend.** The AI telecaller becomes another "telecaller" on the same queue. |
| Owner onboarding | `/pg/onboard`, `/owner/add-pg`, `/properties/claim/{token}`, `/properties/{id}/images`, `…/photo-coverage`, `…/videos`, `…/agreement` | **Reuse.** The AI sends the existing claim link. |
| AI listing descriptions | `/properties/generate-description` | **Reuse.** An LLM integration already exists. Find out which provider. |
| Admin verification | `/properties/admin/queue`, `…/approve`, `…/reject`, `…/review`, `…/bulk-approve`, `/admin/photos/{id}/verify`, `…/verification-status`, `…/assign-captain` | **Reuse.** The AI never approves. |
| Field sales | "captains" (`/admin/properties/captains`, `assign-captain`), `/marketing-team`, `/admin/marketing-onboarding` | **Extend** with visit routes and visit logs. |
| Referral program (₹300/booking) | `/referrals/generate`, `/referrals/leaderboard`. The UI says "earn ₹300 per booking". | **Reuse.** Check the rules match §4.2. |
| Partner / creator / PG-referral program | `/partner-program/apply`, `/me/dashboard`, `/me/commissions`, `/pg-submissions`, `/public/click/{code}`; admin approve, reject, suspend, risk, health, payouts, CSV | **Reuse.** This already covers most of the influencer and PG-owner referral spec, including fraud/risk and payout approval. |
| Commission | `/admin/hotels/{id}/commission`, `/admin/partner-program/commissions/*`, `/properties/{id}/agreement` | **Partial.** A per-PG commercial policy engine needs confirming or building. |
| Offers / coupons | `/admin/coupons` (with toggle); a `WELCOME500` coupon is in the UI | **Extend** with approval workflow and budget/redemption caps. |
| Campaigns | `/admin/campaigns`, `/admin/notifications/send` | **Extend** with QR/tracking codes, spend and attribution. |
| Analytics | `/admin/analytics`, `/admin/funnel`, `/marketing/performance`, `/marketing/analytics`, `/admin/reports` | **Extend** with channel/campaign/agent cuts. |
| Risk / fraud | `/admin/risk`, partner-program risk analytics | **Reuse.** |
| Bookings, payments, wallet, payouts | `/bookings`, `/admin/payments`, `/admin/payouts`, `/wallet/*`, Razorpay checkout | **Reuse** as the source of truth for "completed booking". |
| WhatsApp | Only `wa.me` click-to-chat links | **New.** WhatsApp Business Cloud API. |
| Voice AI calling | None | **New.** |
| Website AI chat | None (a "concierge" request form exists) | **New.** |
| Email outreach (Gmail) | None | **New.** |
| Institutions / partnerships pipeline | `/admin/partner-inquiries`, `/group-enquiries` (inbound only) | **New** outbound pipeline, reusing those inbound tables. |
| Knowledge base, agent orchestration, approvals, audit log, kill switch | None visible | **New.** This is the core of Phase 1. |
| Consent / DND registry | None visible | **New.** This blocks any calling. |

**Main conclusion:** about 60% of the "CRM" in the brief already exists as marketing, telecaller, partner-program, coupon and campaign modules. The real gap is the **intelligence and execution layer**: a shared knowledge base, policy engine, agent runtime, approval queue, audit log, consent, and the voice, WhatsApp, chat and email channels. Building a parallel CRM would duplicate the lead tables your marketing and telecaller teams use today, and split the data.

### 1.4 Business-rule conflicts found on the live site

The founder has to resolve these before any AI is allowed to quote terms:

1. **"Zero brokerage" vs. owner commission.** The site promises *"Free listing, zero brokerage"* to owners and *"zero brokerage"* to tenants. The brief describes a 10–30% first-month commission or service charge. AI scripts must not contradict the public site. One approved wording is needed for owners, e.g. "free to list; a one-time first-month platform fee per [agreement]".
2. **Which commission is active?** The brief lists 30%, 20%, 10–15% and a "20% service charge" as historical. The live product has `/properties/{id}/agreement` and a hotel commission endpoint. Is there already a per-PG agreement record? If yes, it becomes the only source the AI may quote.
3. **Referral terms on the site vs. the brief.** The ₹300 booking referral matches. I could not see the ₹500 × first 10 bookings / ₹5,000 cap for PG-owner referral in the UI. Whatever the partner-program backend computes today is the truth. The brief should be updated to match it, not the other way round.
4. **Customer refund text** shows "₹500 processing fee" for cancellations within 7 days. The AI must quote this only from the stored terms.

---

## 2. Target architecture (adapted to the real stack)

```
                  Admin app (existing React/Vite)  +  new "Command Center" section
                                   |
                        api.niwasnest.com  (existing backend)
     ┌──────────────────────────────┼─────────────────────────────────────┐
     │  EXISTING modules             │  NEW: growth module                  │
     │  auth/RBAC, properties,       │  ├─ knowledge   (KB + policy engine)│
     │  marketing leads, telecaller, │  ├─ agents      (orchestrator, tools,│
     │  partner-program, referrals,  │  │               permissions)        │
     │  coupons, campaigns, bookings,│  ├─ approvals   (queue + audit log)  │
     │  payouts, analytics, risk     │  ├─ consent     (DND/opt-out/quiet h)│
     │                               │  ├─ channels    (voice, WhatsApp,    │
     │                               │  │               web chat, email,SMS)│
     │                               │  ├─ outreach    (institutions,       │
     │                               │  │               creators, field)    │
     │                               │  └─ attribution (QR codes, spend,ROI)│
     └──────────────────────────────┴─────────────────────────────────────┘
                                   |
                     Same PostgreSQL database (one CRM)
                                   |
             Background worker (queues: calls, follow-ups, daily plan)
                                   |
   Provider adapters: LLM (Gemini default, swappable) · Exotel/MyOperator ·
   WhatsApp Cloud API · MSG91 · Gmail API · STT/TTS · Canva/Adobe Express
```

### Design rules

1. **One database, one lead record.** Extend the existing marketing lead table with the brief's pipeline statuses and fields. Add `lead_events` for history. Do not create a second `leads` table.
2. **The LLM never reads business facts from its own memory.** Every agent turn gets (a) retrieved KB passages ranked by the authority hierarchy, and (b) **tool calls** for anything numeric: `get_commercial_policy(property_id)`, `get_active_offers(audience)`, `get_referral_rules()`. If a tool returns nothing, the agent says "I'll confirm and get back to you" and opens a task. It does not guess.
3. **Agents act only through a tool registry.** Each tool declares a permission level: `auto`, `auto_within_limits`, `needs_approval:<role>` or `human_only`. These come straight from the brief's Part 15 table. The orchestrator enforces them in code, not in the prompt.
4. **Every side effect is logged to `agent_actions`** with input, output, provider confirmation ID and status. "Sent" or "called" is recorded only when the provider confirms it (webhook or API response).
5. **Consent is checked before every outbound contact**, inside the channel adapter. A prompt cannot bypass it. The check covers DND, opt-out, quiet hours, a per-lead frequency cap and channel consent.
6. **Kill switch:** a global flag plus a per-agent flag, checked by the worker before every action.
7. **Sensitive documents** (Aadhaar etc.) live in private storage with signed URLs. They are excluded from the LLM context by construction: the document tool returns only metadata.
8. **Model-independent.** A thin `LLMProvider` interface (chat, tool-calling, embeddings). Gemini is the default because the brief and probably the existing `generate-description` use it. Model choice is per agent in config.

### New tables (all in the existing database)

`kb_documents`, `kb_chunks` (pgvector embeddings, `authority_level`, `valid_from/to`, `approved_by`) ·
`commercial_policies` (per property, versioned, approval-gated) ·
`lead_events` · `contact_consents` · `contact_attempts` ·
`calls` (provider ID, recording URL, transcript, summary, outcome) ·
`conversations`, `messages` (WhatsApp/web chat) · `wa_templates` ·
`emails` · `institutions` · `partnerships` · `influencers` *(only if the partner program can't hold prospects)* ·
`field_visits` · `tracking_codes` (QR/UTM → campaign) · `expenses` ·
`creatives` · `brand_assets` ·
`agents`, `agent_runs`, `agent_actions` (audit) · `approvals` · `followup_rules` · `daily_plans`.

Existing tables to extend (names to be confirmed once I have the code): marketing leads, coupons, campaigns, partner-program, referrals.

---

## 3. Compliance items that block calling and WhatsApp

These are not optional, and they decide the provider setup. **Have Indian telecom/privacy counsel confirm them before any outbound AI calls start.**

- **TRAI commercial-communication rules (TCCCPR):** promotional calls must come from a registered telemarketer setup and the series the rules require (140-series for promotional voice), and must not reach numbers on the DND/NCPR register unless the person has consented. Exotel/MyOperator can provision this, but NiwasNest must complete DLT/entity registration. PG owners usually use personal mobiles, so DND applies to them.
- **DPDP Act 2023:** you need a notice and a lawful basis for processing personal data, plus purpose limitation, retention limits and an easy opt-out. Phone numbers scraped from Maps or directories are high-risk for automated calling. Prefer inbound leads, referrals, field-collected consent and owners already in your system.
- **AI disclosure and recording:** the bot should say it is an AI assistant from NiwasNest and that the call may be recorded, at the start of the call.
- **WhatsApp:** business-initiated messages outside the 24-hour window must use Meta-approved templates and need user opt-in.
- **Email:** an unsubscribe link and honouring it, sending limits, and no purchased lists.

Product implication: the first calling pilot should target **owners who already opted in or are already in your CRM** (existing marketing/telecaller leads with consent). Do not start with cold-scraped numbers.

---

## 4. Phased plan (revised)

Timelines assume one developer working with me on the real codebase. The brief's 30 days for 13 agents is not realistic at production quality. Phases are ordered by the brief's own business-bottleneck priority.

### Phase 0: Access and decisions (blocking, 1–3 days)
- Give this session the **backend and frontend repositories** (and a staging database or a schema dump).
- Founder decisions in §6.
- Confirm the LLM provider and key currently used by `generate-description`.

### Phase 1: Foundation (≈2 weeks). Nothing customer-facing.
1. Schema migrations: extend leads with the brief's 16 statuses (mapped from existing statuses); add `lead_events`, `commercial_policies`, `approvals`, `agent_actions`, `contact_consents`, `contact_attempts`, `tracking_codes`, `expenses`, `kb_*`.
2. Duplicate detection: normalised E.164 phone, normalised address plus geo radius, business name similarity. Merge UI for admins.
3. Knowledge base: ingest the master spec, FAQs, scripts and terms. Admin UI to approve and version entries by authority level. Historical proposals are stored as level 5 and are never quoted.
4. Policy engine: `get_commercial_policy`, `get_active_offers`, `get_referral_rules`, all read from the database.
5. Agent runtime: orchestrator, tool registry with permission levels, approval queue, kill switch, audit log, rate limits.
6. Command Center admin section: approvals inbox, agent activity, funnel KPIs (already-live data first).
7. Tests: lead CRUD, dedupe, policy retrieval, permission enforcement, approval flow, kill switch, consent gate.

### Phase 2: Owner acquisition channels (≈3 weeks)
1. WhatsApp Cloud API adapter: templates, inbound webhook, 24h-window logic, opt-out keywords, human handoff into the existing telecaller queue.
2. Voice telecaller pilot in **Telugu and English**: Exotel/MyOperator plus streaming STT/TTS plus the LLM with tool-calling. Outcomes are interested, callback, not interested or DNC, and each writes the lead status. It sends the existing **claim/onboarding link** over WhatsApp. Start with a small, consented list. Every call is human-reviewed in week 1.
3. Follow-up engine with a configurable cadence (default D0/D1/D3/D7). It stops on opt-out or a status change.
4. Onboarding agent: watches claim-link completion, photo coverage and missing fields, sends reminders, and hands off to the admin verification queue. It never approves.
5. Kannada and Hindi after Telugu quality passes review. Success metric: **listings that went live**, not calls made.

### Phase 3: Customer side and partnerships (≈3 weeks)
1. Website chat widget: visitor intent routing (owner, student, college, creator), PG search via the existing `/search`, and creating enquiries or bookings through existing endpoints.
2. Institutions pipeline: research from public sources, institution-specific proposals, Gmail drafts. **Sending requires approval** until reply and bounce rates are understood.
3. Creator outreach on top of the existing partner program: discovery list, drafts, approval. No bulk DMs.

### Phase 4: Growth marketing (≈2 weeks)
1. Offer and campaign manager: drafts go to an approval with budget, cap, dates and T&Cs, then publish to coupons/campaigns.
2. A unique tracking code and QR per physical placement (tea shop, lift, tent), resolving to campaign → lead → listing → booking.
3. Expense logging plus campaign ROI: cost per live PG and cost per completed booking.
4. Creative generation from a stored brand guide (orange `#F67900`, Inter + Bricolage Grotesque, from the live site) through Canva/Adobe Express. QR destinations come only from `tracking_codes`.

### Phase 5: Intelligence (ongoing)
Daily plan generation, call-transcript win/loss analysis to improve scripts, territory map (live listings vs. lead density per locality), competitor notes (public sources only).

---

## 5. Risks

| Risk | Mitigation |
|---|---|
| Building a parallel CRM because the code is unavailable | Phase 0 access is mandatory. Do not start Phase 1 without it. |
| The AI quotes the wrong commission or contradicts "zero brokerage" | Numbers come only from tools. KB authority ranking. Script review. Policy-violation tests. |
| Telecom/DPDP violations from automated cold calling | Consent gate in code, DND scrub, registered calling setup, consented pilot list. |
| Telugu voice quality hurts the brand | Small pilot, human review of transcripts, fallback to a human telecaller. |
| Referral fraud and self-referrals | Reuse partner-program risk tooling. Payouts only after check-in, plus finance approval. |
| LLM cost overrun | Per-agent budgets, cached KB retrieval, cheaper models for summaries. |
| Breaking production | All work behind feature flags, staging first, additive migrations only. |

---

## 6. Decisions needed from the founder

1. **Repositories:** where are the backend and frontend source? Please add them to this GitHub org or give me access. *(Blocking.)*
2. **Owner commercial terms:** which single policy is active today, and is it stored per property (`/properties/{id}/agreement`)? What exact wording should the AI use alongside "free listing, zero brokerage"?
3. **PG-owner referral:** confirm ₹500 × first 10 bookings, ₹5,000 cap. Is that what the partner-program backend pays today?
4. **Calling setup:** do you already have an Exotel or MyOperator account and DLT/telemarketer registration? Which number series?
5. **First pilot list:** which owners have given consent to be contacted (existing leads, field visits, inbound)?
6. **LLM:** keep Gemini as the default (what `generate-description` likely uses)?
7. **WhatsApp:** do you have a verified Meta Business account and WhatsApp number?

Once items 1, 2 and 6 are answered, Phase 1 can start.
