// Bridge to the live NiwasNest app (api.niwasnest.com). This is the ONLY place Growth OS talks
// to the main app, and it cannot change the app's code or data beyond two explicitly allowed,
// approval-gated calls. Reads are limited to an allowlist of paths the existing frontend uses.
//
// Use a dedicated staff account (marketing role), never the founder's admin login.

const READ_ALLOWLIST: RegExp[] = [
  /^\/marketing\/leads(\?.*)?$/,
  /^\/marketing\/leads\/[\w-]+$/,
  /^\/marketing\/(overview|performance|analytics|dashboard)(\?.*)?$/,
  /^\/telecaller\/leads(\?.*)?$/,
  /^\/properties\/admin\/queue(\?.*)?$/,
  /^\/properties\/[\w-]+\/photo-coverage$/,
  /^\/admin\/(funnel|analytics)(\?.*)?$/,
  /^\/search(\?.*)?$/,
  /^\/cities$/,
];

/** The only writes Growth OS may ever make, and only when NIWASNEST_API_WRITES_ENABLED=true. */
const WRITE_ALLOWLIST: { method: "POST"; path: RegExp; purpose: string }[] = [
  { method: "POST", path: /^\/marketing\/leads\/new-pg$/, purpose: "create a PG lead for an owner who agreed" },
  { method: "POST", path: /^\/marketing\/leads\/[\w-]+\/claim-link$/, purpose: "generate the owner's claim/onboarding link" },
];

export class MainAppError extends Error {}

export interface MainAppConfig {
  baseUrl: string;
  token?: string;
  writesEnabled: boolean;
  fetchImpl?: typeof fetch;
}

export function mainAppConfigFromEnv(env = process.env): MainAppConfig {
  return {
    baseUrl: env.NIWASNEST_API_BASE ?? "https://api.niwasnest.com",
    token: env.NIWASNEST_API_TOKEN || undefined,
    writesEnabled: env.NIWASNEST_API_WRITES_ENABLED === "true",
  };
}

export class NiwasNestApi {
  private fetchImpl: typeof fetch;
  constructor(private cfg: MainAppConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async get<T = unknown>(path: string): Promise<T> {
    if (!READ_ALLOWLIST.some((r) => r.test(path))) throw new MainAppError(`read not allowed: ${path}`);
    return this.request<T>("GET", path);
  }

  /** Approval-gated write. Callers must pass the approval id that authorised it (logged). */
  async post<T = unknown>(path: string, body: unknown, approvalId: string): Promise<T> {
    if (!this.cfg.writesEnabled) throw new MainAppError("writes to the main app are disabled (NIWASNEST_API_WRITES_ENABLED=false)");
    if (!approvalId) throw new MainAppError("writes require an approval id");
    if (!WRITE_ALLOWLIST.some((w) => w.path.test(path))) throw new MainAppError(`write not allowed: ${path}`);
    return this.request<T>("POST", path, body);
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    if (!this.cfg.token) throw new MainAppError("NIWASNEST_API_TOKEN not configured");
    const res = await this.fetchImpl(`${this.cfg.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.cfg.token}`, "content-type": "application/json", "user-agent": "niwasnest-growth-os/0.1" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new MainAppError(`${method} ${path} → ${res.status}`);
    return (await res.json()) as T;
  }
}
