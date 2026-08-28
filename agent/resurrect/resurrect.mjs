#!/usr/bin/env node
/**
 * Android/Termux resurrection layer.
 *
 * Purpose: when Android destroys the whole Termux process tree, pi-safe dies with
 * it. runit cannot help because runsvdir lives inside that same tree. This layer
 * is the outermost level: an Android-owned trigger runs a short check that either
 * exits immediately or starts exactly one pi-safe on the SAME session.
 *
 * Design constraints honored here:
 *  - No busy watchdog. Every entry point is a short-lived check that exits.
 *  - pi-safe is not modified and stays the only session/recovery authority. Its
 *    own state files are the source of truth for ARM/DISARM and crash-loop stop.
 *  - action-safety remains the only thing preventing duplicate mutations.
 *  - Autopilot is a separate state machine and is never resurrected from here.
 *
 * Failure classes (see report): A pi child dies -> pi-safe. B pi-safe dies while
 * Termux lives -> runit level. C whole tree dies -> Android-owned trigger. D
 * reboot -> Termux:Boot. E explicit Force stop -> Android forbids automatic
 * recovery until the user launches the app.
 */

import { mkdir, readFile, writeFile, appendFile, open, unlink, stat, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, dirname } from "node:path";

const HOME = process.env.HOME ?? "/data/data/com.termux/files/home";
const PI_DIR = join(HOME, ".pi/agent");
// Tests and fault injection point this at a sandbox so they never touch the real
// supervisor state of a live session.
const RUNTIME = process.env.PI_RESURRECT_RUNTIME || join(PI_DIR, "runtime");
// Session discovery must follow the same agent dir pi-safe used, so an isolated
// test run can never read or resume a real session.
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || PI_DIR;
const SESSIONS = join(AGENT_DIR, "sessions");

// pi-safe's own state. Read-only from here: pi-safe owns these files.
const SAFE_STATE = join(RUNTIME, "interactive-supervisor.json");
const SAFE_LOCK = join(RUNTIME, "interactive-supervisor.lock");
const SAFE_LAST_EXIT = join(RUNTIME, "last-exit");
const SAFE_LAST_SESSION = join(RUNTIME, "last-session");

// This layer's own small state. Never a second session/recovery system.
const STATE = join(RUNTIME, "resurrection.json");
const EVENTS = join(RUNTIME, "resurrection-events.jsonl");
const LOCK = join(RUNTIME, "resurrection.lock");

const PI_SAFE_BIN = process.env.PI_RESURRECT_PI_SAFE || join(HOME, ".local/bin/pi-safe");
const TMUX_BIN = process.env.PI_RESURRECT_TMUX || "/data/data/com.termux/files/usr/bin/tmux";
const PREFIX = process.env.PREFIX || "/data/data/com.termux/files/usr";

// Resurrection storms are worse than a missed resurrection: bound them.
const MAX_PER_WINDOW = Number(process.env.PI_RESURRECT_MAX_PER_WINDOW || 5);
const WINDOW_MS = Number(process.env.PI_RESURRECT_WINDOW_MS || 60 * 60 * 1000);
const HEARTBEAT_MIN_INTERVAL_MS = Number(process.env.PI_RESURRECT_HEARTBEAT_MS || 5 * 60 * 1000);

const now = () => new Date().toISOString();

// --------------------------------------------------------------------- state --

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  const handle = await open(tmp, "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
  } finally {
    await handle.close();
  }
  const { rename } = await import("node:fs/promises");
  await rename(tmp, path);
}

const DEFAULT_STATE = {
  version: 1,
  armed: false,
  session_path: null,
  session_id: null,
  session_source: null,
  pi_safe_pid: null,
  pi_safe_starttime: null,
  heartbeat: null,
  started_at: null,
  last_seen_at: null,
  last_exit_classification: null,
  manual_stop: false,
  crash_loop_blocked: false,
  last_resurrection_at: null,
  resurrection_count: 0,
  resurrections: [],
  last_abnormal_loss_at: null,
};

async function loadState() {
  const state = await readJson(STATE);
  return { ...DEFAULT_STATE, ...(state || {}) };
}

async function saveState(state) {
  await writeJsonAtomic(STATE, { ...state, version: 1 });
}

async function logEvent(entry) {
  await mkdir(RUNTIME, { recursive: true, mode: 0o700 });
  // Only non-secret, structural fields. Never prompts, env, or credentials.
  await appendFile(EVENTS, JSON.stringify({ timestamp: now(), ...entry }) + "\n", { mode: 0o600 });
}

// ----------------------------------------------------------- process identity --

/**
 * PID plus starttime from /proc/PID/stat field 22. PID alone is unsafe: Android
 * recycles PIDs aggressively, and a recycled PID must not look like a live
 * supervisor. Zombies are deliberately not counted as alive.
 */
export function processIdentity(pid) {
  if (!pid) return null;
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm can contain spaces and parentheses, so parse after the last ')'.
    const tail = raw.slice(raw.lastIndexOf(")") + 2).split(/\s+/);
    const state = tail[0];
    const starttime = tail[19];
    return { pid: Number(pid), starttime, state };
  } catch {
    return null;
  }
}

export function processAlive(pid, starttime) {
  const identity = processIdentity(pid);
  if (!identity) return false;
  if (identity.state === "Z") return false; // zombie is not a working supervisor
  if (starttime && identity.starttime !== starttime) return false; // recycled PID
  return true;
}

/** Is this pid actually a pi-safe supervisor (not an unrelated recycled pid)? */
function isPiSafeProcess(pid) {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmdline.includes("pi-safe");
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ sessions --

async function sessionHeader(path) {
  try {
    const content = await readFile(path, "utf8");
    const first = content.slice(0, content.indexOf("\n"));
    const header = JSON.parse(first);
    return { sessionId: header.id ?? null, lines: content.length };
  } catch {
    return null;
  }
}

/**
 * Autopilot runs its own supervisor and its own state machine. Its sessions must
 * never be resurrected through pi-safe as if they were interactive Pi.
 */
function isAutopilotSession(path) {
  if (!path) return false;
  return /pi-autopilot|autopilot/i.test(path);
}

/**
 * pi-safe's own session-directory scheme, reimplemented read-only.
 *
 * Needed because pi-safe persists `sessionFile` from a 1s discovery poll: if the
 * tree is killed in the first second, or between the session being created and
 * the next poll, the recorded value is still null even though a real session
 * exists on disk. Observed in fault injection. Rather than change pi-safe, this
 * layer recovers the same way pi-safe would on its next start, using the `cwd`
 * that pi-safe recorded.
 */
async function discoverSession(cwd, since = 0) {
  if (!cwd) return null;
  // Pi's real scheme (dist/core/session-manager.js getDefaultSessionDirPath):
  // strip the leading separator FIRST, then replace separators with '-'.
  // pi-safe's own helper omits the leading-slash strip and therefore computes
  // '---data-...' instead of '--data-...'; matching Pi here rather than copying
  // that bug is what makes discovery actually work.
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const dir = join(SESSIONS, safePath);
  let best = null;
  try {
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      const info = await stat(path);
      if (info.mtimeMs >= since && (!best || info.mtimeMs > best.mtimeMs)) best = { path, mtimeMs: info.mtimeMs };
    }
  } catch {}
  return best?.path ?? null;
}

// ------------------------------------------------------------------ decision --

/**
 * ARM/DISARM is derived from pi-safe's own files rather than a second state
 * machine, so the two layers cannot disagree:
 *
 *   status "running" + dead pid + leftover lock -> abnormal process loss (ARMED)
 *   status "stopped"                            -> normal exit (DISARMED)
 *   status "crash"  + dead pid                  -> pi-safe's bounded crash-loop
 *                                                  stop; must NOT be bypassed
 */
export async function decide({ trigger = "manual", state, safeState, safeLock, safeLastExit, safeLastSession } = {}) {
  state = state || (await loadState());
  safeState = safeState !== undefined ? safeState : await readJson(SAFE_STATE);
  safeLock = safeLock !== undefined ? safeLock : await readJson(SAFE_LOCK);
  safeLastExit = safeLastExit !== undefined ? safeLastExit : await readJson(SAFE_LAST_EXIT);
  safeLastSession = safeLastSession !== undefined ? safeLastSession : await readJson(SAFE_LAST_SESSION);

  const base = { trigger, at: now() };

  if (state.manual_stop) {
    return { ...base, decision: "EXIT_MANUAL_STOP", reason: "resurrection disabled by the user" };
  }

  // A live supervisor makes everything else irrelevant. Check the lock first: it
  // is what pi-safe uses for its own singleton.
  const lockPid = safeLock?.pid;
  if (lockPid && processAlive(lockPid) && isPiSafeProcess(lockPid)) {
    return { ...base, decision: "EXIT_SUPERVISOR_ALIVE", reason: `pi-safe already active (pid ${lockPid})`, pi_safe_pid: lockPid };
  }
  const statePid = safeState?.pid;
  if (safeState?.status === "running" && statePid && processAlive(statePid) && isPiSafeProcess(statePid)) {
    return { ...base, decision: "EXIT_SUPERVISOR_ALIVE", reason: `pi-safe already active (pid ${statePid})`, pi_safe_pid: statePid };
  }

  // pi-safe's bounded crash-loop stop must never be bypassed from out here.
  if (safeState?.status === "crash" && statePid && !processAlive(statePid)) {
    return {
      ...base,
      decision: "EXIT_CRASH_LOOP_BLOCKED",
      reason: "pi-safe stopped itself after repeated crashes; resurrection must not bypass that",
      classification: safeState.classification ?? null,
      crashes: Array.isArray(safeState.crashes) ? safeState.crashes.length : 0,
    };
  }

  // No pi-safe run recorded at all, or a clean stop: nothing to resurrect.
  if (!safeState) {
    return { ...base, decision: "EXIT_DISARMED", reason: "no pi-safe supervisor state recorded" };
  }
  if (safeState.status === "stopped") {
    const classification = safeState.classification ?? safeLastExit?.classification ?? null;
    return { ...base, decision: "EXIT_DISARMED", reason: `pi-safe exited normally (${classification || "clean stop"})`, classification };
  }

  // From here on: status "running" but no live pi-safe -> the tree died.
  let sessionPath = safeState.sessionFile || safeLastSession?.sessionFile || safeLastExit?.sessionFile || state.session_path || null;
  let sessionSource = sessionPath ? "recorded by pi-safe" : null;

  // pi-safe may not have persisted the session yet when it was killed. Recover
  // the same way pi-safe itself would, scoped to the cwd it recorded, and only
  // accept sessions from this supervisor's lifetime so an unrelated older session
  // is never resumed.
  if (!sessionPath && safeState.cwd) {
    const startedAt = safeState.startedAt ? Date.parse(safeState.startedAt) - 5000 : 0;
    sessionPath = await discoverSession(safeState.cwd, startedAt);
    if (sessionPath) sessionSource = "discovered from the supervisor cwd";
  }

  if (!sessionPath) {
    return { ...base, decision: "EXIT_NO_SESSION", reason: "abnormal supervisor loss but no session recorded; failing closed", fail_closed: true };
  }
  if (isAutopilotSession(sessionPath)) {
    return { ...base, decision: "EXIT_AUTOPILOT", reason: "session belongs to Autopilot, which owns its own supervisor", session_path: sessionPath };
  }
  if (!existsSync(sessionPath)) {
    return { ...base, decision: "EXIT_NO_SESSION", reason: "recorded session file no longer exists; failing closed", session_path: sessionPath, fail_closed: true };
  }
  const header = await sessionHeader(sessionPath);
  if (!header?.sessionId) {
    return { ...base, decision: "EXIT_NO_SESSION", reason: "session file is unreadable or has no id; failing closed", session_path: sessionPath, fail_closed: true };
  }

  // Rate limit: a resurrection storm is worse than a missed resurrection.
  const recent = (state.resurrections || []).filter(t => Date.now() - Date.parse(t) < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    return {
      ...base,
      decision: "EXIT_RATE_LIMITED",
      reason: `${recent.length} resurrections in the last ${Math.round(WINDOW_MS / 60000)} min; refusing to continue`,
      session_path: sessionPath,
    };
  }

  return {
    ...base,
    decision: "RESURRECT",
    reason: "pi-safe recorded a running supervisor that no longer exists",
    session_path: sessionPath,
    session_source: sessionSource,
    session_id: header.sessionId,
    lost_pi_safe_pid: statePid ?? null,
    previous_classification: safeLastExit?.classification ?? null,
  };
}

// -------------------------------------------------------------------- launch --

/**
 * pi-safe wraps Pi in `script -qef` and expects a terminal. An Android-owned
 * trigger has no TTY, so the supervisor is started inside a detached tmux
 * session: that supplies a real PTY and survives the trigger process exiting.
 */
function launchPiSafe(sessionPath, { dryRun = false } = {}) {
  const name = `pi-resurrect-${Date.now()}`;
  // Recovery continuation is owned by the shared recovery-continuation module
  // (~/.pi/agent/recovery), consumed by pi-safe: pi-resurrect only resumes the
  // same session; pi-safe plans/launches the continuation from its state.
  const args = ["new-session", "-d", "-s", name, PI_SAFE_BIN, "--session", sessionPath];
  if (dryRun) return { launched: false, dry_run: true, command: `tmux ${args.join(" ")}`, tmux_session: name };
  if (!existsSync(TMUX_BIN)) return { launched: false, error: "tmux is unavailable, cannot provide a PTY" };

  const result = spawnSync(TMUX_BIN, args, {
    env: {
      ...process.env,
      PI_RESURRECT_NO_HOOK: "1", // never let the child re-trigger this layer
      PI_RESURRECTED: "1",
      TERM: process.env.TERM || "xterm-256color",
      PREFIX,
      HOME,
    },
    encoding: "utf8",
    timeout: 30000,
  });
  if (result.status !== 0) {
    return { launched: false, error: (result.stderr || result.error?.message || `tmux exited ${result.status}`).slice(0, 300), tmux_session: name };
  }
  return { launched: true, tmux_session: name };
}

// ---------------------------------------------------------------------- lock --

/** Only one resurrection check may act at a time, even if triggers overlap. */
async function withLock(fn) {
  await mkdir(RUNTIME, { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(LOCK, "wx", 0o600);
  } catch {
    const holder = await readJson(LOCK);
    if (holder?.pid && processAlive(holder.pid, holder.starttime)) {
      return { skipped: true, reason: `another resurrection check is running (pid ${holder.pid})` };
    }
    await unlink(LOCK).catch(() => {});
    try {
      handle = await open(LOCK, "wx", 0o600);
    } catch {
      return { skipped: true, reason: "could not acquire the resurrection lock" };
    }
  }
  try {
    const identity = processIdentity(process.pid);
    await handle.writeFile(JSON.stringify({ pid: process.pid, starttime: identity?.starttime ?? null, at: now() }));
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await unlink(LOCK).catch(() => {});
  }
}

// --------------------------------------------------------------------- check --

export async function check({ trigger = "manual", dryRun = false, quiet = false } = {}) {
  return withLock(async () => {
    const state = await loadState();
    const outcome = await decide({ trigger, state });
    const next = { ...state, last_seen_at: now() };

    if (outcome.decision === "RESURRECT") {
      next.last_abnormal_loss_at = now();
      const launch = launchPiSafe(outcome.session_path, { dryRun });
      if (launch.launched) {
        next.armed = true;
        next.session_path = outcome.session_path;
        next.session_id = outcome.session_id;
        next.session_source = outcome.session_source ?? "recorded by pi-safe";
        next.last_resurrection_at = now();
        next.resurrection_count = (state.resurrection_count || 0) + 1;
        next.resurrections = [...(state.resurrections || []).filter(t => Date.now() - Date.parse(t) < WINDOW_MS), now()];
        next.heartbeat = now();
      }
      await saveState(next);
      await logEvent({
        trigger,
        decision: outcome.decision,
        reason: outcome.reason,
        session_id: outcome.session_id,
        session_path: outcome.session_path,
        previous_state: { armed: state.armed, status_source: "pi-safe", classification: outcome.previous_classification ?? null },
        supervisor_existed: false,
        action: launch.dry_run ? "dry-run" : launch.launched ? "launched pi-safe" : "launch failed",
        result: launch.launched ? "ok" : launch.dry_run ? "dry-run" : (launch.error ?? "failed"),
        tmux_session: launch.tmux_session ?? null,
      });
      if (!quiet) {
        console.log(
          launch.launched
            ? `resurrect: started pi-safe on ${outcome.session_id} (tmux ${launch.tmux_session})`
            : launch.dry_run
              ? `resurrect: would run ${launch.command}`
              : `resurrect: FAILED to launch: ${launch.error}`,
        );
      }
      return { ...outcome, ...launch };
    }

    // Not resurrecting. Keep observed facts current without churning the disk.
    if (outcome.decision === "EXIT_SUPERVISOR_ALIVE") {
      next.armed = true;
      next.pi_safe_pid = outcome.pi_safe_pid ?? null;
      next.pi_safe_starttime = processIdentity(outcome.pi_safe_pid)?.starttime ?? null;
      const last = state.heartbeat ? Date.parse(state.heartbeat) : 0;
      if (Date.now() - last > HEARTBEAT_MIN_INTERVAL_MS) next.heartbeat = now();
    }
    if (outcome.decision === "EXIT_DISARMED") {
      next.armed = false;
      next.last_exit_classification = outcome.classification ?? null;
    }
    if (outcome.decision === "EXIT_CRASH_LOOP_BLOCKED") {
      next.crash_loop_blocked = true;
      next.armed = false;
    }

    // Write only when something meaningful changed: a trigger that finds a
    // healthy system should be almost free.
    const changed = JSON.stringify({ ...state, last_seen_at: null }) !== JSON.stringify({ ...next, last_seen_at: null });
    if (changed) await saveState(next);

    if (outcome.decision !== "EXIT_SUPERVISOR_ALIVE" || changed) {
      await logEvent({
        trigger,
        decision: outcome.decision,
        reason: outcome.reason,
        session_id: outcome.session_id ?? state.session_id ?? null,
        session_path: outcome.session_path ?? null,
        previous_state: { armed: state.armed, crash_loop_blocked: state.crash_loop_blocked, manual_stop: state.manual_stop },
        supervisor_existed: outcome.decision === "EXIT_SUPERVISOR_ALIVE",
        action: "none",
        result: "exit 0",
      });
    }
    if (!quiet) console.log(`resurrect: ${outcome.decision} — ${outcome.reason}`);
    return outcome;
  });
}

// ------------------------------------------------------------ arm/disarm CLI --

async function setManualStop(value) {
  const state = await loadState();
  await saveState({ ...state, manual_stop: value, armed: value ? false : state.armed });
  await logEvent({ trigger: "cli", decision: value ? "DISABLED" : "ENABLED", reason: "user request", action: "state update", result: "ok" });
  console.log(`resurrect: ${value ? "disabled" : "enabled"}`);
}

async function clearCrashLoop() {
  const state = await loadState();
  await saveState({ ...state, crash_loop_blocked: false });
  await logEvent({ trigger: "cli", decision: "CRASH_LOOP_CLEARED", reason: "user request", action: "state update", result: "ok" });
  console.log("resurrect: crash-loop block cleared");
}

// -------------------------------------------------------------------- doctor --

async function doctor() {
  const checks = [];
  const add = (name, status, detail = "") => checks.push({ name, status, detail });

  const state = await loadState();
  const safeState = await readJson(SAFE_STATE);
  const safeLock = await readJson(SAFE_LOCK);
  const safeLastExit = await readJson(SAFE_LAST_EXIT);

  add("resurrection script installed", existsSync(join(PI_DIR, "resurrect/resurrect.mjs")) ? "PASS" : "FAIL", join(PI_DIR, "resurrect/resurrect.mjs"));
  add("pi-resurrect CLI", existsSync(join(HOME, ".local/bin/pi-resurrect")) ? "PASS" : "FAIL", join(HOME, ".local/bin/pi-resurrect"));
  add("pi-safe available", existsSync(PI_SAFE_BIN) ? "PASS" : "FAIL", PI_SAFE_BIN);

  // pi-safe compatibility: the state fields this layer reads must exist.
  const compatible = Boolean(PI_SAFE_BIN && existsSync(PI_SAFE_BIN)) && (() => {
    try {
      const src = readFileSync(PI_SAFE_BIN, "utf8");
      return src.includes("interactive-supervisor.json") && src.includes("last-session") && src.includes("MAX_TOTAL");
    } catch {
      return false;
    }
  })();
  add("pi-safe compatible", compatible ? "PASS" : "FAIL", compatible ? "state files and crash-loop bounds present" : "expected pi-safe state contract not found");

  // Permissions.
  try {
    const dir = await stat(RUNTIME);
    add("runtime dir permissions", (dir.mode & 0o777) === 0o700 ? "PASS" : "WARN", `mode ${(dir.mode & 0o777).toString(8)}`);
  } catch (error) {
    add("runtime dir permissions", "FAIL", error.message);
  }
  for (const [label, path] of [["state", STATE], ["events log", EVENTS]]) {
    try {
      const info = await stat(path);
      const mode = (info.mode & 0o777).toString(8);
      add(`${label} permissions`, mode === "600" ? "PASS" : "WARN", `mode ${mode}`);
    } catch {
      add(`${label} permissions`, "PASS", "not created yet");
    }
  }

  add("armed state", "PASS", state.manual_stop ? "disabled by user" : state.armed ? "armed" : "disarmed");
  add("crash-loop block", state.crash_loop_blocked ? "WARN" : "PASS", state.crash_loop_blocked ? "blocked; pi-safe stopped itself" : "clear");

  // Shared recovery continuation: pi-safe and pi-resurrect share the same
  // primitive (~/.pi/agent/recovery/recovery-continuation.mjs).
  try {
    const contModule = await import(`file://${PI_DIR}/recovery/recovery-continuation.mjs`);
    add("recovery continuation module", "PASS", "loaded");
    const cont = await contModule.continuationStatus().catch(() => null);
    if (cont) {
      add("continuation durable state", "PASS", `${cont.status} gen=${cont.generation} attempt=${cont.attempt}`);
      add("continuation blocked", cont.status === "BLOCKED" ? "WARN" : "PASS", cont.status === "BLOCKED" ? "blocked for current session" : "clear");
    } else {
      add("continuation durable state", "PASS", "absent (never run)");
    }
  } catch (error) {
    add("recovery continuation module", "FAIL", error.message);
  }

  // Session validity.
  const sessionPath = safeState?.sessionFile || state.session_path;
  if (!sessionPath) {
    add("session path", "PASS", "no session recorded (nothing to resurrect)");
    add("session id", "PASS", "n/a");
  } else {
    add("session path", existsSync(sessionPath) ? "PASS" : "WARN", sessionPath);
    const header = await sessionHeader(sessionPath);
    add("session id", header?.sessionId ? "PASS" : "WARN", header?.sessionId ?? "unreadable");
  }

  // Supervisor / duplicate checks.
  const lockPid = safeLock?.pid;
  const lockAlive = lockPid ? processAlive(lockPid) : false;
  add("supervisor lock", lockPid ? (lockAlive ? "PASS" : "WARN") : "PASS", lockPid ? `pid ${lockPid} ${lockAlive ? "alive" : "stale (process gone)"}` : "no lock");
  const stalePid = safeState?.status === "running" && safeState.pid && !processAlive(safeState.pid);
  add("stale supervisor PID", stalePid ? "WARN" : "PASS", stalePid ? `pid ${safeState.pid} recorded running but absent` : "none");

  const psOut = spawnSync("sh", ["-lc", "ps -eo pid=,stat=,args= 2>/dev/null"], { encoding: "utf8", timeout: 15000 }).stdout || "";
  const lines = psOut.split("\n").filter(Boolean);
  const piSafeProcs = lines.filter(l => /pi-safe/.test(l) && !/\bgrep\b/.test(l));
  const zombies = lines.filter(l => /\sZ[\s+]/.test(l) || /\sZ$/.test(l));
  add("duplicate supervisor", piSafeProcs.length <= 1 ? "PASS" : "FAIL", `${piSafeProcs.length} pi-safe process(es)`);
  const piProcs = spawnSync("sh", ["-lc", "ps -eo args= 2>/dev/null | awk '/(^|\\/)pi( |$)/ && !/pi-safe/ && !/awk/ {n++} END {print n+0}'"], { encoding: "utf8", timeout: 15000 }).stdout?.trim();
  add("duplicate Pi", Number(piProcs || 0) <= 1 ? "PASS" : "WARN", `${piProcs || 0} interactive Pi visible`);
  add("zombie processes", zombies.length === 0 ? "PASS" : "WARN", zombies.length ? `${zombies.length} zombie(s)` : "none");

  // Android-owned trigger availability. This is the honest part: on this device
  // the companion APKs are absent, so most triggers are unavailable.
  const bootDir = join(HOME, ".termux/boot");
  const bootScript = join(bootDir, "10-pi-resurrect.sh");
  const pmList = spawnSync("/system/bin/pm", ["list", "packages"], { encoding: "utf8", timeout: 30000 }).stdout || "";
  const hasBootApk = /com\.termux\.boot/.test(pmList);
  const hasApiApk = /com\.termux\.api/.test(pmList);
  add("Termux:Boot APK", hasBootApk ? "PASS" : "FAIL", hasBootApk ? "installed" : "not installed: boot recovery cannot run");
  add("Termux:Boot script", existsSync(bootScript) ? "PASS" : "WARN", existsSync(bootScript) ? `${bootScript} (inert until the APK is installed)` : "not installed");
  add("Termux:API APK", hasApiApk ? "PASS" : "FAIL", hasApiApk ? "installed" : "not installed: termux-job-scheduler cannot work");
  add(
    "JobScheduler trigger",
    hasApiApk ? "PASS" : "FAIL",
    hasApiApk ? "available" : "unavailable without the Termux:API APK (the wrapper blocks forever)",
  );

  // The trigger that does work here: Termux app start runs the login shell.
  const hookFiles = [join(HOME, ".bashrc"), join(PREFIX, "etc/bash.bashrc")];
  let hookInstalled = false;
  let hookWhere = "not installed";
  for (const file of hookFiles) {
    try {
      if ((await readFile(file, "utf8")).includes("pi-resurrect-hook")) {
        hookInstalled = true;
        hookWhere = file;
        break;
      }
    } catch {}
  }
  add("shell-start trigger", hookInstalled ? "PASS" : "FAIL", hookInstalled ? hookWhere : "not installed");

  // runit is only an inner supervision level; say so plainly.
  const svcDir = join(PREFIX, "var/service/pi-resurrect");
  const svcInstalled = existsSync(join(svcDir, "run"));
  let svcStatus = "not installed";
  if (svcInstalled) {
    svcStatus = (spawnSync("sv", ["status", "pi-resurrect"], { encoding: "utf8", timeout: 15000 }).stdout || "").trim() || "unknown";
  }
  add("runit inner supervision", svcInstalled ? "PASS" : "WARN", `${svcStatus} (dies with the Termux tree; not an Android trigger)`);

  add("wake-lock command", existsSync(join(PREFIX, "bin/termux-wake-lock")) ? "PASS" : "WARN", hasApiApk ? "available" : "present but non-functional without the Termux:API APK");
  add("battery/background limits", "WARN", "cannot be read without root: appops/deviceidle require DEVICE_POWER or INTERACT_ACROSS_USERS");

  add("last resurrection", "PASS", state.last_resurrection_at ? `${state.last_resurrection_at} (total ${state.resurrection_count})` : "never");
  add("last abnormal loss", "PASS", state.last_abnormal_loss_at ?? safeLastExit?.classification ?? "none recorded");

  // Autopilot isolation.
  const autopilotUp = (spawnSync("sv", ["status", "pi-autopilot"], { encoding: "utf8", timeout: 15000 }).stdout || "").trim();
  add("Autopilot isolation", /run:/.test(autopilotUp) ? "PASS" : "WARN", `${autopilotUp || "unknown"}; never resurrected from here`);

  const decision = await decide({ trigger: "doctor", state, safeState, safeLock, safeLastExit });
  add("current decision", "PASS", `${decision.decision} — ${decision.reason}`);

  const failed = checks.filter(c => c.status === "FAIL");
  console.log(JSON.stringify({ tool: "pi-resurrect", version: 1, checks }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
}

// ----------------------------------------------------------------------- CLI --

async function status() {
  const state = await loadState();
  const decision = await decide({ trigger: "status", state });
  console.log(JSON.stringify({ state, decision }, null, 2));
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "check":
    await check({ trigger: rest.includes("--trigger") ? rest[rest.indexOf("--trigger") + 1] : "manual", dryRun: rest.includes("--dry-run"), quiet: rest.includes("--quiet") });
    break;
  case "doctor":
    await doctor();
    break;
  case "status":
    await status();
    break;
  case "disable":
    await setManualStop(true);
    break;
  case "enable":
    await setManualStop(false);
    break;
  case "clear-crash-loop":
    await clearCrashLoop();
    break;
  case undefined:
  case "help":
    console.log(`pi-resurrect — Android/Termux resurrection layer

  check [--trigger NAME] [--dry-run] [--quiet]  run one resurrection check and exit
  status                                        show state and what would happen now
  doctor                                        full diagnostic
  disable | enable                              turn resurrection off/on
  clear-crash-loop                              clear a pi-safe crash-loop block

This layer never replays a prompt and never starts a new session. It only starts
one pi-safe on the same session that was already running.`);
    break;
  default:
    console.error(`pi-resurrect: unknown command "${command}"`);
    process.exitCode = 2;
}
