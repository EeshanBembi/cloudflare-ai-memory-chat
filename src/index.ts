import { Hono } from "hono";
import { cors } from "hono/cors";
import { MemoryDO } from "./memory-do";
import { AIMemoryWorkflow } from "./workflow";

export { MemoryDO, AIMemoryWorkflow };

type Bindings = Env;

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", cors());

// Health
app.get("/", (c) => c.json({ ok: true, app: "cloudflare-ai-memory-chat", docs: "/docs" }));
app.get("/docs", (c) => c.html(`<h1>C3 – Cloudflare Conversational Companion</h1>
<p>Components: Workers AI (Llama 3.3) • Workflows • Durable Objects (memory) • Pages/Realtime (chat+voice)</p>
<ul>
<li>POST /chat {userId, message} -> Workflow -> Llama -> persisted memory</li>
<li>GET /history?userId=xxx -> Durable Object history</li>
<li>POST /voice {userId, transcript} -> same as chat (use Web Speech API on frontend)</li>
<li>DELETE /history?userId=xxx -> clear memory</li>
</ul>`));

// Chat - triggers Workflow (durable coordination)
app.post("/chat", async (c) => {
  const { userId = "anonymous", message, model } = await c.req.json<{ userId?: string; message: string; model?: string }>();
  if (!message) return c.json({ error: "message required" }, 400);

  // Durable workflow execution (retryable, observable in dashboard)
  const instance = await c.env.AI_WORKFLOW.create({ params: { userId, message, model } });
  // Poll until complete (in prod you might return instance.id and poll from frontend)
  let status: any = await instance.status();
  let attempts = 0;
  while (status.status !== "complete" && status.status !== "error" && attempts < 30) {
    await new Promise((r) => setTimeout(r, 800));
    status = await instance.status();
    attempts++;
  }
  const result = status.status === "complete" ? status.output : `Workflow ${status.status}: ${status.error || "timeout, check dashboard"}`;

  return c.json({ response: result, workflowId: instance.id, userId, workflowStatus: status.status });
});

// Streaming chat (alternative low-latency path without workflow - still persists via DO)
app.post("/chat/stream", async (c) => {
  const { userId = "anonymous", message } = await c.req.json<{ userId?: string; message: string }>();
  if (!message) return c.json({ error: "message required" }, 400);

  const id = c.env.MEMORY_DO.idFromName(userId);
  const stub = c.env.MEMORY_DO.get(id);
  const histRes = await stub.fetch(`https://memory/history?userId=${encodeURIComponent(userId)}&limit=20`);
  const { history, summary } = (await histRes.json()) as { history: any[]; summary: string };

  const sys = summary ? `Summary: ${summary}` : "You are a helpful assistant with memory.";
  const messages = [{ role: "system", content: sys }, ...history.map((m: any) => ({ role: m.role, content: m.content })), { role: "user", content: message }];

  // Call Workers AI with streaming if available
  const model = c.env.MODEL_ID || "@cf/meta/llama-3.3-70b-instruct";
  const aiResp: any = await c.env.AI.run(model as any, { messages, stream: false, max_tokens: 1024 } as any);
  const text: string = aiResp.response ?? aiResp.text ?? JSON.stringify(aiResp);

  // Persist
  const now = Date.now();
  await stub.fetch(`https://memory/add?userId=${encodeURIComponent(userId)}`, {
    method: "POST",
    body: JSON.stringify({ role: "user", content: message, timestamp: now }),
  });
  await stub.fetch(`https://memory/add?userId=${encodeURIComponent(userId)}`, {
    method: "POST",
    body: JSON.stringify({ role: "assistant", content: text, timestamp: now + 1 }),
  });

  return c.json({ response: text });
});

// Voice input - same as chat, frontend uses Web Speech API (or Cloudflare Realtime)
app.post("/voice", async (c) => {
  const { userId = "anonymous", transcript } = await c.req.json<{ userId?: string; transcript: string }>();
  if (!transcript) return c.json({ error: "transcript required" }, 400);
  const instance = await c.env.AI_WORKFLOW.create({ params: { userId, message: transcript } });
  let status: any = await instance.status();
  let attempts = 0;
  while (status.status !== "complete" && status.status !== "error" && attempts < 30) {
    await new Promise((r) => setTimeout(r, 800));
    status = await instance.status();
    attempts++;
  }
  const result = status.status === "complete" ? status.output : `Workflow ${status.status}`;
  return c.json({ response: result, workflowId: instance.id });
});

app.get("/history", async (c) => {
  const userId = c.req.query("userId") || "anonymous";
  const id = c.env.MEMORY_DO.idFromName(userId);
  const stub = c.env.MEMORY_DO.get(id);
  const res = await stub.fetch(`https://memory/history?userId=${encodeURIComponent(userId)}&limit=50`);
  const data = await res.json();
  return c.json(data);
});

app.delete("/history", async (c) => {
  const userId = c.req.query("userId") || "anonymous";
  const id = c.env.MEMORY_DO.idFromName(userId);
  const stub = c.env.MEMORY_DO.get(id);
  await stub.fetch(`https://memory/clear?userId=${encodeURIComponent(userId)}`, { method: "DELETE" });
  return c.json({ ok: true });
});

// External LLM fallback test
app.post("/chat/external", async (c) => {
  const { message } = await c.req.json<{ message: string }>();
  if (!c.env.OPENAI_API_KEY) return c.json({ error: "OPENAI_API_KEY not set" }, 400);
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${c.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: message }] }),
  });
  const j = await r.json();
  return c.json(j);
});

export default app;
