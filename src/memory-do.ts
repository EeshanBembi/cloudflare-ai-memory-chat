import { DurableObject } from "cloudflare:workers";

/**
 * MemoryDO - Durable Object with SQLite for persistent memory/state
 * Stores per-user conversation history, preferences, and semantic memory.
 * Satisfies "Memory or state" requirement via Durable Objects + SQLite.
 */
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

export interface UserMemory {
  userId: string;
  messages: ChatMessage[];
  summary: string; // rolling summary for long contexts
  preferences: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export class MemoryDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.init();
  }

  private init() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, timestamp);
      CREATE TABLE IF NOT EXISTS memory (
        user_id TEXT PRIMARY KEY,
        summary TEXT,
        preferences TEXT,
        updated_at INTEGER
      );
    `);
  }

  async addMessage(userId: string, msg: ChatMessage): Promise<void> {
    this.sql.exec(
      "INSERT INTO messages (user_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
      userId, msg.role, msg.content, msg.timestamp
    );
    this.sql.exec(
      `INSERT INTO memory (user_id, summary, preferences, updated_at)
       VALUES (?, '', '{}', ?)
       ON CONFLICT(user_id) DO UPDATE SET updated_at = ?`,
      userId, msg.timestamp, msg.timestamp
    );
    // Keep last 100 messages, trim older
    this.sql.exec(
      `DELETE FROM messages WHERE user_id = ? AND id NOT IN (
        SELECT id FROM messages WHERE user_id = ? ORDER BY timestamp DESC LIMIT 100
      )`, userId, userId
    );
  }

  async getHistory(userId: string, limit = 20): Promise<ChatMessage[]> {
    const cursor = this.sql.exec(
      "SELECT role, content, timestamp FROM messages WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?",
      userId, limit
    );
    const rows = cursor.toArray() as unknown as ChatMessage[];
    return rows.reverse();
  }

  async getSummary(userId: string): Promise<string> {
    const cursor = this.sql.exec("SELECT summary FROM memory WHERE user_id = ?", userId);
    const row = cursor.toArray()[0] as any;
    return row?.summary ?? "";
  }

  async updateSummary(userId: string, summary: string): Promise<void> {
    this.sql.exec("UPDATE memory SET summary = ?, updated_at = ? WHERE user_id = ?", summary, Date.now(), userId);
  }

  async getPreferences(userId: string): Promise<Record<string, string>> {
    const cursor = this.sql.exec("SELECT preferences FROM memory WHERE user_id = ?", userId);
    const row = cursor.toArray()[0] as any;
    return row?.preferences ? JSON.parse(row.preferences) : {};
  }

  async setPreference(userId: string, key: string, value: string): Promise<void> {
    const prefs = await this.getPreferences(userId);
    prefs[key] = value;
    this.sql.exec("UPDATE memory SET preferences = ?, updated_at = ? WHERE user_id = ?", JSON.stringify(prefs), Date.now(), userId);
  }

  async clearHistory(userId: string): Promise<void> {
    this.sql.exec("DELETE FROM messages WHERE user_id = ?", userId);
    this.sql.exec("UPDATE memory SET summary = '' WHERE user_id = ?", userId);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const userId = url.searchParams.get("userId") || "anonymous";

    if (request.method === "POST" && url.pathname === "/add") {
      const msg = (await request.json()) as ChatMessage;
      await this.addMessage(userId, msg);
      return Response.json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/history") {
      const limit = Number(url.searchParams.get("limit") || "20");
      const history = await this.getHistory(userId, limit);
      const summary = await this.getSummary(userId);
      return Response.json({ history, summary });
    }
    if (request.method === "POST" && url.pathname === "/summary") {
      const { summary } = (await request.json()) as { summary: string };
      await this.updateSummary(userId, summary);
      return Response.json({ ok: true });
    }
    if (request.method === "DELETE" && url.pathname === "/clear") {
      await this.clearHistory(userId);
      return Response.json({ ok: true });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }
}
