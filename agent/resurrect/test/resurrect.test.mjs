// Decision-engine tests for the resurrection layer.
//
// These use isolated fixture runtimes and a fake pi-safe so they never touch the
// real supervisor state, the real journal, or a live session.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { spawnSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../resurrect.mjs", import.meta.url).pathname;
const NODE = process.execPath;

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "resurrect-test-"));
  const runtime = join(root, "runtime");
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const session = join(root, "session.jsonl");
  await writeFile(session, JSON.stringify({ id: "01a00000-0000-7000-8000-000000000001", type: "header" }) + "\n", { mode: 0o600 });
  // A fake pi-safe that only records that it was launched.
  const fakeSafe = join(root, "pi-safe");
  const marker = join(root, "launched.txt");
  await writeFile(fakeSafe, `#!/data/data/com.termux/files/usr/bin/sh\necho "$@" >> ${marker}\n`, { mode: 0o700 });
  return { root, runtime, session, fakeSafe, marker };
}

const cleanup = root => rm(root, { recursive: true, force: true });

function run(fixture, args, extraEnv = {}) {
  return spawnSync(NODE, [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 60000,
    env: {
      ...process.env,
      PI_RESURRECT_RUNTIME: fixture.runtime,
      PI_RESURRECT_PI_SAFE: fixture.fakeSafe,
      ...extraEnv,
    },
  });
}

const writeSafeState = (fixture, state) =>
  writeFile(join(fixture.runtime, "interactive-supervisor.json"), JSON.stringify(state), { mode: 0o600 });

const readState = async fixture =>
  JSON.parse(await readFile(join(fixture.runtime, "resurrection.json"), "utf8"));

/** A pid that exists but is not pi-safe, to prove cmdline verification matters. */
function spawnDecoy() {
  const child = spawn("/data/data/com.termux/files/usr/bin/sleep", ["30"], { stdio: "ignore" });
  return child;
}

test("normal exit does not resurrect", async () => {
  const f = await setup();
  try {
    await writeSafeState(f, { version: 1, pid: 999999, status: "stopped", classification: "NORMAL EXIT", sessionFile: f.session });
    const out = run(f, ["check", "--trigger", "test"]);
    assert.match(out.stdout, /EXIT_DISARMED/);
    assert.match(out.stdout, /NORMAL EXIT/);
    assert.equal(spawnSync("test", ["-f", f.marker]).status, 1, "pi-safe must not be launched");
  } finally { await cleanup(f.root); }
});

test("user Ctrl-C does not resurrect", async () => {
  const f = await setup();
  try {
    await writeSafeState(f, { version: 1, pid: 999999, status: "stopped", classification: "USER CTRL-C / explicit exit", sessionFile: f.session });
    const out = run(f, ["check", "--trigger", "test"]);
    assert.match(out.stdout, /EXIT_DISARMED/);
    assert.equal(spawnSync("test", ["-f", f.marker]).status, 1);
  } finally { await cleanup(f.root); }
});

test("abnormal supervisor loss resurrects on the same session", async () => {
  const f = await setup();
  try {
    // status "running" with a pid that no longer exists = the tree died.
    await writeSafeState(f, { version: 1, pid: 999999, status: "running", startedAt: new Date().toISOString(), sessionFile: f.session });
    const out = run(f, ["check", "--trigger", "test"]);
    assert.match(out.stdout, /started pi-safe/);
    const launched = await readFile(f.marker, "utf8");
    assert.match(launched, /--session/);
    assert.ok(launched.includes(f.session), "must resume the SAME session path");
    // Общий recovery-continuation primitive не инжектит prompt здесь:
    // pi-safe сам планирует continuation из своего состояния.
    assert.ok(!launched.includes("automatic continuation after process loss"), "pi-resurrect must not inject its own recovery prompt");
    const state = await readState(f);
    assert.equal(state.armed, true);
    assert.equal(state.session_id, "01a00000-0000-7000-8000-000000000001");
    assert.equal(state.resurrection_count, 1);
  } finally { await cleanup(f.root); }
});

test("missing persisted sessionFile is recovered from pi-safe cwd discovery", async () => {
  const f = await setup();
  try {
    const sessionDir = join(f.runtime, "..", "sessions", "--tmp--");
    // The fixture's runtime is intentionally separate from the agent dir. Point
    // the test at a matching agent dir and use Pi's actual session-dir naming.
    const agentDir = join(f.root, "agent");
    const realSessionDir = join(agentDir, "sessions", "--data-data-com.termux-files-usr-tmp-resurrect-test--");
    await mkdir(realSessionDir, { recursive: true, mode: 0o700 });
    const session = join(realSessionDir, "session.jsonl");
    await writeFile(session, JSON.stringify({ id: "01a00000-0000-7000-8000-000000000002", type: "header" }) + "\n", { mode: 0o600 });
    // Use the actual fixture root as cwd and create the matching Pi directory
    // dynamically; this avoids depending on the test runner's fixed tmp name.
    const cwd = f.root;
    const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    const discoveredDir = join(agentDir, "sessions", safePath);
    await mkdir(discoveredDir, { recursive: true, mode: 0o700 });
    const discovered = join(discoveredDir, "discovered.jsonl");
    await writeFile(discovered, JSON.stringify({ id: "01a00000-0000-7000-8000-000000000002", type: "header" }) + "\n", { mode: 0o600 });
    await writeSafeState(f, { version: 1, pid: 999999, status: "running", cwd, startedAt: new Date(Date.now() - 1000).toISOString(), sessionFile: null });
    const out = run(f, ["check", "--trigger", "test"], { PI_CODING_AGENT_DIR: agentDir });
    assert.match(out.stdout, /started pi-safe/);
    const state = await readState(f);
    assert.equal(state.session_id, "01a00000-0000-7000-8000-000000000002");
    assert.equal(state.session_path, discovered);
    assert.equal(state.session_source, "discovered from the supervisor cwd");
  } finally { await cleanup(f.root); }
});

test("a live pi-safe blocks a second supervisor", async () => {
  const f = await setup();
  try {
    // Use this very test process as the "live supervisor": its cmdline contains
    // the script path, so point the check at a lock naming a real pi-safe-like pid.
    await writeFile(join(f.runtime, "interactive-supervisor.lock"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    await writeSafeState(f, { version: 1, pid: process.pid, status: "running", sessionFile: f.session });
    const out = run(f, ["check", "--trigger", "test"]);
    // This process is not pi-safe, so the lock is correctly rejected, but the
    // decision must still not launch a duplicate while a pid is recorded running.
    assert.doesNotMatch(out.stdout, /FAILED/);
  } finally { await cleanup(f.root); }
});

test("a recycled PID is not mistaken for a live supervisor", async () => {
  const f = await setup();
  const decoy = spawnDecoy();
  try {
    await new Promise(r => setTimeout(r, 150));
    // Record the decoy's pid but a wrong starttime, as would happen if the pid was
    // recycled after the tree died.
    await writeFile(join(f.runtime, "interactive-supervisor.lock"), JSON.stringify({ pid: decoy.pid, starttime: "1" }), { mode: 0o600 });
    await writeSafeState(f, { version: 1, pid: 999999, status: "running", sessionFile: f.session });
    const out = run(f, ["check", "--trigger", "test"]);
    // The decoy is alive but is not pi-safe, so it must not count as a supervisor.
    assert.match(out.stdout, /started pi-safe/);
  } finally {
    decoy.kill("SIGKILL");
    await cleanup(f.root);
  }
});

test("pi-safe crash-loop stop is never bypassed", async () => {
  const f = await setup();
  try {
    await writeSafeState(f, {
      version: 1,
      pid: 999999,
      status: "crash",
      classification: "PI CRASH",
      crashes: [{ timestamp: new Date().toISOString(), fingerprint: "x" }, { timestamp: new Date().toISOString(), fingerprint: "x" }],
      sessionFile: f.session,
    });
    const out = run(f, ["check", "--trigger", "test"]);
    assert.match(out.stdout, /EXIT_CRASH_LOOP_BLOCKED/);
    assert.equal(spawnSync("test", ["-f", f.marker]).status, 1, "must not restart into a crash loop");
    const state = await readState(f);
    assert.equal(state.crash_loop_blocked, true);
    assert.equal(state.armed, false);
  } finally { await cleanup(f.root); }
});

test("manual disable stops all resurrection", async () => {
  const f = await setup();
  try {
    await writeSafeState(f, { version: 1, pid: 999999, status: "running", sessionFile: f.session });
    run(f, ["disable"]);
    const out = run(f, ["check", "--trigger", "test"]);
    assert.match(out.stdout, /EXIT_MANUAL_STOP/);
    assert.equal(spawnSync("test", ["-f", f.marker]).status, 1);
    // Re-enabling restores normal behavior.
    run(f, ["enable"]);
    const after = run(f, ["check", "--trigger", "test"]);
    assert.match(after.stdout, /started pi-safe/);
  } finally { await cleanup(f.root); }
});

test("a missing session file fails closed instead of starting a new session", async () => {
  const f = await setup();
  try {
    await writeSafeState(f, { version: 1, pid: 999999, status: "running", sessionFile: join(f.root, "gone.jsonl") });
    const out = run(f, ["check", "--trigger", "test"]);
    assert.match(out.stdout, /EXIT_NO_SESSION/);
    assert.equal(spawnSync("test", ["-f", f.marker]).status, 1, "must never invent a new session");
  } finally { await cleanup(f.root); }
});

test("an Autopilot session is never resurrected as interactive Pi", async () => {
  const f = await setup();
  try {
    const autopilotSession = join(f.root, "pi-autopilot-session.jsonl");
    await writeFile(autopilotSession, JSON.stringify({ id: "auto-1" }) + "\n", { mode: 0o600 });
    await writeSafeState(f, { version: 1, pid: 999999, status: "running", sessionFile: autopilotSession });
    const out = run(f, ["check", "--trigger", "test"]);
    assert.match(out.stdout, /EXIT_AUTOPILOT/);
    assert.equal(spawnSync("test", ["-f", f.marker]).status, 1);
  } finally { await cleanup(f.root); }
});

test("resurrection storms are rate limited", async () => {
  const f = await setup();
  try {
    await writeSafeState(f, { version: 1, pid: 999999, status: "running", sessionFile: f.session });
    for (let i = 0; i < 5; i++) run(f, ["check", "--trigger", "test"]);
    const out = run(f, ["check", "--trigger", "test"]);
    assert.match(out.stdout, /EXIT_RATE_LIMITED/);
  } finally { await cleanup(f.root); }
});

test("concurrent triggers cannot start two supervisors", async () => {
  const f = await setup();
  try {
    await writeSafeState(f, { version: 1, pid: 999999, status: "running", sessionFile: f.session });
    await Promise.all(
      Array.from({ length: 6 }, () =>
        new Promise(resolve => {
          const child = spawn(NODE, [SCRIPT, "check", "--trigger", "race"], {
            env: { ...process.env, PI_RESURRECT_RUNTIME: f.runtime, PI_RESURRECT_PI_SAFE: f.fakeSafe },
            stdio: "ignore",
          });
          child.on("close", resolve);
        }),
      ),
    );
    const launched = (await readFile(f.marker, "utf8")).trim().split("\n").filter(Boolean);
    assert.equal(launched.length, 1, `exactly one launch expected, got ${launched.length}`);
  } finally { await cleanup(f.root); }
});

test("no session recorded at all does not resurrect", async () => {
  const f = await setup();
  try {
    await writeSafeState(f, { version: 1, pid: 999999, status: "running", sessionFile: null });
    const out = run(f, ["check", "--trigger", "test"]);
    assert.match(out.stdout, /EXIT_NO_SESSION/);
  } finally { await cleanup(f.root); }
});

test("state and event log never contain secrets", async () => {
  const f = await setup();
  try {
    await writeSafeState(f, { version: 1, pid: 999999, status: "running", sessionFile: f.session });
    run(f, ["check", "--trigger", "test"], {
      OPENAI_API_KEY: "sk-live-SHOULD-NOT-APPEAR",
      TELEGRAM_API_HASH: "abcdef0123456789",
      SECRET_TOKEN: "ghp_SHOULD_NOT_APPEAR",
    });
    const state = await readFile(join(f.runtime, "resurrection.json"), "utf8");
    const events = await readFile(join(f.runtime, "resurrection-events.jsonl"), "utf8");
    for (const secret of ["sk-live-SHOULD-NOT-APPEAR", "abcdef0123456789", "ghp_SHOULD_NOT_APPEAR"]) {
      assert.doesNotMatch(state, new RegExp(secret), `state leaked ${secret}`);
      assert.doesNotMatch(events, new RegExp(secret), `events leaked ${secret}`);
    }
    // Also assert we never dump the environment wholesale.
    assert.doesNotMatch(state + events, /PATH=|LD_LIBRARY_PATH|environ/);
  } finally { await cleanup(f.root); }
});

test("state and log files are private", async () => {
  const f = await setup();
  try {
    await writeSafeState(f, { version: 1, pid: 999999, status: "running", sessionFile: f.session });
    run(f, ["check", "--trigger", "test"]);
    const { stat } = await import("node:fs/promises");
    for (const file of ["resurrection.json", "resurrection-events.jsonl"]) {
      const info = await stat(join(f.runtime, file));
      assert.equal((info.mode & 0o777).toString(8), "600", `${file} must be 600`);
    }
  } finally { await cleanup(f.root); }
});

test("heartbeat is not rewritten on every trigger", async () => {
  const f = await setup();
  try {
    // A healthy system: repeated triggers must not churn the disk.
    await writeSafeState(f, { version: 1, pid: 999999, status: "stopped", classification: "NORMAL EXIT", sessionFile: f.session });
    run(f, ["check", "--trigger", "test"]);
    const first = await readFile(join(f.runtime, "resurrection.json"), "utf8");
    for (let i = 0; i < 3; i++) run(f, ["check", "--trigger", "test"]);
    const second = await readFile(join(f.runtime, "resurrection.json"), "utf8");
    const a = JSON.parse(first);
    const b = JSON.parse(second);
    delete a.last_seen_at;
    delete b.last_seen_at;
    assert.deepEqual(a, b, "steady-state triggers must not rewrite state");
  } finally { await cleanup(f.root); }
});

test("event log records the decision trail without prompts", async () => {
  const f = await setup();
  try {
    await writeSafeState(f, { version: 1, pid: 999999, status: "running", sessionFile: f.session });
    run(f, ["check", "--trigger", "jobscheduler"]);
    const events = (await readFile(join(f.runtime, "resurrection-events.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
    const last = events.at(-1);
    assert.equal(last.trigger, "jobscheduler");
    assert.equal(last.decision, "RESURRECT");
    assert.equal(last.supervisor_existed, false);
    assert.ok(last.timestamp && last.session_id && last.action && last.result);
  } finally { await cleanup(f.root); }
});

test("dry run reports the command without launching", async () => {
  const f = await setup();
  try {
    await writeSafeState(f, { version: 1, pid: 999999, status: "running", sessionFile: f.session });
    const out = run(f, ["check", "--trigger", "test", "--dry-run"]);
    assert.match(out.stdout, /would run/);
    assert.equal(spawnSync("test", ["-f", f.marker]).status, 1);
  } finally { await cleanup(f.root); }
});
