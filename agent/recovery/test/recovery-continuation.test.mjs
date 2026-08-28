// Decision/state tests for the shared recovery-continuation primitive.
// Uses an isolated runtime (PI_RECOVERY_RUNTIME) so live supervisor state is
// never touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const MODULE = new URL("../recovery-continuation.mjs", import.meta.url).pathname;
const NODE = process.execPath;

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "recovery-cont-test-"));
  const runtime = join(root, "runtime");
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  return { root, runtime };
}

// Каждая операция — отдельный процесс, чтобы не было гонок по состоянию модуля.
async function op(runtime, fnName, args = {}, env = {}) {
  const script = `
    import { ${fnName} } from ${JSON.stringify(MODULE)};
    try {
      const out = await ${fnName}(${JSON.stringify(args)});
      console.log(JSON.stringify(out));
    } catch (e) {
      console.error("OP_ERROR:" + e.message);
      process.exit(3);
    }
  `;
  const res = await new Promise((resolve) => {
    const child = spawn(NODE, ["--input-type=module", "-e", script], {
      env: { ...process.env, PI_RECOVERY_RUNTIME: runtime, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out: out.trim(), err }));
  });
  if (res.code !== 0 && !res.err.includes("OP_ERROR")) throw new Error(`op failed: ${res.err}`);
  if (res.err.includes("OP_ERROR")) {
    const e = new Error(`op ${fnName} threw: ${res.err}`);
    e.isOpError = true;
    throw e;
  }
  return JSON.parse(res.out);
}

const SID = "01a00000-0000-7000-8000-0000000000ab";
const FP = "abcd1234ef567890";

test("plan with no session id returns NONE", async () => {
  const f = await setup();
  try {
    const r = await op(f.runtime, "planContinuation", { sessionId: null, kind: "SIGKILL" });
    assert.equal(r.decision, "NONE");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("first abnormal event -> ALLOW, generation 1, attempt 1, PENDING", async () => {
  const f = await setup();
  try {
    const r = await op(f.runtime, "planContinuation", { sessionId: SID, sessionFile: "/s/s.jsonl", kind: "SIGKILL", fingerprint: FP });
    assert.equal(r.decision, "ALLOW");
    assert.equal(r.generation, 1);
    assert.equal(r.attempt, 1);
    assert.equal(r.state.status, "PENDING");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("same event after failed attempt -> retry same generation, attempt++", async () => {
  const f = await setup();
  try {
    const p1 = await op(f.runtime, "planContinuation", { sessionId: SID, kind: "SIGKILL", fingerprint: FP });
    await op(f.runtime, "failContinuation", { generation: p1.generation, sessionId: SID, exitCode: 137, signal: "SIGKILL", kind: "SIGKILL" });
    const p2 = await op(f.runtime, "planContinuation", { sessionId: SID, kind: "SIGKILL", fingerprint: FP });
    assert.equal(p2.decision, "ALLOW");
    assert.equal(p2.generation, 1);
    assert.equal(p2.attempt, 2);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("retryContinuation increments attempt without an event fingerprint", async () => {
  const f = await setup();
  try {
    const p1 = await op(f.runtime, "planContinuation", { sessionId: SID, kind: "ANDROID/TERMUX PROCESS LOSS", fingerprint: null });
    const failed = await op(f.runtime, "failContinuation", { generation: p1.generation, sessionId: SID, exitCode: 1, kind: "PI CRASH" });
    assert.equal(failed.decision, "ALLOW");
    const retry = await op(f.runtime, "retryContinuation", { generation: p1.generation, sessionId: SID });
    assert.equal(retry.decision, "ALLOW");
    assert.equal(retry.generation, 1);
    assert.equal(retry.attempt, 2);
    const state = await op(f.runtime, "loadState");
    assert.equal(state.status, "PENDING");
    assert.equal(state.attempt, 2);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("retryContinuation blocks after the configured maximum", async () => {
  const f = await setup();
  try {
    const p = await op(f.runtime, "planContinuation", { sessionId: SID, kind: "ANDROID/TERMUX PROCESS LOSS", fingerprint: null });
    for (let expected = 1; expected <= 3; expected++) {
      const failed = await op(f.runtime, "failContinuation", { generation: p.generation, sessionId: SID, exitCode: 1, kind: "PI CRASH" });
      if (expected === 3) {
        assert.equal(failed.decision, "BLOCKED");
        break;
      }
      const retry = await op(f.runtime, "retryContinuation", { generation: p.generation, sessionId: SID });
      assert.equal(retry.decision, "ALLOW");
      assert.equal(retry.attempt, expected + 1);
    }
    const blocked = await op(f.runtime, "retryContinuation", { generation: p.generation, sessionId: SID });
    assert.equal(blocked.decision, "BLOCKED");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("max attempts -> BLOCKED and stays blocked", async () => {
  const f = await setup();
  try {
    for (let i = 1; i <= 3; i++) {
      const plan = await op(f.runtime, "planContinuation", { sessionId: SID, kind: "SIGKILL", fingerprint: FP });
      assert.equal(plan.generation, 1);
      assert.equal(plan.decision, "ALLOW");
      assert.equal(plan.attempt, i);
      await op(f.runtime, "failContinuation", { generation: plan.generation, sessionId: SID, exitCode: 137, signal: "SIGKILL", kind: "SIGKILL" });
    }
    // после 3-й упавшей попытки continuation отмечен BLOCKED
    const blocked = await op(f.runtime, "planContinuation", { sessionId: SID, kind: "SIGKILL", fingerprint: FP });
    assert.equal(blocked.decision, "BLOCKED");
    const again = await op(f.runtime, "planContinuation", { sessionId: SID, kind: "SIGKILL", fingerprint: FP });
    assert.equal(again.decision, "BLOCKED");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("completed continuation -> next event gets generation+1, attempt 1", async () => {
  const f = await setup();
  try {
    const p1 = await op(f.runtime, "planContinuation", { sessionId: SID, kind: "SIGKILL", fingerprint: FP });
    await op(f.runtime, "beginContinuation", { generation: p1.generation, sessionId: SID, childPid: 999999 });
    await op(f.runtime, "completeContinuation", { generation: p1.generation, sessionId: SID });
    const p2 = await op(f.runtime, "planContinuation", { sessionId: SID, kind: "EPIPE", fingerprint: "ffff" });
    assert.equal(p2.decision, "ALLOW");
    assert.equal(p2.generation, 2);
    assert.equal(p2.attempt, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("STARTED with live childPid -> WAIT (no duplicate continuation)", async () => {
  const f = await setup();
  try {
    // живой процесс-декой (sleep)
    const decoy = spawn("/data/data/com.termux/files/usr/bin/sleep", ["30"], { stdio: "ignore" });
    try {
      const p1 = await op(f.runtime, "planContinuation", { sessionId: SID, kind: "SIGKILL", fingerprint: FP });
      await op(f.runtime, "beginContinuation", { generation: p1.generation, sessionId: SID, childPid: decoy.pid });
      const p2 = await op(f.runtime, "planContinuation", { sessionId: SID, kind: "SIGKILL", fingerprint: FP });
      assert.equal(p2.decision, "WAIT");
    } finally { decoy.kill("SIGKILL"); }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("begin without prior plan throws", async () => {
  const f = await setup();
  try {
    await assert.rejects(() => op(f.runtime, "beginContinuation", { generation: 7, sessionId: SID }));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("recovery prompt stays structural, no user prompt, no secrets", async () => {
  const f = await setup();
  try {
    const prompt = await op(f.runtime, "buildRecoveryPrompt", {
      sessionId: SID, generation: 2, attempt: 1,
      summary: { journalStart: 0, journalComplete: 3, journalUnknown: 1, todoIncomplete: true, lastRuntimeEvent: "pi_exit_SIGKILL" },
    });
    assert.ok(prompt.includes("automatic recovery continuation"));
    assert.ok(prompt.includes("generation: 2"));
    assert.ok(prompt.includes(SID));
    assert.ok(!prompt.includes("sk-GXy"));
    assert.ok(!prompt.includes("Bearer"));
    assert.ok(!prompt.includes("original user prompt"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("recovery prompt embeds condensed session context (no secrets, truncated)", async () => {
  const f = await setup();
  try {
    const sess = join(f.root, "sess.jsonl");
    await writeFile(sess, [
      JSON.stringify({ type: "session", version: 3, id: SID, timestamp: new Date().toISOString(), cwd: "/tmp" }),
      JSON.stringify({ type: "message", id: "a", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "Напиши итог в DONE.txt и не показывай ключ sk-EXAMPLE0000000000000000000000000000000000000000 нигде" }] } }),
      JSON.stringify({ type: "tool_call", id: "b", parentId: "a", timestamp: new Date().toISOString(), tool: "write", arguments: { path: "/tmp/DONE.txt" } }),
      JSON.stringify({ type: "tool_result", id: "c", parentId: "b", timestamp: new Date().toISOString(), tool: "write", isError: false }),
    ].join("\n"));
    const ctx = await op(f.runtime, "sessionContextFrom", { sessionPath: sess, maxEntries: 5, maxText: 300 });
    assert.ok(Array.isArray(ctx) && ctx.length >= 2, "context lines present");
    const prompt = await op(f.runtime, "buildRecoveryPrompt", {
      sessionId: SID, generation: 1, attempt: 1, summary: {}, sessionContext: ctx,
    });
    assert.ok(prompt.includes("Recovered task context"), "context section present");
    assert.ok(prompt.includes("DONE.txt"), "task hints present");
    assert.ok(!prompt.includes("sk-GXy"), "api key redacted from context");
    assert.ok(!prompt.includes("H8tekP2jjQ5vq"), "no secret fragments");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("state file is private (600) and runtime dir private (700)", async () => {
  const f = await setup();
  try {
    const p = await op(f.runtime, "planContinuation", { sessionId: SID, kind: "SIGKILL", fingerprint: FP });
    await op(f.runtime, "beginContinuation", { generation: p.generation, sessionId: SID, childPid: 12345 });
    const st = await stat(join(f.runtime, "recovery-continuation.json"));
    assert.equal(st.mode & 0o777, 0o600);
    const dr = await stat(f.runtime);
    assert.equal(dr.mode & 0o777, 0o700);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("state never contains prompt text or secrets", async () => {
  const f = await setup();
  try {
    const p = await op(f.runtime, "planContinuation", { sessionId: SID, kind: "SIGKILL", fingerprint: FP });
    await op(f.runtime, "beginContinuation", { generation: p.generation, sessionId: SID, childPid: 12345 });
    const raw = await readFile(join(f.runtime, "recovery-continuation.json"), "utf8");
    assert.ok(!raw.includes("automatic recovery continuation"));
    assert.ok(!raw.includes("sk-GXy"));
    assert.ok(!raw.includes("Bearer"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("event log has no secrets and records decision trail", async () => {
  const f = await setup();
  try {
    const p = await op(f.runtime, "planContinuation", { sessionId: SID, kind: "SIGKILL", fingerprint: FP });
    await op(f.runtime, "beginContinuation", { generation: p.generation, sessionId: SID, childPid: 12345 });
    await op(f.runtime, "completeContinuation", { generation: p.generation, sessionId: SID });
    const raw = await readFile(join(f.runtime, "recovery-continuation-events.jsonl"), "utf8");
    assert.match(raw, /"event":"plan"/);
    assert.match(raw, /"event":"begin"/);
    assert.match(raw, /"event":"complete"/);
    assert.ok(!raw.includes("sk-GXy"));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("concurrent planners (same process) do not duplicate a logical continuation", async () => {
  const f = await setup();
  try {
    // Динамический import: первый и единственный в этом процессе => env действует.
    process.env.PI_RECOVERY_RUNTIME = f.runtime;
    const mod = await import(
      `${MODULE}?t=${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    const [a, b] = await Promise.allSettled([
      mod.planContinuation({ sessionId: SID, kind: "SIGKILL", fingerprint: FP }),
      mod.planContinuation({ sessionId: SID, kind: "SIGKILL", fingerprint: FP }),
    ]);
    assert.ok([a, b].every((x) => x.status === "fulfilled"), JSON.stringify([a.statusText, b.statusText]));
    const gens = [a.value, b.value].map((x) => x.generation);
    const atts = [a.value, b.value].map((x) => x.attempt);
    assert.deepEqual(new Set(gens), new Set([1]));
    assert.deepEqual(new Set(atts), new Set([1]));
    const st = await mod.continuationStatus();
    assert.equal(st.generation, 1);
    assert.equal(st.attempt, 1);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("status returns current state", async () => {
  const f = await setup();
  try {
    const s = await op(f.runtime, "continuationStatus", {});
    assert.equal(s, null);
    await op(f.runtime, "planContinuation", { sessionId: SID, kind: "SIGKILL", fingerprint: FP });
    const s2 = await op(f.runtime, "continuationStatus", {});
    assert.equal(s2.sessionId, SID);
    assert.equal(s2.status, "PENDING");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("doctor reports checks", async () => {
  const f = await setup();
  try {
    const d = await op(f.runtime, "doctor", {});
    assert.equal(d.tool, "recovery-continuation");
    assert.ok(d.checks.every((c) => c.status === "PASS"), JSON.stringify(d.checks));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("normal exit kind is never planned by callers; NONE for missing session", async () => {
  const f = await setup();
  try {
    const r = await op(f.runtime, "planContinuation", { sessionId: null, sessionFile: null, kind: "NORMAL EXIT" });
    assert.equal(r.decision, "NONE");
  } finally { await rm(f.root, { recursive: true, force: true }); }
});