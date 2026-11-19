import { describe, expect, it } from "vitest";
import { inlineParams, sqlLiteral, SupabaseManagementClient, type SqlClient } from "../src/store/sql";
import { PostgresSink, loadStore, rowToLead } from "../src/store/postgres";
import { GrowthStore } from "../src/store/memory";
import { parseCsv } from "../src/core/csv";
import { importLeads } from "../src/planning/import-leads";

class FakeDb implements SqlClient {
  calls: { sql: string; params: unknown[] }[] = [];
  constructor(private responder: (sql: string) => unknown[] = () => []) {}
  async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.calls.push({ sql, params });
    return this.responder(sql) as T[];
  }
}

describe("SQL inlining (Management API transport)", () => {
  it("escapes quotes so values cannot break out of the literal", () => {
    expect(sqlLiteral("Ravi's PG'); drop table leads; --")).toBe("'Ravi''s PG''); drop table leads; --'");
    expect(inlineParams("select * from leads where pg_name = $1", ["x' or '1'='1"])).toBe("select * from leads where pg_name = 'x'' or ''1''=''1'");
  });
  it("handles numbers, booleans, nulls, dates, json and $10+", () => {
    const p = [1, true, null, new Date("2026-11-19T00:00:00Z"), { a: 1 }, 6, 7, 8, 9, "ten"];
    expect(inlineParams("$1,$2,$3,$4,$5,$10", p)).toBe(`1,true,null,'2026-11-19T00:00:00.000Z','{"a":1}','ten'`);
  });
  it("does not substitute $n inside quoted SQL text and rejects missing params", () => {
    expect(inlineParams("select '$1' , $1", ["a"])).toBe("select '$1' , 'a'");
    expect(() => inlineParams("select $2", ["a"])).toThrow(/missing/);
  });
  it("sends inlined SQL to the management endpoint and surfaces errors", async () => {
    const seen: { url: string; body: string }[] = [];
    const ok = (async (url: string, init: RequestInit) => { seen.push({ url, body: String(init.body) }); return new Response("[{\"x\":1}]", { status: 201 }); }) as unknown as typeof fetch;
    const c = new SupabaseManagementClient("ref123", "tok", ok);
    expect(await c.query("select $1 as x", [1])).toEqual([{ x: 1 }]);
    expect(seen[0]!.url).toBe("https://api.supabase.com/v1/projects/ref123/database/query");
    expect(JSON.parse(seen[0]!.body).query).toBe("select 1 as x");
    const bad = (async () => new Response('{"message":"boom"}', { status: 400 })) as unknown as typeof fetch;
    await expect(new SupabaseManagementClient("r", "t", bad).query("x")).rejects.toThrow(/SQL failed \(400\)/);
  });
});

describe("Postgres persistence", () => {
  it("writes a lead before its events, in order, and flush reports success", async () => {
    const db = new FakeDb();
    const store = new GrowthStore(new PostgresSink(db));
    const { lead } = store.createLead({ kind: "pg_owner", pgName: "Sri Sai PG", phoneE164: "9848012345", city: "Bengaluru", source: "t", language: "te" }, "test");
    store.setStatus(lead.id, "contacted", "agent", "agent");
    store.log({ agentKey: "a", action: "update_crm", input: { x: 1 }, result: "done", providerRef: "crm" });
    await store.flush();
    const verbs = db.calls.map((c) => c.sql.split(" ").slice(0, 3).join(" "));
    expect(verbs).toEqual(["insert into leads", "insert into lead_events", "update leads set", "insert into lead_events", "insert into agent_actions"]);
    expect(db.calls[0]!.params[0]).toBe(lead.id);
    expect(db.calls[0]!.params).toContain("+919848012345");
  });

  it("flush throws if any write failed, so nothing is reported as saved", async () => {
    const db: SqlClient = { query: async () => { throw new Error("connection lost"); } };
    const store = new GrowthStore(new PostgresSink(db));
    store.log({ agentKey: "a", action: "x", input: {}, result: "done" });
    await expect(store.flush()).rejects.toThrow(/connection lost/);
  });

  it("hydrates leads, policies and the kill switch", async () => {
    const db = new FakeDb((sql) => {
      if (sql.startsWith("select * from leads")) return [{ id: "u1", kind: "pg_owner", city: "Bengaluru", source: "csv", language: "te", status: "interested", opted_out: false, created_at: "2026-11-19T00:00:00Z", vacant_beds: 4, pg_name: "A" }];
      if (sql.startsWith("select * from commercial_policies")) return [{ id: "p", type: "first_month_commission", percent: "20.00", applies_to_months: "first_month_only", approved_wording: "w", status: "approved", approved_by_name: "Founder", effective_from: "2026-01-01" }];
      if (sql.startsWith("select agent_key")) return [{ agent_key: "*", paused: true }, { agent_key: "owner_sales", paused: true }];
      return [];
    });
    const store = await loadStore(db);
    expect(store.leads.get("u1")).toMatchObject({ status: "interested", vacantBeds: 4 });
    expect(store.policies[0]).toMatchObject({ percent: 20, approvedBy: "Founder", scope: { kind: "default" } });
    expect(store.killSwitch.global).toBe(true);
    expect(store.killSwitch.agents.has("owner_sales")).toBe(true);
  });

  it("maps database rows to leads", () => {
    expect(rowToLead({ id: "x", kind: "pg_owner", city: "Bengaluru", source: "s", language: "kn", status: "live", opted_out: true, created_at: "2026-01-01T00:00:00Z", lat: "12.9" })).toMatchObject({ lat: 12.9, optedOut: true, language: "kn" });
  });
});

describe("CSV import", () => {
  const csv = `owner_name,pg_name,phone,address,locality,property_type,vacant_beds,language,consent_call,consent_whatsapp,consent_evidence
Ravi,"Sri Sai PG, BTM",98480 12345,"12, 3rd Cross",BTM Layout,male,6,te,yes,yes,"Field visit 19-Nov, agreed in person"
Ravi again,Sri Sai PG,+91 98480-12345,,BTM Layout,,,te,,,
Meena,Green Nest,12345,,HSR Layout,female,,en,yes,yes,
Kiran,Kiran Residency,9000011111,,E-City,co-living,3,kn,yes,,`;

  it("parses quoted commas", () => {
    expect(parseCsv(csv)[0]).toMatchObject({ pg_name: "Sri Sai PG, BTM", address: "12, 3rd Cross" });
  });

  it("creates leads, skips duplicates, rejects bad phones, and needs evidence for consent", () => {
    const store = new GrowthStore();
    const rep = importLeads(store, parseCsv(csv), "test");
    expect(rep.created.map((l) => l.pgName)).toEqual(["Sri Sai PG, BTM", "Kiran Residency"]);
    expect(rep.skippedDuplicates[0]).toMatchObject({ row: 3, reason: "phone" });
    expect(rep.invalid[0]).toMatchObject({ row: 4 });
    expect(rep.consentsRecorded).toBe(2); // Kiran said yes but no evidence → none recorded
    expect(store.leads.size).toBe(2);
    expect(rep.created[1]).toMatchObject({ propertyType: "co_living", language: "kn", vacantBeds: 3 });
  });
});
