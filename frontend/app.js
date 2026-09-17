// C3 Frontend - Chat + Voice (Pages) + Workflow + Memory DO
const $ = (s) => document.querySelector(s);
const chatEl = $("#chat");
const inputEl = $("#input");
const statusEl = $("#status");
const userIdEl = $("#userId");
const workerUrlEl = $("#workerUrl");

function addMsg(role, content) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = content;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function setStatus(msg) { statusEl.textContent = msg; }

async function loadHistory() {
  chatEl.innerHTML = "";
  const userId = userIdEl.value || "demo";
  const url = `${workerUrlEl.value.replace(/\/$/, "")}/history?userId=${encodeURIComponent(userId)}`;
  try {
    const r = await fetch(url);
    const data = await r.json();
    if (data.summary) addMsg("system", `Memory summary: ${data.summary}`);
    (data.history || []).forEach((m) => addMsg(m.role, m.content));
    if (!data.history?.length) addMsg("assistant", "Hi! I'm C3 — your Cloudflare AI companion with memory. Try voice or chat. I remember what you tell me across sessions (Durable Object).");
  } catch (e) {
    addMsg("system", `Failed to load history: ${e.message}. Is Worker running at ${workerUrlEl.value}?`);
  }
}

async function sendMessage({ stream = false } = {}) {
  const userId = userIdEl.value || "demo";
  const message = inputEl.value.trim();
  if (!message) return;
  addMsg("user", message);
  inputEl.value = "";
  setStatus(stream ? "Streaming via direct LLM + DO..." : "Running Workflow: load-memory → Llama 3.3 → persist...");

  const endpoint = stream ? "/chat/stream" : "/chat";
  const url = `${workerUrlEl.value.replace(/\/$/, "")}${endpoint}`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, message }),
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error);
    addMsg("assistant", data.response);
    setStatus(`Done. ${data.workflowId ? `Workflow: ${data.workflowId}` : "Direct path"} | Memory persisted to Durable Object.`);
  } catch (e) {
    addMsg("system", `Error: ${e.message}`);
    setStatus("Failed");
  }
}

// Voice via Web Speech API (frontend) - satisfies "voice" requirement. For Realtime, swap with Cloudflare Realtime WebRTC.
let recognition = null;
let recording = false;

function initVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    $("#voiceBtn").textContent = "🎤 N/A";
    $("#voiceBtn").disabled = true;
    $("#voiceBtn").title = "Web Speech API not supported in this browser. Use Chrome. For prod, integrate Cloudflare Realtime.";
    return;
  }
  recognition = new SR();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = "en-US";
  recognition.onstart = () => {
    recording = true;
    $("#voiceBtn").classList.add("recording");
    $("#voiceBtn").textContent = "⏹️ Stop";
    setStatus("Listening... speak now");
  };
  recognition.onend = () => {
    recording = false;
    $("#voiceBtn").classList.remove("recording");
    $("#voiceBtn").textContent = "🎤 Voice";
    setStatus("");
  };
  recognition.onresult = (e) => {
    const transcript = e.results[0][0].transcript;
    inputEl.value = transcript;
    setStatus(`Heard: "${transcript}" - sending to /voice Workflow...`);
    // Auto-send voice transcript via /voice endpoint (same workflow)
    setTimeout(async () => {
      const userId = userIdEl.value || "demo";
      addMsg("user", `🎤 ${transcript}`);
      const url = `${workerUrlEl.value.replace(/\/$/, "")}/voice`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, transcript }),
      });
      const data = await r.json();
      addMsg("assistant", data.response);
      setStatus("Voice workflow done. Memory updated.");
    }, 300);
  };
  recognition.onerror = (e) => {
    setStatus(`Voice error: ${e.error}`);
  };
}

// Events
$("#sendBtn").onclick = () => sendMessage({ stream: false });
$("#streamBtn").onclick = () => sendMessage({ stream: true });
$("#clearBtn").onclick = async () => {
  const userId = userIdEl.value || "demo";
  await fetch(`${workerUrlEl.value.replace(/\/$/, "")}/history?userId=${encodeURIComponent(userId)}`, { method: "DELETE" });
  loadHistory();
};
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
$("#voiceBtn").onclick = () => {
  if (!recognition) return;
  if (recording) recognition.stop();
  else recognition.start();
};
userIdEl.addEventListener("change", loadHistory);
workerUrlEl.addEventListener("change", loadHistory);

initVoice();
loadHistory();

// Optional: Cloudflare Realtime placeholder
// For production voice, replace Web Speech with:
// import { RealtimeKit } from "@cloudflare/realtimekit";
// const kit = new RealtimeKit({ auth: "WORKER_TOKEN" }); kit.join();
