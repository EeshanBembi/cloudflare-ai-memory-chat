import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";

/**
 * AIMemoryWorkflow - Cloudflare Workflows for coordination
 * Satisfies "Workflow / coordination" requirement.
 * Multi-step orchestration: 1) load memory 2) LLM call 3) summarize & persist
 * Durable, retryable, observable via `wrangler workflows` dashboard.
 */

export interface WorkflowParams {
  userId: string;
  message: string;
  model?: string;
}

export class AIMemoryWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
    const { userId, message, model = this.env.MODEL_ID || "@cf/meta/llama-3.3-70b-instruct" } = event.payload;

    // Step 1: Load memory/history from Durable Object
    const history = await step.do("load-memory", async () => {
      const id = this.env.MEMORY_DO.idFromName(userId);
      const stub = this.env.MEMORY_DO.get(id);
      const res = await stub.fetch(`https://memory/history?userId=${encodeURIComponent(userId)}&limit=20`);
      const data = (await res.json()) as { history: any[]; summary: string };
      return data;
    });

    // Step 2: Build prompt with memory-aware context window
    const messages = await step.do("build-prompt", async () => {
      const sys = history.summary
        ? `You are a helpful assistant. Past conversation summary: ${history.summary}\nRespond concisely and remember user preferences.`
        : "You are a helpful assistant with memory. Remember facts the user shares.";
      const hist = (history.history || []).map((m: any) => ({ role: m.role, content: m.content }));
      return [{ role: "system", content: sys }, ...hist, { role: "user", content: message }];
    });

    // Step 3: Call Workers AI - Llama 3.3 (or external LLM fallback)
    const llmResponse = await step.do(
      "call-llm",
      {
        retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
        timeout: "60 seconds",
      },
      async () => {
        // Primary: Workers AI Llama 3.3
        try {
          const resp = await this.env.AI.run(model as any, {
            messages,
            max_tokens: 1024,
            temperature: 0.7,
          } as any);
          // Workers AI returns { response: string } or string
          const text = (resp as any).response ?? (resp as any).text ?? JSON.stringify(resp);
          return text as string;
        } catch (e) {
          // Fallback: external LLM if Workers AI unavailable (e.g. OpenAI)
          if (this.env.OPENAI_API_KEY) {
            const r = await fetch("https://api.openai.com/v1/chat/completions", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${this.env.OPENAI_API_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ model: "gpt-4o-mini", messages, temperature: 0.7 }),
            });
            const j = (await r.json()) as any;
            return j.choices?.[0]?.message?.content ?? "No response from fallback LLM";
          }
          throw e;
        }
      }
    );

    // Step 4: Persist user + assistant turn to Durable Object
    await step.do("persist-turn", async () => {
      const id = this.env.MEMORY_DO.idFromName(userId);
      const stub = this.env.MEMORY_DO.get(id);
      const now = Date.now();
      await stub.fetch(`https://memory/add?userId=${encodeURIComponent(userId)}`, {
        method: "POST",
        body: JSON.stringify({ role: "user", content: message, timestamp: now }),
      });
      await stub.fetch(`https://memory/add?userId=${encodeURIComponent(userId)}`, {
        method: "POST",
        body: JSON.stringify({ role: "assistant", content: llmResponse, timestamp: now + 1 }),
      });
      return true;
    });

    // Step 5: Rolling summary (every 10 turns, keep context compact)
    await step.do("maybe-summarize", async () => {
      if ((history.history?.length ?? 0) % 10 === 9) {
        const summaryPrompt = [
          { role: "system", content: "Summarize this conversation in 3-5 bullet points, keep names, preferences, and open tasks." },
          ...messages.slice(1), // exclude system
          { role: "assistant", content: llmResponse },
        ];
        try {
          const s = (await this.env.AI.run(model as any, { messages: summaryPrompt, max_tokens: 512 } as any)) as any;
          const summary = s.response ?? s.text ?? "";
          const id = this.env.MEMORY_DO.idFromName(userId);
          const stub = this.env.MEMORY_DO.get(id);
          await stub.fetch(`https://memory/summary?userId=${encodeURIComponent(userId)}`, {
            method: "POST",
            body: JSON.stringify({ summary }),
          });
        } catch {}
      }
    });

    return llmResponse;
  }
}
