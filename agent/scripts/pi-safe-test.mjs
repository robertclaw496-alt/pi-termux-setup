#!/data/data/com.termux/files/usr/bin/node
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const home = process.env.HOME;
// Allow running the suite straight from a checkout, before the files are installed.
const launcher = process.env.PI_SAFE_LAUNCHER || join(home, ".local/bin/pi-safe");
const fake = process.env.PI_SAFE_FAKE || join(home, ".pi/agent/scripts/pi-safe-test-fake.mjs");
const run = (base, mode, session, extra = {}) => new Promise(resolve => {
  const env = { ...process.env, PI_CODING_AGENT_DIR: join(base, "agent"), PI_SAFE_PI: fake, PI_SAFE_TEST_MODE: mode, PI_SAFE_TEST_SESSION: session, PI_SAFE_TEST_MARKER: join(base, "marker"), PI_SAFE_BACKOFF_BASE_MS: "1", PI_SAFE_BACKOFF_MAX_MS: "2", PI_SAFE_MAX_TOTAL: "5", PI_SAFE_MAX_SAME: "3", ...extra };
  const p = spawn(launcher, [], { cwd: base, env, stdio: ["ignore", "pipe", "pipe"] }); let out = "", err = "";
  p.stdout.on("data", x => out += x); p.stderr.on("data", x => err += x); p.on("close", (code, signal) => resolve({ code, signal, out, err }));
});
const base = await mkdtemp(join(tmpdir(), "pi-safe-test-"));
try {
  const makeSession = async (root) => { const agent = join(root, "agent"); const sessionDir = join(agent, "sessions", `--${root.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`); const session = join(sessionDir, "fake.jsonl"); await mkdir(sessionDir, { recursive: true }); return { agent, session }; };
  const { session } = await makeSession(base);
  const normal = await run(base, "normal", session); if (normal.code !== 0) throw Error(`normal exit=${normal.code}; signal=${normal.signal}; stdout=${normal.out}; stderr=${normal.err}`);
  const seq = await run(base, "sequence", session); if (seq.code !== 0 || !/EPIPE/.test(seq.err)) throw Error(`sequence failed: ${seq.code} ${seq.err}`);
  const state = JSON.parse(await readFile(join(base, "agent/runtime/last-exit"), "utf8"));
  if (state.classification !== "NORMAL EXIT") throw Error(`normal classification lost: ${state.classification}`);
  const recovered = JSON.parse(await readFile(join(base, "agent/runtime/interactive-supervisor.json"), "utf8"));
  if (recovered.status !== "stopped" || recovered.sessionFile !== session) throw Error(`normal state mismatch: ${JSON.stringify(recovered)}`);
  const crashes = (await readFile(join(base, "agent/runtime/crashes.jsonl"), "utf8")).trim().split("\n");
  if (crashes.length !== 1 || !crashes[0].includes('"classification":"EPIPE"')) throw Error("EPIPE crash log missing");
  if (/api[_-]?key|authorization|bearer|secret|password|token/i.test(await readFile(join(base, "agent/runtime/crashes.jsonl"), "utf8"))) throw Error("secret-like field in report");
  // A manual launch may preempt only a background resurrection supervisor.
  // This is the user-visible regression: before the fix `pi` returned exit 75.
  const takeoverRoot = await mkdtemp(join(tmpdir(), "pi-safe-takeover-"));
  try {
    const { session: s } = await makeSession(takeoverRoot);
    const env = { ...process.env, PI_CODING_AGENT_DIR: join(takeoverRoot, "agent"), PI_SAFE_PI: fake, PI_SAFE_TEST_MODE: "hang", PI_SAFE_TEST_SESSION: s, PI_RESURRECTED: "1" };
    const background = spawn(launcher, [], { cwd: takeoverRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    const backgroundDone = new Promise(resolve => background.on("close", (code, signal) => resolve({ code, signal })));
    const lockPath = join(takeoverRoot, "agent/runtime/interactive-supervisor.lock");
    for (let i = 0; i < 100; i++) {
      try { await readFile(lockPath); break; } catch { await delay(20); }
    }
    const manual = await run(takeoverRoot, "normal", s);
    if (manual.code !== 0 || !/stopping background recovery/.test(manual.err)) throw Error(`manual takeover failed: ${JSON.stringify(manual)}`);
    const stopped = await Promise.race([backgroundDone, delay(3000).then(() => null)]);
    if (!stopped) { background.kill("SIGKILL"); throw Error("background recovery survived manual takeover"); }
  } finally { await rm(takeoverRoot, { recursive: true, force: true }); }

  for (const [mode, expected] of [["crash", "PI CRASH"], ["sigterm", "SIGTERM"], ["sigkill", "SIGKILL"], ["api-error", "PROVIDER/API ERROR"]]) {
    const root = await mkdtemp(join(tmpdir(), "pi-safe-class-"));
    try {
      const { session: s } = await makeSession(root);
      const result = await run(root, mode, s, { PI_SAFE_MAX_TOTAL: "1", PI_SAFE_MAX_SAME: "1" });
      const exit = JSON.parse(await readFile(join(root, "agent/runtime/last-exit"), "utf8"));
      if (exit.classification !== expected) throw Error(`${mode}: ${exit.classification}`);
      if (result.code === 0) throw Error(`${mode}: unexpectedly normal`);
      if (mode === "api-error") {
        const supervisor = JSON.parse(await readFile(join(root, "agent/runtime/interactive-supervisor.json"), "utf8"));
        if (supervisor.status !== "stopped") throw Error(`api-error kept supervisor active: ${JSON.stringify(supervisor)}`);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  console.log("PI_SAFE_TEST_OK");
} finally { await rm(base, { recursive: true, force: true }); }
