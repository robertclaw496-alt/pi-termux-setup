// recovery-continuation.mjs
//
// Единый recovery-continuation primitive, общий для pi-safe и pi-resurrect.
//
// Отвечает за:
//   - durable identity recovery event: session_id + generation + attempt
//   - статусы: PENDING -> STARTED -> COMPLETED | FAILED(*n) -> BLOCKED
//   - bounded loop: максимум MAX_ATTEMPTS попыток на session+window
//   - безопасный recovery prompt (структурированный, без исходного user
//     prompt, без секретов и сырого journal dump)
//   - защиту от двойного запуска: если previous STARTED c живым childPid ->
//     WAIT вместо нового запуска
//
// State: RUNTIME/recovery-continuation.json (600), dir 700.
// Events: RUNTIME/recovery-continuation-events.jsonl (600, без секретов).

import { mkdir, readFile, writeFile, rename, readdir, unlink, open, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const HOME = process.env.HOME || "/data/data/com.termux/files/home";
const PI_DIR = process.env.PI_CODING_AGENT_DIR || join(HOME, ".pi", "agent");
export const RUNTIME = process.env.PI_RECOVERY_RUNTIME || join(PI_DIR, "runtime");
const STATE_FILE = join(RUNTIME, "recovery-continuation.json");
const EVENTS_FILE = join(RUNTIME, "recovery-continuation-events.jsonl");
const LOCK_FILE = join(RUNTIME, "recovery-continuation.lock");

export const MAX_ATTEMPTS = Number(process.env.PI_CONTINUATION_MAX_ATTEMPTS || 3);
export const WINDOW_MS = Number(process.env.PI_CONTINUATION_WINDOW_MS || 10 * 60 * 1000);
export const CONTINUATION_TIMEOUT_MS = Number(process.env.PI_CONTINUATION_TIMEOUT_MS || 45 * 60 * 1000);

const now = () => new Date().toISOString();

// ---------------------------------------------------------------- helpers --

const redact = (value) =>
  String(value ?? "")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s\n]+/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password|cookie|session)[^\n]{0,40}[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(sk-[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    .replace(/(\d{9,})/g, "[ID]");

export function hashOf(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 16);
}

export function promptHash(text) {
  return hashOf(`continuation\n${text}`);
}

async function ensureRuntime() {
  await mkdir(RUNTIME, { recursive: true, mode: 0o700 });
}

async function atomicWrite(path, value) {
  await ensureRuntime();
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, path);
}

export async function loadState() {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || typeof parsed.sessionId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function readJson(path, fallback = null) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

export const pidAlive = (pid, starttime) => {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    const procStat = readFileSync(`/proc/${n}/stat`, "utf8");
    const close = procStat.lastIndexOf(")");
    const after = procStat.slice(close + 2).split(" ");
    const state = after[0];
    if (state === "Z") return false;
    if (starttime != null) {
      const procStart = Number(after[19]); // field 22 -> index 19 после comm
      if (Number.isFinite(procStart) && Math.abs(procStart - Number(starttime)) > 3) return false;
    }
  } catch {}
  try { process.kill(n, 0); return true; } catch { return false; }
};

async function logEvent(event) {
  try {
    await ensureRuntime();
    await writeFile(EVENTS_FILE, JSON.stringify(event) + "\n", { flag: "a", mode: 0o600 });
  } catch {}
}

async function withLock(fn) {
  await ensureRuntime();
  let fh = null;
  for (let i = 0; i < 24; i++) {
    try {
      fh = await open(LOCK_FILE, "wx", 0o600);
      break;
    } catch {
      // lock существует: fail-closed, не удаляем чужой живой lock
      let holder = null;
      try { holder = JSON.parse(await readFile(LOCK_FILE, "utf8")); } catch {}
      if (holder?.pid) {
        if (pidAlive(holder.pid) || holder.pid === process.pid) {
          // владелец жив (возможно, мы сами в параллельном вызове) -> ждём освобождения
          await new Promise((r) => setTimeout(r, 50));
          continue;
        }
        // мёртвый владелец -> stale lock
        await unlink(LOCK_FILE).catch(() => {});
        continue;
      }
      // файл пуст/битый (только что создан владельцем): ждём короткое окно
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (!fh) throw new Error("recovery-continuation: lock is busy");
  try {
    await fh.writeFile(JSON.stringify({ pid: process.pid, startedAt: now() }));
    return await fn();
  } finally {
    await fh.close().catch(() => {});
    await unlink(LOCK_FILE).catch(() => {});
  }
}

// ------------------------------------------------------------ prompt build --

// Recovery prompt: НЕ содержит исходный user prompt, сырой journal dump,
// tool args или секреты. Только структурная сводка + инструкции.
export function buildRecoveryPrompt({ sessionId, generation, attempt, summary = {}, sessionContext = [] }) {
  const lines = [
    "This is an automatic recovery continuation after an abnormal process loss.",
    "",
    "Resume the existing task from persisted session state. Inspect TODOs, completed tool calls and their results, action-safety journal state, subagent lifecycle and filesystem/external evidence.",
    "Do not repeat completed work. Do not replay external actions unless reconciliation or direct evidence proves they did not land.",
    "Continue from the first unfinished step and finish the task autonomously.",
    "Stop only on a real external blocker; otherwise verify the next step and proceed.",
  ];
  const meta = [`recovery generation: ${generation}`, `continuation attempt: ${attempt}`];
  if (sessionId) meta.push(`session id: ${sessionId}`);
  const safeSummary = {};
  for (const key of ["journalStart", "journalComplete", "journalUnknown", "todoIncomplete", "subagentActive", "subagentComplete", "lastRuntimeEvent"]) {
    if (summary[key] != null) safeSummary[key] = summary[key];
  }
  if (Object.keys(safeSummary).length) {
    lines.push("", "Recovered evidence summary:", JSON.stringify(safeSummary, null, 0));
  }
  if (Array.isArray(sessionContext) && sessionContext.length > 0) {
    lines.push("", "Recovered task context (condensed summary of the interrupted session; contains no secrets):");
    for (const item of sessionContext) lines.push(`- ${item}`);
    lines.push("", "Use the recovered context to identify the unfinished task and continue it. The session file itself may not be shown to the model in headless mode.");
  }
  lines.push("", ...meta.map(x => `> ${x}`));
  return lines.join("\n");
}

// -------------------------------------------------- session context digest --

// Condenses the tail of a session file into short, secret-free lines for the
// recovery prompt. Headless resume (print mode) does not feed session history
// to the model in Pi 0.84.x, so the continuation prompt must carry a digest.
// Дословный original user prompt НЕ воспроизводится: только обрезанный текст
// последних сообщений и имена/статусы инструментов.
export async function sessionContextFrom(sessionPath, { maxEntries = 8, maxText = 500 } = {}) {
  if (sessionPath && typeof sessionPath === "object") {
    ({ sessionPath, maxEntries = 8, maxText = 500 } = sessionPath);
  }
  if (!sessionPath) return [];
  let lines = [];
  try {
    const raw = await readFile(sessionPath, "utf8");
    const rows = raw.split(/\r?\n/).filter(Boolean).slice(-maxEntries * 3);
    for (const row of rows.slice(-maxEntries)) {
      let entry;
      try { entry = JSON.parse(row); } catch { continue; }
      const type = entry.type;
      let label = type;
      let text = "";
      if (type === "message") {
        const msg = entry.message || {};
        label = msg.role === "user" ? "user" : msg.role === "assistant" ? "assistant" : "message";
        const content = msg.content;
        if (Array.isArray(content)) text = content.map(p => (typeof p === "string" ? p : p?.text || "")).join(" ");
        else if (typeof content === "string") text = content;
      } else if (type === "tool_call") {
        text = `tool ${entry.tool || entry.name || "?"}`;
      } else if (type === "tool_result") {
        text = `result of ${entry.tool || entry.name || "tool"}: ${entry.isError ? "error" : "ok"}`;
      } else if (type === "thinking_level_change") {
        text = `thinking ${entry.thinkingLevel || ""}`;
      } else if (type === "model_change") {
        text = `model ${entry.provider ? entry.provider + "/" : ""}${entry.modelId || ""}`;
      } else if (type === "compaction") {
        text = "context compacted";
      }
      text = String(text).replace(/\s+/g, " ").trim();
      if (text) {
        const clipped = text.length > maxText ? text.slice(0, maxText) + "…" : text;
        lines.push(`${label}: ${clipped}`);
      }
    }
  } catch {
    return [];
  }
  return redact(lines.join("\n"))
    .split("\n")
    .filter(Boolean)
    .slice(-maxEntries);
}

// --------------------------------------------------------------- planning --

// Решает, разрешён ли continuation для данного recovery event.
// Ключевые случаи:
//   - нет sessionId / статус NORMAL -> NONE
//   - предыдущий STARTED/FAILED с тем же event fingerprint -> retry того же
//     generation (attempt++), или BLOCKED при превышении лимита
//   - предыдущий COMPLETED -> новый event (generation+1, attempt 1)
//   - BLOCKED в окне -> BLOCKED
//   - STARTED c живым childPid -> WAIT (continuation ещё выполняется)
export async function planContinuation({ sessionId, sessionFile = null, kind = null, fingerprint = null }) {
  if (!sessionId) return { decision: "NONE", reason: "no session id" };
  return withLock(async () => {
    const prev = await loadState();
    const nowMs = Date.now();
    const inWindow = (ts) => nowMs - Date.parse(ts) <= WINDOW_MS;

    if (prev && prev.sessionId === sessionId && prev.blockedAt && inWindow(prev.blockedAt)) {
      return { decision: "BLOCKED", reason: "continuation blocked earlier for this session", state: prev, generation: prev.generation, attempt: prev.attempt };
    }

    if (prev && prev.sessionId === sessionId && prev.status === "STARTED" && prev.childPid && pidAlive(prev.childPid)) {
      return { decision: "WAIT", reason: "a continuation run is still alive", state: prev, generation: prev.generation, attempt: prev.attempt };
    }

    const sameEvent = prev && prev.sessionId === sessionId && prev.status !== "COMPLETED" &&
      (prev.eventFingerprint && fingerprint && prev.eventFingerprint === fingerprint);

    // Exactly-once: повторное планирование того же события, пока continuation
    // ещё только запланирован (PENDING), не порождает новую попытку.
    if (sameEvent && prev.status === "PENDING") {
      return { decision: "ALLOW", reason: "already pending for this event", state: prev, generation: prev.generation, attempt: prev.attempt };
    }

    if (prev && prev.sessionId === sessionId && prev.status === "COMPLETED" && !sameEvent) {
      // новый recovery event
      const generation = (prev.generation || 0) + 1;
      const attempt = 1;
      const state = { version: 1, sessionId, sessionFile, generation, attempt, status: "PENDING", eventKind: kind || null, eventFingerprint: fingerprint || prev.eventFingerprint || null, createdAt: now(), updatedAt: now() };
      await atomicWrite(STATE_FILE, state);
      await logEvent({ ts: now(), event: "plan", sessionId, generation, attempt, decision: "ALLOW", kind: kind || null });
      return { decision: "ALLOW", reason: "new recovery event", state, generation, attempt };
    }

    if (sameEvent) {
      const attempt = prev.attempt + 1;
      if (attempt > MAX_ATTEMPTS) {
        const state = { ...prev, status: "BLOCKED", blockedAt: now(), updatedAt: now() };
        await atomicWrite(STATE_FILE, state);
        await logEvent({ ts: now(), event: "plan", sessionId, generation: prev.generation, attempt, decision: "BLOCKED", kind: kind || null, reason: "max attempts" });
        return { decision: "BLOCKED", reason: "max continuation attempts reached", state, generation: prev.generation, attempt };
      }
      const state = { ...prev, attempt, status: "PENDING", updatedAt: now(), sessionFile: sessionFile || prev.sessionFile };
      await atomicWrite(STATE_FILE, state);
      await logEvent({ ts: now(), event: "plan", sessionId, generation: prev.generation, attempt, decision: "ALLOW", kind: kind || null, reason: "retry same event" });
      return { decision: "ALLOW", reason: "retry same recovery event", state, generation: prev.generation, attempt };
    }

    // первый continuation или новый event после FAILED без fingerprint match
    const generation = prev && prev.sessionId === sessionId ? (prev.generation || 0) + 1 : 1;
    const attempt = 1;
    const state = { version: 1, sessionId, sessionFile, generation, attempt, status: "PENDING", eventKind: kind || null, eventFingerprint: fingerprint || null, createdAt: now(), updatedAt: now() };
    await atomicWrite(STATE_FILE, state);
    await logEvent({ ts: now(), event: "plan", sessionId, generation, attempt, decision: "ALLOW", kind: kind || null, reason: "first continuation" });
    return { decision: "ALLOW", reason: "first continuation", state, generation, attempt };
  });
}

export async function beginContinuation({ generation, sessionId, childPid = null, summary = {} }) {
  return withLock(async () => {
    const prev = await loadState();
    if (!prev || prev.sessionId !== sessionId || prev.generation !== generation) {
      throw new Error(`recovery-continuation: cannot begin unknown generation ${generation} for ${sessionId}`);
    }
    const state = { ...prev, status: "STARTED", startedAt: now(), childPid: childPid == null ? prev.childPid : childPid, lastSummary: summary, updatedAt: now() };
    await atomicWrite(STATE_FILE, state);
    await logEvent({ ts: now(), event: "begin", sessionId, generation, attempt: state.attempt, childPid });
    return state;
  });
}

export async function completeContinuation({ generation, sessionId, exitCode = 0, signal = null }) {
  return withLock(async () => {
    const prev = await loadState();
    if (!prev || prev.sessionId !== sessionId || prev.generation !== generation) {
      throw new Error(`recovery-continuation: cannot complete unknown generation ${generation} for ${sessionId}`);
    }
    const state = { ...prev, status: "COMPLETED", completedAt: now(), exitCode, signal, childPid: null, updatedAt: now() };
    await atomicWrite(STATE_FILE, state);
    await logEvent({ ts: now(), event: "complete", sessionId, generation, attempt: prev.attempt, exitCode, signal });
    return state;
  });
}

// Отмечает неудачную попытку continuation. Возвращает следующий decision:
//   - BLOCKED, если попыток >= MAX (или предыдущий статус BLOCKED)
//   - ALLOW в остальных случаях (retryContinuation подготовит следующую попытку)
export async function failContinuation({ generation, sessionId, exitCode = null, signal = null, kind = null }) {
  return withLock(async () => {
    const prev = await loadState();
    if (!prev || prev.sessionId !== sessionId || prev.generation !== generation) {
      return { decision: "NONE", reason: "unknown generation" };
    }
    const attempt = prev.attempt;
    const blocked = attempt >= MAX_ATTEMPTS;
    const state = {
      ...prev,
      status: blocked ? "BLOCKED" : "FAILED",
      blockedAt: blocked ? now() : prev.blockedAt,
      failedAt: now(), exitCode, signal, failKind: kind || prev.eventKind, childPid: null, updatedAt: now(),
    };
    await atomicWrite(STATE_FILE, state);
    await logEvent({ ts: now(), event: "fail", sessionId, generation, attempt, exitCode, signal, kind, blocked });
    return { decision: blocked ? "BLOCKED" : "ALLOW", reason: blocked ? "max attempts" : "retry", state, generation, attempt };
  });
}

// Подготавливает следующую попытку той же generation после failContinuation.
// В отличие от planContinuation, здесь не нужен event fingerprint: вызывающий
// уже владеет точной парой sessionId+generation. Это не даёт pi-safe повторять
// одну и ту же attempt бесконечно, когда resurrection не имел fingerprint.
export async function retryContinuation({ generation, sessionId }) {
  return withLock(async () => {
    const prev = await loadState();
    if (!prev || prev.sessionId !== sessionId || prev.generation !== generation) {
      return { decision: "NONE", reason: "unknown generation" };
    }
    if (prev.status === "BLOCKED" || prev.attempt >= MAX_ATTEMPTS) {
      const state = prev.status === "BLOCKED" ? prev : { ...prev, status: "BLOCKED", blockedAt: now(), updatedAt: now(), childPid: null };
      if (state !== prev) await atomicWrite(STATE_FILE, state);
      return { decision: "BLOCKED", reason: "max attempts", state, generation, attempt: prev.attempt };
    }
    if (prev.status !== "FAILED") {
      return { decision: "NONE", reason: `continuation is ${prev.status}, not FAILED`, state: prev, generation, attempt: prev.attempt };
    }
    const attempt = prev.attempt + 1;
    const state = { ...prev, attempt, status: "PENDING", childPid: null, updatedAt: now() };
    await atomicWrite(STATE_FILE, state);
    await logEvent({ ts: now(), event: "retry", sessionId, generation, attempt, decision: "ALLOW" });
    return { decision: "ALLOW", reason: "retry", state, generation, attempt };
  });
}

export async function continuationStatus() {
  const state = await loadState();
  return state;
}

// ---------------------------------------------------------------- doctor --

export async function doctor() {
  const checks = [];
  const check = async (name, fn) => {
    try { const r = await fn(); checks.push({ name, status: r ? "PASS" : "FAIL", detail: typeof r === "string" ? r : "" }); }
    catch (e) { checks.push({ name, status: "FAIL", detail: e.message }); }
  };
  await check("continuation module", async () => "loaded");
  await check("runtime directory", async () => { await ensureRuntime(); return RUNTIME; });
  await check("state file writable", async () => {
    const t = join(RUNTIME, `.cont-doctor-${process.pid}`);
    await writeFile(t, "ok", { mode: 0o600 });
    const st = await stat(t);
    await unlink(t);
    return (st.mode & 0o777) === 0o600;
  });
  await check("state file mode", async () => {
    if (!existsSync(STATE_FILE)) return "absent (fresh)";
    const st = await stat(STATE_FILE);
    return (st.mode & 0o777) === 0o600;
  });
  const st = await loadState();
  check("continuation state", () => ({ PASS: "ok", FAIL: "missing" }[st ? "PASS" : "FAIL"]));
  return { tool: "recovery-continuation", version: 1, checks, state: st ? { sessionId: st.sessionId, generation: st.generation, attempt: st.attempt, status: st.status } : null };
}

// ---------------------------------------------------------------- cleanup --

export async function cleanupRuntime(olderThanMs = 30 * 24 * 3600 * 1000) {
  // Удаляем старые тестовые файлы в RUNTIME, если они есть (не трогаем state).
  try {
    const cutoff = Date.now() - olderThanMs;
    for (const name of await readdir(RUNTIME)) {
      if (!/^recovery-continuation.*\.(tmp|lock|old)/.test(name)) continue;
      const p = join(RUNTIME, name);
      const s = await stat(p);
      if (s.mtimeMs < cutoff) await unlink(p).catch(() => {});
    }
  } catch {}
}