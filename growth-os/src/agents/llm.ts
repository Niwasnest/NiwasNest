// Model-independent LLM interface. Business logic never lives in a model; swap providers freely.

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolName?: string;
}

export interface LlmTurn {
  text?: string;
  toolCalls: { name: string; args: Record<string, unknown> }[];
}

export interface LlmProvider {
  name: string;
  complete(messages: LlmMessage[], tools: ToolSpec[]): Promise<LlmTurn>;
}

/** Deterministic provider for tests and dry runs: replays a scripted list of turns. */
export class ScriptedProvider implements LlmProvider {
  name = "scripted";
  constructor(private turns: LlmTurn[]) {}
  seen: LlmMessage[][] = [];
  async complete(messages: LlmMessage[]): Promise<LlmTurn> {
    this.seen.push(messages);
    return this.turns.shift() ?? { text: "", toolCalls: [] };
  }
}

/** Google Gemini via REST (function calling). Requires GEMINI_API_KEY. */
export class GeminiProvider implements LlmProvider {
  name = "gemini";
  constructor(private apiKey: string, private model = "gemini-2.5-flash", private fetchImpl: typeof fetch = fetch) {}

  async complete(messages: LlmMessage[], tools: ToolSpec[]): Promise<LlmTurn> {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const contents = messages
      .filter((m) => m.role !== "system")
      .map((m) =>
        m.role === "tool"
          ? { role: "user", parts: [{ functionResponse: { name: m.toolName, response: { result: m.content } } }] }
          : { role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] },
      );
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools: tools.length ? [{ functionDeclarations: tools }] : undefined,
      generationConfig: { temperature: 0.3 },
    };
    const res = await this.fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`,
      { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey }, body: JSON.stringify(body) },
    );
    if (!res.ok) throw new Error(`Gemini error ${res.status}`);
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string; functionCall?: { name: string; args?: Record<string, unknown> } }[] } }[];
    };
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    return {
      text: parts.map((p) => p.text ?? "").join("").trim() || undefined,
      toolCalls: parts.filter((p) => p.functionCall).map((p) => ({ name: p.functionCall!.name, args: p.functionCall!.args ?? {} })),
    };
  }
}

export function providerFromEnv(env = process.env): LlmProvider {
  if (env.LLM_PROVIDER === "gemini") {
    if (!env.GEMINI_API_KEY) throw new Error("LLM_PROVIDER=gemini but GEMINI_API_KEY is not set");
    return new GeminiProvider(env.GEMINI_API_KEY, env.GEMINI_MODEL);
  }
  return new ScriptedProvider([]);
}
