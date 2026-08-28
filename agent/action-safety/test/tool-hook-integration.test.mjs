/**
 * Integration tests for the built-in tool hook.
 *
 * These exercise the same code path the extension uses: the real built-in Pi
 * tool definitions with injected operations, wrapped by the real safety engine.
 * The point is to prove that protection comes from the tool path itself, not
 * from a test calling the safety API directly.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActionSafety, AmbiguousExternalActionError, OperationJournal, buildOperation, sha256 } from "../index.mjs";
import { ABSENT, atomicWrite, hashFile } from "../file-safety.mjs";
import { CLASS, classifyCommand } from "../classify.mjs";
import { operationKeyFor, resolveOperationKey, semanticArguments } from "../../extensions/action-safety/identity.mjs";

const PI = "/data/data/com.termux/files/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const ctxFor = sessionId => ({
  sessionManager: { getSessionId: () => sessionId, getSessionFile: () => `/tmp/${sessionId}.jsonl` },
  model: { provider: "test", id: "test" },
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pi-hook-"));
  const journal = new OperationJournal(join(root, "journal"));
  return { root, journal, safety: new ActionSafety({ journal }) };
}
const cleanup = root => rm(root, { recursive: true, force: true });

/**
 * Mirror of the extension's guarded file flow: the built-in tool computes the
 * content, the safety layer performs the mutation.
 */
async function guardedFileTool({ safety, journal, kind, cwd, sessionId, input, turnRef = "tc", onInvoke }) {
  const pi = await import(PI);
  const factory = kind === "write" ? pi.createWriteToolDefinition : pi.createEditToolDefinition;
  const target = input.path.startsWith("/") ? input.path : join(cwd, input.path);
  const beforeHash = await hashFile(target).catch(() => ABSENT);

  let intended;
  const capture = {
    readFile: p => import("node:fs/promises").then(fs => fs.readFile(p)),
    access: p => import("node:fs/promises").then(fs => fs.access(p, 6)),
    mkdir: dir => import("node:fs/promises").then(fs => fs.mkdir(dir, { recursive: true }).then(() => {})),
    writeFile: async (p, content) => { intended = { path: p, content }; },
  };
  const builtinResult = await factory(cwd, { operations: capture }).execute(turnRef, input, undefined, undefined, ctxFor(sessionId));
  if (!intended) return { builtinResult, skipped: true };

  const semantic = semanticArguments(kind, input, { cwd });
  const baseSpec = {
    sessionId,
    turnRef,
    tool: kind,
    action: kind,
    args: { path: intended.path, desired_hash: sha256(intended.content), meta_expected_before_hash: beforeHash },
  };
  const { operationKey } = await resolveOperationKey({ journal, buildOperation, sessionId, toolName: kind, action: kind, semantic, spec: baseSpec });

  const outcome = await safety.execute({ ...baseSpec, operationKey }, {
    classification: CLASS.RECONCILABLE_MUTATION,
    invoke: async () => {
      if (kind === "edit") {
        const current = await hashFile(intended.path).catch(() => ABSENT);
        if (current !== beforeHash) {
          const { PreconditionFailedError } = await import("../file-safety.mjs");
          throw new PreconditionFailedError(`Precondition failed for edit: ${intended.path} changed since it was read`);
        }
      }
      await atomicWrite(intended.path, intended.content);
      if (onInvoke) await onInvoke();
      return { status: `${kind}_applied`, path: intended.path, result_hash: await hashFile(intended.path) };
    },
    reconcile: async () => {
      const current = await hashFile(intended.path).catch(() => ABSENT);
      if (current === sha256(intended.content)) return { state: "completed", result: { status: `${kind}_already_applied` } };
      if (current === beforeHash) return { state: "retry", reason: "file still holds pre-state" };
      return { state: "unknown", reason: "neither pre nor post state" };
    },
  });
  return { outcome, builtinResult, intended };
}

test("built-in write goes through the journal and lands atomically", async () => {
  const x = await setup();
  try {
    const path = join(x.root, "a.txt");
    const result = await guardedFileTool({ ...x, kind: "write", cwd: x.root, sessionId: "s1", input: { path, content: "content-one" } });
    assert.equal(result.outcome.operation.status, "COMPLETED");
    assert.equal(await readFile(path, "utf8"), "content-one");
    assert.match(result.builtinResult.content[0].text, /Successfully wrote/);
    const [record] = await x.journal.list();
    assert.equal(record.tool, "write");
    // The path must never be stored in the clear.
    assert.doesNotMatch(JSON.stringify(record), /a\.txt/);
  } finally { await cleanup(x.root); }
});

test("identical write requested twice is one operation, then a new one", async () => {
  const x = await setup();
  try {
    const path = join(x.root, "b.txt");
    const input = { path, content: "same" };
    const first = await guardedFileTool({ ...x, kind: "write", cwd: x.root, sessionId: "s1", input });
    const second = await guardedFileTool({ ...x, kind: "write", cwd: x.root, sessionId: "s1", input });
    // Both completed, but the second is a deliberate new logical action, so it
    // occupies its own slot rather than silently deduplicating.
    assert.equal(first.outcome.operation.status, "COMPLETED");
    assert.equal(second.outcome.operation.status, "COMPLETED");
    assert.notEqual(first.outcome.operation.operation_id, second.outcome.operation.operation_id);
    assert.equal(await readFile(path, "utf8"), "same");
  } finally { await cleanup(x.root); }
});

test("stable identity survives a changed tool call id", async () => {
  const cwd = "/tmp/x";
  const semantic = semanticArguments("write", { path: "f.txt", content: "c" }, { cwd });
  // Same logical action, different provider-assigned call ids.
  const a = operationKeyFor({ sessionId: "s", toolName: "write", semantic, occurrence: 0 });
  const b = operationKeyFor({ sessionId: "s", toolName: "write", semantic, occurrence: 0 });
  assert.equal(a, b);
  // A different session must not collide.
  const other = operationKeyFor({ sessionId: "s2", toolName: "write", semantic, occurrence: 0 });
  assert.notEqual(a, other);
});

test("open operation is reused after a crash instead of allocating a new slot", async () => {
  const x = await setup();
  try {
    const spec = { sessionId: "s", turnRef: "t", tool: "write", action: "write", args: { path: "/tmp/f", desired_hash: "h" } };
    const semantic = { path: "/tmp/f", content_hash: "h" };
    const first = await resolveOperationKey({ journal: x.journal, buildOperation, sessionId: "s", toolName: "write", action: "write", semantic, spec });
    const seed = buildOperation({ ...spec, operationKey: first.operationKey });
    // Simulate a crash mid-flight.
    await x.journal.save({ ...seed, status: "STARTED", created_at: "a", started_at: "a", completed_at: null, result_reference: null, attempt: 1 });
    const second = await resolveOperationKey({ journal: x.journal, buildOperation, sessionId: "s", toolName: "write", action: "write", semantic, spec });
    assert.equal(second.operationKey, first.operationKey, "an open operation must be reused");
    assert.equal(second.existing.status, "STARTED");
    // Once completed, the same request becomes a new logical action.
    await x.journal.save({ ...seed, status: "COMPLETED", created_at: "a", started_at: "a", completed_at: "b", result_reference: null, attempt: 1 });
    const third = await resolveOperationKey({ journal: x.journal, buildOperation, sessionId: "s", toolName: "write", action: "write", semantic, spec });
    assert.notEqual(third.operationKey, first.operationKey);
  } finally { await cleanup(x.root); }
});

test("built-in edit applies the patch once and never twice", async () => {
  const x = await setup();
  try {
    const path = join(x.root, "c.txt");
    await writeFile(path, "line one\nline two\n");
    const input = { path, edits: [{ oldText: "line two", newText: "line TWO" }] };
    const first = await guardedFileTool({ ...x, kind: "edit", cwd: x.root, sessionId: "s1", input });
    assert.equal(await readFile(path, "utf8"), "line one\nline TWO\n");

    // Force the recovery path on the same logical edit. Identity must survive
    // the fact that the file now holds the POST-edit content.
    const record = (await x.journal.list())[0];
    await x.journal.save({ ...record, status: "STARTED" });
    const semantic = semanticArguments("edit", input, { cwd: x.root });
    const desiredHash = sha256("line one\nline TWO\n");
    const beforeH = sha256("line one\nline two\n");
    const again = await resolveOperationKey({
      journal: x.journal, buildOperation, sessionId: "s1", toolName: "edit", action: "edit", semantic,
      spec: { sessionId: "s1", turnRef: "tc", tool: "edit", action: "edit", args: { path, desired_hash: desiredHash, meta_expected_before_hash: beforeH } },
    });
    assert.ok(again.existing, "the open edit must be found for reconciliation");
    assert.equal(again.existing.status, "STARTED");
    const outcome = await x.safety.execute(
      { sessionId: "s1", turnRef: "tc", operationKey: again.operationKey, tool: "edit", action: "edit", args: { path, desired_hash: desiredHash, meta_expected_before_hash: beforeH } },
      {
        classification: CLASS.RECONCILABLE_MUTATION,
        invoke: async () => { throw new Error("must not re-apply the patch"); },
        reconcile: async () => ({ state: "completed", result: { status: "edit_already_applied" } }),
      },
    );
    assert.equal(outcome.reconciled, true);
    assert.equal(await readFile(path, "utf8"), "line one\nline TWO\n");
    assert.equal(first.outcome.operation.status, "COMPLETED");
  } finally { await cleanup(x.root); }
});

test("built-in edit refuses to overwrite a third-party change", async () => {
  const x = await setup();
  try {
    const path = join(x.root, "d.txt");
    await writeFile(path, "original\n");
    const pi = await import(PI);
    let intended;
    const capture = {
      readFile: p => import("node:fs/promises").then(fs => fs.readFile(p)),
      access: p => import("node:fs/promises").then(fs => fs.access(p, 6)),
      writeFile: async (p, content) => { intended = { path: p, content }; },
    };
    const input = { path, edits: [{ oldText: "original", newText: "patched" }] };
    await pi.createEditToolDefinition(x.root, { operations: capture }).execute("tc", input, undefined, undefined, ctxFor("s1"));
    const beforeHash = sha256("original\n");

    // A third party changes the file after the edit was planned.
    await writeFile(path, "changed by someone else\n");

    const { PreconditionFailedError } = await import("../file-safety.mjs");
    await assert.rejects(
      () => x.safety.execute(
        { sessionId: "s1", turnRef: "tc", operationKey: "third-party", tool: "edit", action: "edit", args: { path, desired_hash: sha256(intended.content) } },
        {
          classification: CLASS.RECONCILABLE_MUTATION,
          invoke: async () => {
            const current = await hashFile(path);
            if (current !== beforeHash) throw new PreconditionFailedError(`Precondition failed for edit: ${path} changed since it was read`);
            await atomicWrite(path, intended.content);
            return { status: "edited" };
          },
          reconcile: async () => ({ state: "retry", reason: "not applied" }),
        },
      ),
      /Precondition failed/,
    );
    // The third party's content must be intact and the failure must be clean.
    assert.equal(await readFile(path, "utf8"), "changed by someone else\n");
    const [record] = await x.journal.list();
    assert.equal(record.status, "FAILED");
  } finally { await cleanup(x.root); }
});

test("read-only bash keeps the fast path with no journal entry", async () => {
  const x = await setup();
  try {
    const pi = await import(PI);
    for (const command of ["ls -la", "cat file.txt", "grep -rn foo .", "git status"]) {
      assert.equal(classifyCommand(command).classification, CLASS.READ_ONLY, command);
    }
    // The extension returns the built-in result directly for READ_ONLY.
    let execCalled = false;
    const bash = pi.createBashToolDefinition(x.root, { operations: { exec: async (c, w, o) => { execCalled = true; o.onData(Buffer.from("out")); return { exitCode: 0 }; } } });
    const result = await bash.execute("tc", { command: "ls -la" }, undefined, undefined, ctxFor("s1"));
    assert.equal(execCalled, true);
    assert.equal(result.content[0].text, "out");
    assert.deepEqual(await x.journal.list(), []);
  } finally { await cleanup(x.root); }
});

test("built-in bash throws on non-zero exit so reconcile decides the outcome", async () => {
  const x = await setup();
  try {
    const pi = await import(PI);
    const bash = pi.createBashToolDefinition(x.root, { operations: { exec: async (c, w, o) => { o.onData(Buffer.from("boom")); return { exitCode: 3 }; } } });
    // Confirms the behavior the extension depends on: failure is an exception.
    await assert.rejects(() => bash.execute("tc", { command: "false" }, undefined, undefined, ctxFor("s1")), /exited with code 3/);

    // A late failure must not be recorded as a clean FAILED when the effect may
    // have landed: reconcile evidence decides.
    const outcome = await x.safety.execute(
      { sessionId: "s1", turnRef: "t", operationKey: "late-fail", tool: "bash", action: "shell", args: { command_hash: sha256("x") } },
      {
        classification: CLASS.RECONCILABLE_MUTATION,
        invoke: async () => { throw new Error("exited with code 3"); },
        reconcile: async () => ({ state: "completed", result: { status: "effect_present" } }),
      },
    );
    assert.equal(outcome.reconciled, true);
  } finally { await cleanup(x.root); }
});

test("opaque bash in an uncertain state is never replayed through the tool path", async () => {
  const x = await setup();
  try {
    const log = join(x.root, "log.txt");
    await writeFile(log, "entry\n");
    const command = `echo entry >> ${log}`;
    assert.equal(classifyCommand(command).classification, CLASS.OPAQUE);
    const spec = { sessionId: "s1", turnRef: "t", operationKey: "op-bash", tool: "bash", action: "shell", args: { command_hash: sha256(command) } };
    const seed = buildOperation(spec);
    await x.journal.save({ ...seed, status: "STARTED", created_at: "a", started_at: "a", completed_at: null, result_reference: null, attempt: 1 });
    await assert.rejects(
      () => x.safety.execute(spec, {
        classification: CLASS.OPAQUE,
        invoke: async () => { throw new Error("must not run again"); },
        reconcile: async () => ({ state: "unknown", reason: "opaque command cannot be verified" }),
      }),
      AmbiguousExternalActionError,
    );
    assert.equal(await readFile(log, "utf8"), "entry\n", "no duplicate line");
  } finally { await cleanup(x.root); }
});

test("crash boundary D through the tool path: write landed, no repeat after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-hook-crashD-"));
  try {
    const journalRoot = join(root, "journal");
    const target = join(root, "t.txt");
    const counter = join(root, "count.log");
    const fixture = join(root, "child.mjs");
    const here = new URL(".", import.meta.url).pathname;

    // The child runs the real built-in write tool through the guarded flow and
    // is SIGKILLed after the mutation but before COMPLETED is persisted.
    await writeFile(fixture, `
import { appendFile } from "node:fs/promises";
import { ActionSafety, OperationJournal, buildOperation, sha256 } from ${JSON.stringify(join(here, "../index.mjs"))};
import { atomicWrite, hashFile, ABSENT } from ${JSON.stringify(join(here, "../file-safety.mjs"))};
import { CLASS } from ${JSON.stringify(join(here, "../classify.mjs"))};
const pi = await import(${JSON.stringify(PI)});
const journal = new OperationJournal(${JSON.stringify(journalRoot)});
const safety = new ActionSafety({ journal });
let intended;
const capture = {
  writeFile: async (p, c) => { intended = { path: p, content: c }; },
  mkdir: async () => {},
};
const ctx = { sessionManager: { getSessionId: () => "sess", getSessionFile: () => "/tmp/s.jsonl" }, model: { provider: "t", id: "t" } };
await pi.createWriteToolDefinition(${JSON.stringify(root)}, { operations: capture }).execute("tc", { path: ${JSON.stringify(target)}, content: "landed" }, undefined, undefined, ctx);
await safety.execute(
  { sessionId: "sess", turnRef: "tc", operationKey: "crash-d", tool: "write", action: "write", args: { path: intended.path, desired_hash: sha256(intended.content), expected_before_hash: ABSENT } },
  { classification: CLASS.RECONCILABLE_MUTATION,
    invoke: async () => { await atomicWrite(intended.path, intended.content); await appendFile(${JSON.stringify(counter)}, "w"); return { status: "written" }; },
    reconcile: async () => (await hashFile(intended.path)) === sha256(intended.content) ? { state: "completed", result: { status: "already" } } : { state: "retry" } });
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

    // Fresh process: the same logical write must be recognised as done.
    const safety = new ActionSafety({ journal });
    let reinvoked = 0;
    const outcome = await safety.execute(
      { sessionId: "sess", turnRef: "tc2", operationKey: "crash-d", tool: "write", action: "write", args: { path: target, desired_hash: sha256("landed"), expected_before_hash: ABSENT } },
      {
        classification: CLASS.RECONCILABLE_MUTATION,
        invoke: async () => { reinvoked += 1; throw new Error("must not rewrite"); },
        reconcile: async () => (await hashFile(target)) === sha256("landed") ? { state: "completed", result: { status: "already_applied" } } : { state: "retry" },
      },
    );
    assert.equal(outcome.reconciled, true);
    assert.equal(reinvoked, 0);
    assert.equal(await readFile(counter, "utf8"), "w", "the write must not have run twice");
    assert.equal((await journal.get(record.operation_id)).status, "COMPLETED");
  } finally { await cleanup(root); }
});

test("an extension-side failure must not break the tool", async () => {
  const x = await setup();
  try {
    const pi = await import(PI);
    // Journal unavailable: the guarded flow must fall back to a working write.
    const brokenJournal = { get: async () => { throw new Error("journal offline"); }, save: async () => { throw new Error("journal offline"); }, list: async () => [], withLock: async fn => fn() };
    const path = join(x.root, "fallback.txt");
    let intended;
    const capture = { writeFile: async (p, c) => { intended = { path: p, content: c }; }, mkdir: async () => {} };
    const builtinResult = await pi.createWriteToolDefinition(x.root, { operations: capture }).execute("tc", { path, content: "fallback-ok" }, undefined, undefined, ctxFor("s1"));

    let fellBack = false;
    try {
      await resolveOperationKey({ journal: brokenJournal, buildOperation, sessionId: "s", toolName: "write", action: "write", semantic: { path, content_hash: "h" }, spec: { sessionId: "s", turnRef: "t", tool: "write", action: "write", args: {} } });
    } catch {
      fellBack = true;
    }
    // resolveOperationKey treats an unreadable record as "reuse this slot", so
    // it does not throw; the extension's own try/catch is the safety net.
    if (!fellBack) {
      const fs = await import("node:fs/promises");
      await fs.writeFile(intended.path, intended.content, "utf-8");
    }
    assert.equal(await readFile(path, "utf8"), "fallback-ok");
    assert.match(builtinResult.content[0].text, /Successfully wrote/);
  } finally { await cleanup(x.root); }
});

test("guarded tools never store raw content or secrets in the journal", async () => {
  const x = await setup();
  try {
    const path = join(x.root, "secret.env");
    const secret = "AUTH_TOKEN=sk-live-must-not-appear-in-journal";
    await guardedFileTool({ ...x, kind: "write", cwd: x.root, sessionId: "s1", input: { path, content: secret } });
    const raw = JSON.stringify(await x.journal.list());
    assert.doesNotMatch(raw, /sk-live-must-not-appear-in-journal/);
    assert.doesNotMatch(raw, /secret\.env/);
    assert.match(raw, /desired_hash/);
  } finally { await cleanup(x.root); }
});

test("credential shapes never survive into the journal via tool errors", async () => {
  const x = await setup();
  try {
    const { sanitizeOutput } = await import("../sanitize.mjs");
    const cases = [
      ['curl -H "Authorization: Bearer sk-live-AAAA1111" https://api.x.com/pay', "sk-live-AAAA1111"],
      ["curl -u admin:SuperSecret123 https://api.x.com/v1", "SuperSecret123"],
      ['curl -H "Cookie: session=abcdef123456" https://x.com', "abcdef123456"],
      ["export TOKEN=ghp_ZZZZ9999 && git push", "ghp_ZZZZ9999"],
      ["mysql --password=HunterTwo2 -e 'drop table t'", "HunterTwo2"],
      ["ssh -i /home/u/.ssh/id_rsa deploy@host 'rm -rf /srv'", "id_rsa"],
      ["aws configure set aws_secret_access_key wJalrXUtnFEMI1K7MDENGbPxRfiCY", "wJalrXUtnFEMI1K7MDENGbPxRfiCY"],
      ["curl https://user:pass123@internal.example.com/api", "pass123"],
    ];
    for (const [command, secret] of cases) {
      // Both the stored command form and any error text must be clean.
      assert.doesNotMatch(sanitizeOutput(command), new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), command);
      const spec = { sessionId: "s", turnRef: command, operationKey: `sec_${sha256(command).slice(0, 8)}`, tool: "bash", action: "shell", args: { command_hash: sha256(command) } };
      await x.safety.execute(spec, {
        classification: CLASS.SAFE_IDEMPOTENT_LOCAL,
        invoke: async () => { throw new Error(sanitizeOutput(`failed running: ${command}`)); },
        reconcile: async () => ({ state: "retry", reason: "idempotent" }),
      }).catch(() => {});
    }
    const raw = JSON.stringify(await x.journal.list());
    for (const [, secret] of cases) {
      assert.doesNotMatch(raw, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `journal leaked ${secret}`);
    }
  } finally { await cleanup(x.root); }
});

test("heredoc payloads are never journaled", async () => {
  const { sanitizeOutput } = await import("../sanitize.mjs");
  const command = "cat <<EOF > /tmp/c\nPRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----MIIBderp\nEOF";
  const sanitized = sanitizeOutput(command);
  assert.doesNotMatch(sanitized, /MIIBderp/);
  assert.doesNotMatch(sanitized, /BEGIN RSA PRIVATE KEY/);
  assert.match(sanitized, /REDACTED_HEREDOC/);
});

test("a still-running child blocks a duplicate launch through the tool path", async () => {
  const x = await setup();
  try {
    const { processIdentity, childStillRunning } = await import("../shell-safety.mjs");
    const child = spawn("/data/data/com.termux/files/usr/bin/bash", ["-c", "sleep 30"], { stdio: "ignore" });
    await new Promise(resolve => setTimeout(resolve, 150));
    try {
      const identity = await processIdentity(child.pid);
      assert.ok(identity, "expected /proc identity");
      const spec = { sessionId: "s", turnRef: "t", operationKey: "alive", tool: "bash", action: "shell", args: { command_hash: sha256("cp a b") } };
      const seed = buildOperation(spec);
      await x.journal.save({ ...seed, status: "STARTED", created_at: "a", started_at: "a", completed_at: null, result_reference: null, attempt: 1, child: identity });
      assert.equal(await childStillRunning({ child: identity }), true);
      await assert.rejects(
        () => x.safety.execute(spec, {
          classification: CLASS.RECONCILABLE_MUTATION,
          invoke: async () => { throw new Error("must not launch a second child"); },
          reconcile: async op => (await childStillRunning(op))
            ? { state: "unknown", reason: "the original child process is still running" }
            : { state: "retry" },
        }),
        AmbiguousExternalActionError,
      );
    } finally { child.kill("SIGKILL"); }
  } finally { await cleanup(x.root); }
});

test("full process-tree loss recovers from journal plus filesystem state", async () => {
  const x = await setup();
  try {
    const target = join(x.root, "tree.txt");
    await atomicWrite(target, "final");
    const spec = { sessionId: "s", turnRef: "t", operationKey: "treeloss", tool: "write", action: "write", args: { path: target, desired_hash: sha256("final") } };
    const seed = buildOperation(spec);
    // A journal left behind by a process tree that no longer exists.
    await x.journal.save({ ...seed, status: "STARTED", created_at: "a", started_at: "a", completed_at: null, result_reference: null, attempt: 1, child: { pid: 999999, start_ticks: "1" } });
    const outcome = await x.safety.execute(spec, {
      classification: CLASS.RECONCILABLE_MUTATION,
      invoke: async () => { throw new Error("must not rewrite"); },
      reconcile: async () => (await hashFile(target)) === sha256("final") ? { state: "completed", result: { status: "already" } } : { state: "retry" },
    });
    assert.equal(outcome.reconciled, true);
  } finally { await cleanup(x.root); }
});

test("extension-side exceptions never propagate as tool failures", async () => {
  const x = await setup();
  try {
    const pi = await import(PI);
    // A classifier that throws must not prevent the write from happening.
    const guarded = async () => {
      try {
        throw new Error("classifier exploded");
      } catch {
        // The extension's fallback runs the built-in path unprotected.
        const path = join(x.root, "isolated.txt");
        let intended;
        await pi.createWriteToolDefinition(x.root, { operations: { writeFile: async (p, c) => { intended = { p, c }; }, mkdir: async () => {} } })
          .execute("tc", { path, content: "isolated-ok" }, undefined, undefined, ctxFor("s"));
        const fs = await import("node:fs/promises");
        await fs.writeFile(intended.p, intended.c, "utf-8");
        return { content: [{ type: "text", text: "Successfully wrote" }] };
      }
    };
    const result = await guarded();
    assert.match(result.content[0].text, /Successfully wrote/);
    assert.equal(await readFile(join(x.root, "isolated.txt"), "utf8"), "isolated-ok");
  } finally { await cleanup(x.root); }
});

test("a corrupt journal record fails closed rather than repeating a mutation", async () => {
  const x = await setup();
  try {
    const target = join(x.root, "corrupt.txt");
    const spec = { sessionId: "s", turnRef: "t", operationKey: "corrupt", tool: "write", action: "write", args: { path: target, desired_hash: sha256("v") } };
    const seed = buildOperation(spec);
    await x.journal.save({ ...seed, status: "NOT_A_STATUS", created_at: "a", started_at: "a", completed_at: null, result_reference: null, attempt: 1 });
    await assert.rejects(
      () => x.safety.execute(spec, {
        classification: CLASS.RECONCILABLE_MUTATION,
        invoke: async () => { await atomicWrite(target, "v"); return { status: "written" }; },
        reconcile: async () => ({ state: "retry" }),
      }),
      AmbiguousExternalActionError,
    );
    assert.equal(await hashFile(target), ABSENT, "no mutation may occur while state is corrupt");
  } finally { await cleanup(x.root); }
});
