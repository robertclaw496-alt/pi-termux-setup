import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionSafety, AmbiguousExternalActionError, OperationJournal, sha256 } from "../index.mjs";
import { ABSENT, appendMarker, atomicWrite, hashFile, planFileOperation } from "../file-safety.mjs";
import { childStillRunning, planShellCommand, processIdentity } from "../shell-safety.mjs";
import { CLASS } from "../classify.mjs";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pi-fs-safety-"));
  const work = join(root, "work");
  await mkdir(work, { recursive: true });
  const journal = new OperationJournal(join(root, "journal"));
  return { root, work, journal, safety: new ActionSafety({ journal }) };
}

const cleanup = root => rm(root, { recursive: true, force: true });

async function runFile(safety, options) {
  const { spec, hooks } = await planFileOperation(options);
  return safety.execute(spec, hooks);
}

test("atomic write leaves no partial file and verifies by hash", async () => {
  const x = await setup();
  try {
    const path = join(x.work, "a.txt");
    await atomicWrite(path, "hello");
    assert.equal(await readFile(path, "utf8"), "hello");
    assert.equal(await hashFile(path), sha256("hello"));
    assert.deepEqual((await readdir(x.work)).filter(name => name.includes("tmp")), []);
  } finally { await cleanup(x.root); }
});

test("hashFile reports ABSENT instead of throwing for a missing file", async () => {
  const x = await setup();
  try { assert.equal(await hashFile(join(x.work, "nope")), ABSENT); } finally { await cleanup(x.root); }
});

test("file write is deduplicated for the same logical operation", async () => {
  const x = await setup();
  try {
    const path = join(x.work, "dedup.txt");
    const options = { sessionId: "s", turnRef: "t", operationKey: "w1", action: "write", path, content: "one" };
    const first = await runFile(x.safety, options);
    const second = await runFile(x.safety, options);
    assert.equal(first.operation.status, "COMPLETED");
    assert.equal(second.deduplicated, true);
    assert.equal(await readFile(path, "utf8"), "one");
  } finally { await cleanup(x.root); }
});

test("stale STARTED write is reconciled by desired hash without rewriting", async () => {
  const x = await setup();
  try {
    const path = join(x.work, "recon.txt");
    await atomicWrite(path, "final");
    const { spec, hooks } = await planFileOperation({ sessionId: "s", turnRef: "t", operationKey: "w2", action: "write", path, content: "final" });
    const seed = (await import("../index.mjs")).buildOperation(spec);
    await x.journal.save({ ...seed, status: "STARTED", created_at: "a", started_at: "a", completed_at: null, result_reference: null, attempt: 1 });
    let invoked = 0;
    const result = await x.safety.execute(spec, { ...hooks, invoke: async operation => { invoked += 1; return hooks.invoke(operation); } });
    assert.equal(result.reconciled, true);
    assert.equal(invoked, 0);
  } finally { await cleanup(x.root); }
});

test("stale STARTED write retries when the file still holds pre-state", async () => {
  const x = await setup();
  try {
    const path = join(x.work, "pre.txt");
    await atomicWrite(path, "before");
    const before = await hashFile(path);
    const { spec, hooks } = await planFileOperation({ sessionId: "s", turnRef: "t", operationKey: "w3", action: "write", path, content: "after", expectedBeforeHash: before });
    const seed = (await import("../index.mjs")).buildOperation(spec);
    await x.journal.save({ ...seed, status: "STARTED", created_at: "a", started_at: "a", completed_at: null, result_reference: null, attempt: 1 });
    const result = await x.safety.execute(spec, hooks);
    assert.equal(result.deduplicated, false);
    assert.equal(await readFile(path, "utf8"), "after");
  } finally { await cleanup(x.root); }
});

test("write precondition rejects a file changed by someone else", async () => {
  const x = await setup();
  try {
    const path = join(x.work, "conflict.txt");
    await atomicWrite(path, "original");
    await assert.rejects(() => runFile(x.safety, { sessionId: "s", turnRef: "t", operationKey: "w4", action: "write", path, content: "new", expectedBeforeHash: sha256("something else") }), /Precondition failed/);
    // The refusal happened before any write, so the file is untouched.
    assert.equal(await readFile(path, "utf8"), "original");
    const [record] = await x.journal.list();
    assert.equal(record.status, "FAILED");
  } finally { await cleanup(x.root); }
});

test("edit is not applied twice and unrelated content becomes UNKNOWN", async () => {
  const x = await setup();
  try {
    const path = join(x.work, "edit.txt");
    await atomicWrite(path, "line one\n");
    const before = await hashFile(path);
    const patched = "line one changed\n";
    const { spec, hooks } = await planFileOperation({ sessionId: "s", turnRef: "t", operationKey: "e1", action: "edit", path, content: patched, expectedBeforeHash: before });
    await x.safety.execute(spec, hooks);
    assert.equal(await readFile(path, "utf8"), patched);

    // A crashed repeat of the same edit must recognise the post-state.
    const seed = (await import("../index.mjs")).buildOperation(spec);
    await x.journal.save({ ...(await x.journal.get(seed.operation_id)), status: "STARTED" });
    let invoked = 0;
    const again = await x.safety.execute(spec, { ...hooks, invoke: async () => { invoked += 1; throw new Error("must not reapply"); } });
    assert.equal(again.reconciled, true);
    assert.equal(invoked, 0);

    // A third-party change makes the outcome ambiguous.
    await atomicWrite(path, "completely different\n");
    const conflict = await planFileOperation({ sessionId: "s", turnRef: "t", operationKey: "e2", action: "edit", path, content: patched, expectedBeforeHash: before });
    const conflictSeed = (await import("../index.mjs")).buildOperation(conflict.spec);
    await x.journal.save({ ...conflictSeed, status: "STARTED", created_at: "a", started_at: "a", completed_at: null, result_reference: null, attempt: 1 });
    await assert.rejects(() => x.safety.execute(conflict.spec, conflict.hooks), AmbiguousExternalActionError);
  } finally { await cleanup(x.root); }
});

test("unmarked append in an uncertain state is never replayed", async () => {
  const x = await setup();
  try {
    const path = join(x.work, "log.txt");
    await writeFile(path, "existing\n");
    const { spec, hooks } = await planFileOperation({ sessionId: "s", turnRef: "t", operationKey: "a1", action: "append", path, content: "entry", marked: false });
    assert.equal(hooks.classification, CLASS.OPAQUE);
    const seed = (await import("../index.mjs")).buildOperation(spec);
    await x.journal.save({ ...seed, status: "STARTED", created_at: "a", started_at: "a", completed_at: null, result_reference: null, attempt: 1 });
    await assert.rejects(() => x.safety.execute(spec, hooks), AmbiguousExternalActionError);
    assert.equal(await readFile(path, "utf8"), "existing\n");
  } finally { await cleanup(x.root); }
});

test("marked append is reconciled and never duplicates a line", async () => {
  const x = await setup();
  try {
    const path = join(x.work, "marked.txt");
    await writeFile(path, "");
    const { spec, hooks } = await planFileOperation({ sessionId: "s", turnRef: "t", operationKey: "a2", action: "append", path, content: "entry", marked: true });
    const first = await x.safety.execute(spec, hooks);
    const seed = (await import("../index.mjs")).buildOperation(spec);
    await x.journal.save({ ...(await x.journal.get(seed.operation_id)), status: "STARTED" });
    const recovered = await x.safety.execute(spec, hooks);
    assert.equal(recovered.reconciled, true);
    const body = await readFile(path, "utf8");
    assert.equal(body.split(appendMarker(first.operation.operation_id)).length - 1, 1);
    assert.equal(body.split("entry").length - 1, 1);
  } finally { await cleanup(x.root); }
});

test("delete reconciles to COMPLETED when the target is already absent", async () => {
  const x = await setup();
  try {
    const path = join(x.work, "gone.txt");
    await writeFile(path, "x");
    const { spec, hooks } = await planFileOperation({ sessionId: "s", turnRef: "t", operationKey: "d1", action: "delete", path });
    await x.safety.execute(spec, hooks);
    const seed = (await import("../index.mjs")).buildOperation(spec);
    await x.journal.save({ ...(await x.journal.get(seed.operation_id)), status: "STARTED" });
    const recovered = await x.safety.execute(spec, { ...hooks, invoke: async () => { throw new Error("must not delete twice"); } });
    assert.equal(recovered.reconciled, true);
  } finally { await cleanup(x.root); }
});

test("rename reconciliation covers all four filesystem states", async () => {
  const x = await setup();
  try {
    const source = join(x.work, "from.txt");
    const destination = join(x.work, "to.txt");
    const plan = () => planFileOperation({ sessionId: "s", turnRef: "t", operationKey: "r1", action: "rename", path: source, destination });
    const { buildOperation } = await import("../index.mjs");

    // applied: source gone, destination present
    await writeFile(source, "payload");
    const applied = await plan();
    await x.safety.execute(applied.spec, applied.hooks);
    await x.journal.save({ ...(await x.journal.get(buildOperation(applied.spec).operation_id)), status: "STARTED" });
    const recovered = await x.safety.execute(applied.spec, { ...applied.hooks, invoke: async () => { throw new Error("must not rename twice"); } });
    assert.equal(recovered.reconciled, true);

    // not applied: source present, destination absent -> safe retry
    const fresh = await setup();
    try {
      const s2 = join(fresh.work, "from.txt");
      const d2 = join(fresh.work, "to.txt");
      await writeFile(s2, "payload");
      const notApplied = await planFileOperation({ sessionId: "s", turnRef: "t", operationKey: "r2", action: "rename", path: s2, destination: d2 });
      const seed = buildOperation(notApplied.spec);
      await fresh.journal.save({ ...seed, status: "STARTED", created_at: "a", started_at: "a", completed_at: null, result_reference: null, attempt: 1 });
      await fresh.safety.execute(notApplied.spec, notApplied.hooks);
      assert.equal(await readFile(d2, "utf8"), "payload");

      // conflict: both exist -> UNKNOWN
      const s3 = join(fresh.work, "b1.txt");
      const d3 = join(fresh.work, "b2.txt");
      await writeFile(s3, "a"); await writeFile(d3, "b");
      const conflict = await planFileOperation({ sessionId: "s", turnRef: "t", operationKey: "r3", action: "rename", path: s3, destination: d3 });
      const conflictSeed = buildOperation(conflict.spec);
      await fresh.journal.save({ ...conflictSeed, status: "STARTED", created_at: "a", started_at: "a", completed_at: null, result_reference: null, attempt: 1 });
      await assert.rejects(() => fresh.safety.execute(conflict.spec, conflict.hooks), AmbiguousExternalActionError);

      // both absent -> UNKNOWN
      const both = await planFileOperation({ sessionId: "s", turnRef: "t", operationKey: "r4", action: "rename", path: join(fresh.work, "x1"), destination: join(fresh.work, "x2") });
      const bothSeed = buildOperation(both.spec);
      await fresh.journal.save({ ...bothSeed, status: "STARTED", created_at: "a", started_at: "a", completed_at: null, result_reference: null, attempt: 1 });
      await assert.rejects(() => fresh.safety.execute(both.spec, both.hooks), AmbiguousExternalActionError);
    } finally { await cleanup(fresh.root); }
  } finally { await cleanup(x.root); }
});

test("mkdir is treated as idempotent and reconciles by existence", async () => {
  const x = await setup();
  try {
    const path = join(x.work, "nested/dir");
    const { spec, hooks } = await planFileOperation({ sessionId: "s", turnRef: "t", operationKey: "m1", action: "mkdir", path });
    assert.equal(hooks.classification, CLASS.SAFE_IDEMPOTENT_LOCAL);
    await x.safety.execute(spec, hooks);
    assert.ok((await stat(path)).isDirectory());
    const seed = (await import("../index.mjs")).buildOperation(spec);
    await x.journal.save({ ...(await x.journal.get(seed.operation_id)), status: "STARTED" });
    const recovered = await x.safety.execute(spec, hooks);
    assert.equal(recovered.reconciled, true);
  } finally { await cleanup(x.root); }
});

test("read-only work bypasses the journal entirely", async () => {
  const x = await setup();
  try {
    const { spec, hooks } = planShellCommand({ sessionId: "s", turnRef: "t", operationKey: "ro", command: "echo hello", journal: x.journal });
    assert.equal(hooks.classification, CLASS.READ_ONLY);
    const result = await x.safety.execute(spec, hooks);
    assert.equal(result.skipped, true);
    // No record and no lock file: read-only work leaves the journal untouched.
    assert.deepEqual(await x.journal.list(), []);
    assert.equal(await hashFile(x.journal.lockFile), ABSENT);
  } finally { await cleanup(x.root); }
});

test("idempotent shell command recovers automatically after a stale STARTED", async () => {
  const x = await setup();
  try {
    const target = join(x.work, "made");
    const { spec, hooks } = planShellCommand({ sessionId: "s", turnRef: "t", operationKey: "sh1", command: `mkdir -p ${target}`, journal: x.journal });
    assert.equal(hooks.classification, CLASS.SAFE_IDEMPOTENT_LOCAL);
    const seed = (await import("../index.mjs")).buildOperation(spec);
    await x.journal.save({ ...seed, status: "STARTED", created_at: "a", started_at: "a", completed_at: null, result_reference: null, attempt: 1 });
    const result = await x.safety.execute(spec, hooks);
    assert.equal(result.operation.status, "COMPLETED");
    assert.ok((await stat(target)).isDirectory());
  } finally { await cleanup(x.root); }
});

test("opaque shell command in an uncertain state is never replayed", async () => {
  const x = await setup();
  try {
    const path = join(x.work, "appended.txt");
    await writeFile(path, "start\n");
    const { spec, hooks } = planShellCommand({ sessionId: "s", turnRef: "t", operationKey: "sh2", command: `echo more >> ${path}`, journal: x.journal });
    assert.equal(hooks.classification, CLASS.OPAQUE);
    const seed = (await import("../index.mjs")).buildOperation(spec);
    await x.journal.save({ ...seed, status: "STARTED", created_at: "a", started_at: "a", completed_at: null, result_reference: null, attempt: 1 });
    await assert.rejects(() => x.safety.execute(spec, hooks), AmbiguousExternalActionError);
    assert.equal(await readFile(path, "utf8"), "start\n");
  } finally { await cleanup(x.root); }
});

test("a caller-supplied verify probe can close an opaque command", async () => {
  const x = await setup();
  try {
    const marker = join(x.work, "effect.flag");
    const { spec, hooks } = planShellCommand({
      sessionId: "s", turnRef: "t", operationKey: "sh3",
      command: `echo done >> ${marker}`,
      journal: x.journal,
      verify: async () => (await hashFile(marker)) === ABSENT ? { state: "retry", reason: "effect absent" } : { state: "completed", result: { status: "effect_present" } },
    });
    await writeFile(marker, "done\n");
    const seed = (await import("../index.mjs")).buildOperation(spec);
    await x.journal.save({ ...seed, status: "STARTED", created_at: "a", started_at: "a", completed_at: null, result_reference: null, attempt: 1 });
    const result = await x.safety.execute(spec, hooks);
    assert.equal(result.reconciled, true);
  } finally { await cleanup(x.root); }
});

test("a still-running child is never duplicated after recovery", async () => {
  const x = await setup();
  try {
    const child = spawn("/data/data/com.termux/files/usr/bin/bash", ["-c", "sleep 30"], { stdio: "ignore" });
    await new Promise(resolve => setTimeout(resolve, 150));
    try {
      const identity = await processIdentity(child.pid);
      assert.ok(identity, "expected /proc identity to be readable");
      const { spec, hooks } = planShellCommand({ sessionId: "s", turnRef: "t", operationKey: "sh4", command: "cp a b", journal: x.journal });
      const seed = (await import("../index.mjs")).buildOperation(spec);
      await x.journal.save({ ...seed, status: "STARTED", created_at: "a", started_at: "a", completed_at: null, result_reference: null, attempt: 1, child: identity });
      assert.equal(await childStillRunning({ child: identity }), true);
      await assert.rejects(() => x.safety.execute(spec, hooks), AmbiguousExternalActionError);
      const record = await x.journal.get(seed.operation_id);
      assert.match(record.reconciliation_error, /still running/i);
    } finally { child.kill("SIGKILL"); }
  } finally { await cleanup(x.root); }
});

test("a vanished child with a recycled pid is not mistaken for the original", async () => {
  const x = await setup();
  try {
    const child = spawn("/data/data/com.termux/files/usr/bin/bash", ["-c", "true"], { stdio: "ignore" });
    const pid = child.pid;
    await new Promise(resolve => child.on("close", resolve));
    assert.equal(await childStillRunning({ child: { pid, start_ticks: "999999999999" } }), false);
  } finally { await cleanup(x.root); }
});

test("journal never stores raw commands or credentials", async () => {
  const x = await setup();
  try {
    const command = `curl -X POST -H "Authorization: Bearer sk-live-secret-value" https://api.example.com/pay -d amount=100`;
    const { spec, hooks } = planShellCommand({ sessionId: "s", turnRef: "t", operationKey: "sec1", command, journal: x.journal });
    // The sanitized form the layer would ever surface must already be clean.
    assert.doesNotMatch(spec.args.normalized_command, /sk-live-secret-value/);
    assert.match(spec.args.normalized_command, /REDACTED/);
    await assert.rejects(() => x.safety.execute(spec, { ...hooks, invoke: async () => { throw new Error("network down"); }, reconcile: async () => ({ state: "unknown" }) }), AmbiguousExternalActionError);
    const raw = JSON.stringify(await x.journal.list());
    assert.doesNotMatch(raw, /sk-live-secret-value/);
    assert.doesNotMatch(raw, /api\.example\.com/, "the raw command must not reach the journal at all");
    assert.match(raw, /"kind":"command"/);
  } finally { await cleanup(x.root); }
});

test("concurrent callers produce exactly one mutation and a deterministic state", async () => {
  const x = await setup();
  try {
    const path = join(x.work, "concurrent.txt");
    let writes = 0;
    const build = async () => {
      const plan = await planFileOperation({ sessionId: "s", turnRef: "t", operationKey: "c1", action: "write", path, content: "final" });
      return { ...plan, hooks: { ...plan.hooks, invoke: async operation => { writes += 1; return plan.hooks.invoke(operation); } } };
    };
    const plans = await Promise.all(Array.from({ length: 8 }, build));
    await Promise.all(plans.map(plan => x.safety.execute(plan.spec, plan.hooks)));
    assert.equal(writes, 1);
    assert.equal(await readFile(path, "utf8"), "final");
    assert.equal((await x.journal.list()).length, 1);
  } finally { await cleanup(x.root); }
});

test("corrupted journal record fails closed instead of replaying a mutation", async () => {
  const x = await setup();
  try {
    const path = join(x.work, "corrupt.txt");
    const { spec, hooks } = await planFileOperation({ sessionId: "s", turnRef: "t", operationKey: "cor1", action: "write", path, content: "value" });
    const seed = (await import("../index.mjs")).buildOperation(spec);
    await x.journal.save({ ...seed, status: "NOT_A_REAL_STATUS", created_at: "a", started_at: "a", completed_at: null, result_reference: null, attempt: 1 });
    await assert.rejects(() => x.safety.execute(spec, hooks), AmbiguousExternalActionError);
    assert.equal(await hashFile(path), ABSENT);
  } finally { await cleanup(x.root); }
});

test("crash boundary D: mutation landed, COMPLETED missing, no repeat after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-fs-crashD-"));
  try {
    const journalRoot = join(root, "journal");
    const target = join(root, "target.txt");
    const counter = join(root, "writes.log");
    const fixture = join(root, "child.mjs");
    const indexUrl = new URL("../index.mjs", import.meta.url).href;
    const fileUrl = new URL("../file-safety.mjs", import.meta.url).href;

    // The child performs a real atomic write, appends to a counter, then dies
    // by SIGKILL before COMPLETED can be persisted.
    await writeFile(fixture, `
import { appendFile } from "node:fs/promises";
import { ActionSafety, OperationJournal } from ${JSON.stringify(indexUrl)};
import { planFileOperation } from ${JSON.stringify(fileUrl)};
const journal = new OperationJournal(${JSON.stringify(journalRoot)});
const safety = new ActionSafety({ journal });
const plan = await planFileOperation({ sessionId: "s", turnRef: "t", operationKey: "crashD", action: "write", path: ${JSON.stringify(target)}, content: "landed" });
await safety.execute(plan.spec, { ...plan.hooks, invoke: async operation => { const r = await plan.hooks.invoke(operation); await appendFile(${JSON.stringify(counter)}, "w"); return r; } });
`);
    const child = await new Promise(resolve => {
      const proc = spawn(process.execPath, [fixture], { env: { ...process.env, PI_ACTION_SAFETY_FAULT: "after_external" } });
      proc.on("close", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(child.signal, "SIGKILL");
    assert.equal(await readFile(counter, "utf8"), "w");
    assert.equal(await readFile(target, "utf8"), "landed");

    const journal = new OperationJournal(journalRoot);
    const [record] = await journal.list();
    assert.equal(record.status, "STARTED");

    // Fresh process: reconciliation must recognise the landed write.
    const safety = new ActionSafety({ journal });
    const plan = await planFileOperation({ sessionId: "s", turnRef: "t", operationKey: "crashD", action: "write", path: target, content: "landed" });
    let reinvoked = 0;
    const recovered = await safety.execute(plan.spec, { ...plan.hooks, invoke: async () => { reinvoked += 1; throw new Error("must not rewrite"); } });
    assert.equal(recovered.reconciled, true);
    assert.equal(reinvoked, 0);
    assert.equal(await readFile(counter, "utf8"), "w", "the mutation must not have run twice");
    assert.equal((await journal.get(record.operation_id)).status, "COMPLETED");
  } finally { await cleanup(root); }
});

test("crash boundary D for an opaque shell append yields UNKNOWN, not a duplicate line", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sh-crashD-"));
  try {
    const journalRoot = join(root, "journal");
    const log = join(root, "log.txt");
    const fixture = join(root, "child.mjs");
    await writeFile(log, "");
    const indexUrl = new URL("../index.mjs", import.meta.url).href;
    const shellUrl = new URL("../shell-safety.mjs", import.meta.url).href;
    await writeFile(fixture, `
import { ActionSafety, OperationJournal } from ${JSON.stringify(indexUrl)};
import { planShellCommand } from ${JSON.stringify(shellUrl)};
const journal = new OperationJournal(${JSON.stringify(journalRoot)});
const safety = new ActionSafety({ journal });
const plan = planShellCommand({ sessionId: "s", turnRef: "t", operationKey: "crashSh", command: "echo entry >> " + ${JSON.stringify(log)}, journal });
await safety.execute(plan.spec, plan.hooks);
`);
    const child = await new Promise(resolve => {
      const proc = spawn(process.execPath, [fixture], { env: { ...process.env, PI_ACTION_SAFETY_FAULT: "after_external" } });
      proc.on("close", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(child.signal, "SIGKILL");
    assert.equal(await readFile(log, "utf8"), "entry\n");

    const journal = new OperationJournal(journalRoot);
    const safety = new ActionSafety({ journal });
    const plan = planShellCommand({ sessionId: "s", turnRef: "t", operationKey: "crashSh", command: `echo entry >> ${log}`, journal });
    await assert.rejects(() => safety.execute(plan.spec, plan.hooks), AmbiguousExternalActionError);
    assert.equal(await readFile(log, "utf8"), "entry\n", "the append must not be duplicated");
  } finally { await cleanup(root); }
});

test("full process-tree loss recovers from journal plus filesystem state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-tree-loss-"));
  try {
    const journalRoot = join(root, "journal");
    const target = join(root, "file.txt");
    // Simulate a journal left behind by a process tree that no longer exists.
    await atomicWrite(target, "content");
    const journal = new OperationJournal(journalRoot);
    const safety = new ActionSafety({ journal });
    const plan = await planFileOperation({ sessionId: "s", turnRef: "t", operationKey: "loss", action: "write", path: target, content: "content" });
    const seed = (await import("../index.mjs")).buildOperation(plan.spec);
    await journal.save({ ...seed, status: "STARTED", created_at: "a", started_at: "a", completed_at: null, result_reference: null, attempt: 1, child: { pid: 999999, start_ticks: "1" } });
    const recovered = await safety.execute(plan.spec, { ...plan.hooks, invoke: async () => { throw new Error("must not rewrite"); } });
    assert.equal(recovered.reconciled, true);
  } finally { await cleanup(root); }
});

for (const point of ["before_planned", "after_planned", "after_started", "after_completed"]) {
  test(`file mutation crash boundary ${point} is deterministic and never duplicates`, async () => {
    const root = await mkdtemp(join(tmpdir(), `pi-fs-${point}-`));
    try {
      const journalRoot = join(root, "journal");
      const target = join(root, "t.txt");
      const counter = join(root, "count.log");
      const fixture = join(root, "child.mjs");
      const indexUrl = new URL("../index.mjs", import.meta.url).href;
      const fileUrl = new URL("../file-safety.mjs", import.meta.url).href;
      await writeFile(fixture, `
import { appendFile } from "node:fs/promises";
import { ActionSafety, OperationJournal } from ${JSON.stringify(indexUrl)};
import { planFileOperation } from ${JSON.stringify(fileUrl)};
const journal = new OperationJournal(${JSON.stringify(journalRoot)});
const safety = new ActionSafety({ journal });
const plan = await planFileOperation({ sessionId: "s", turnRef: "t", operationKey: "bnd", action: "write", path: ${JSON.stringify(target)}, content: "value" });
await safety.execute(plan.spec, { ...plan.hooks, invoke: async op => { const r = await plan.hooks.invoke(op); await appendFile(${JSON.stringify(counter)}, "w"); return r; } });
`);
      await new Promise(resolve => {
        const proc = spawn(process.execPath, [fixture], { env: { ...process.env, PI_ACTION_SAFETY_FAULT: point } });
        proc.on("close", (code, signal) => resolve({ code, signal }));
      });
      const writesBefore = await readFile(counter, "utf8").catch(() => "");

      const journal = new OperationJournal(journalRoot);
      const safety = new ActionSafety({ journal });
      const plan = await planFileOperation({ sessionId: "s", turnRef: "t", operationKey: "bnd", action: "write", path: target, content: "value" });
      let outcome = "ok";
      try { await safety.execute(plan.spec, plan.hooks); } catch (error) { outcome = error.name; }
      const writesAfter = await readFile(counter, "utf8").catch(() => "");

      // Whatever the boundary, the mutation must never be applied twice.
      assert.ok(writesAfter.length <= 1, `${point}: expected at most one mutation, saw ${writesAfter.length}`);
      if (writesBefore.length === 1) assert.equal(writesAfter.length, 1, `${point}: landed write must not be repeated`);
      assert.ok(["ok", "AmbiguousExternalActionError"].includes(outcome), `${point}: unexpected outcome ${outcome}`);
      if (writesAfter.length === 1) assert.equal(await readFile(target, "utf8"), "value");
    } finally { await cleanup(root); }
  });
}

test("git commit is reconciled through HEAD instead of committing twice", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-git-safety-"));
  try {
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const sh = command => new Promise((resolve, reject) => {
      const proc = spawn("/data/data/com.termux/files/usr/bin/bash", ["-c", command], { cwd: repo, stdio: ["ignore", "pipe", "pipe"] });
      let out = "", err = "";
      proc.stdout.on("data", c => { out += c; });
      proc.stderr.on("data", c => { err += c; });
      proc.on("close", code => code === 0 ? resolve(out.trim()) : reject(new Error(err || out)));
    });
    await sh("git init -q && git config user.email t@e && git config user.name t");
    await writeFile(join(repo, "f.txt"), "x");
    await sh("git add f.txt && git commit -q -m 'seed'");

    const journal = new OperationJournal(join(root, "journal"));
    const safety = new ActionSafety({ journal });
    const message = "safety-commit";
    await writeFile(join(repo, "g.txt"), "y");
    await sh("git add g.txt");

    const verify = async () => {
      const log = await sh("git log --oneline --format=%s -n 5");
      return log.split("\n").includes(message)
        ? { state: "completed", result: { status: "commit_present" } }
        : { state: "retry", reason: "commit absent" };
    };
    const plan = planShellCommand({ sessionId: "s", turnRef: "t", operationKey: "gc1", command: `git commit -q -m ${message}`, cwd: repo, journal, verify });
    assert.equal(plan.classification, CLASS.RECONCILABLE_MUTATION);
    await safety.execute(plan.spec, plan.hooks);
    const countAfterFirst = Number(await sh("git rev-list --count HEAD"));

    // Simulate a crash before COMPLETED and recover: no second commit.
    const { buildOperation } = await import("../index.mjs");
    const seed = buildOperation(plan.spec);
    await journal.save({ ...(await journal.get(seed.operation_id)), status: "STARTED" });
    const recovered = await safety.execute(plan.spec, plan.hooks);
    assert.equal(recovered.reconciled, true);
    assert.equal(Number(await sh("git rev-list --count HEAD")), countAfterFirst);
  } finally { await cleanup(root); }
});

test("journal survives a truncated record, a stale lock, and a killed writer", async () => {
  const x = await setup();
  try {
    const path = join(x.work, "j.txt");
    const plan = await planFileOperation({ sessionId: "s", turnRef: "t", operationKey: "j1", action: "write", path, content: "v" });
    const result = await x.safety.execute(plan.spec, plan.hooks);
    const file = x.journal.path(result.operation.operation_id);

    // An interrupted temp write must be ignored, not read as state.
    await writeFile(`${file}.partial.tmp`, "{trunc", { mode: 0o600 });
    assert.equal((await x.journal.get(result.operation.operation_id)).status, "COMPLETED");

    // A stale lock file must not deadlock a fresh process.
    await writeFile(join(x.journal.root, ".journal.lock"), String(999999), { mode: 0o600 });
    const second = await planFileOperation({ sessionId: "s", turnRef: "t", operationKey: "j2", action: "write", path: join(x.work, "j2.txt"), content: "v2" });
    await x.safety.execute(second.spec, second.hooks);

    // Invalid JSON in a record must fail closed rather than replay.
    await writeFile(file, "{ not json", { mode: 0o600 });
    const replay = await planFileOperation({ sessionId: "s", turnRef: "t", operationKey: "j1", action: "write", path, content: "v" });
    await assert.rejects(() => x.safety.execute(replay.spec, replay.hooks), AmbiguousExternalActionError);
  } finally { await cleanup(x.root); }
});

test("http write classification drives replay policy end to end", async () => {
  const x = await setup();
  try {
    const post = planShellCommand({ sessionId: "s", turnRef: "t", operationKey: "h1", command: "curl -X POST https://api.example.com/orders -d id=1", journal: x.journal });
    assert.equal(post.classification, CLASS.OPAQUE);
    const { buildOperation } = await import("../index.mjs");
    const seed = buildOperation(post.spec);
    await x.journal.save({ ...seed, status: "STARTED", created_at: "a", started_at: "a", completed_at: null, result_reference: null, attempt: 1 });
    await assert.rejects(() => x.safety.execute(post.spec, post.hooks), AmbiguousExternalActionError);

    const del = planShellCommand({ sessionId: "s", turnRef: "t", operationKey: "h2", command: "curl -X DELETE https://api.example.com/orders/1", journal: x.journal });
    assert.equal(del.classification, CLASS.RECONCILABLE_MUTATION);
  } finally { await cleanup(x.root); }
});
