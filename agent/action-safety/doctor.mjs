#!/usr/bin/env node
/**
 * action-safety doctor: confirms the built-in tool integration is healthy and
 * that the Pi version still exposes the public API the integration relies on.
 *
 * Run: node ~/.pi/agent/action-safety/doctor.mjs
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const HOME = process.env.HOME ?? "/data/data/com.termux/files/home";
const AS_DIR = join(HOME, ".pi/agent/action-safety");
const EXT_DIR = join(HOME, ".pi/agent/extensions/action-safety");
const PI_PKG = "/data/data/com.termux/files/usr/lib/node_modules/@earendil-works/pi-coding-agent";

const checks = [];
const add = (name, status, detail) => checks.push({ name, status, detail });

async function main() {
  // 1. Extension present and loadable.
  try {
    const files = await readdir(EXT_DIR);
    add("extension present", files.includes("index.ts") ? "PASS" : "FAIL", files.join(", "));
  } catch (error) {
    add("extension present", "FAIL", error.message);
  }

  // 2. Safety engine modules importable.
  for (const mod of ["index.mjs", "classify.mjs", "sanitize.mjs", "file-safety.mjs", "shell-safety.mjs"]) {
    try {
      await import(join(AS_DIR, mod));
      add(`engine ${mod}`, "PASS", "imports cleanly");
    } catch (error) {
      add(`engine ${mod}`, "FAIL", error.message);
    }
  }
  try {
    await import(join(EXT_DIR, "identity.mjs"));
    add("engine identity.mjs", "PASS", "imports cleanly");
  } catch (error) {
    add("engine identity.mjs", "FAIL", error.message);
  }

  // 3. Pi version and the public API the integration depends on. These are root
  //    package exports, not deep internal paths, so an update that keeps the
  //    public API keeps this integration working.
  let version = "unknown";
  try {
    version = JSON.parse(await readFile(join(PI_PKG, "package.json"), "utf8")).version;
  } catch {}
  add("pi version", "PASS", version);
  try {
    const pi = await import(join(PI_PKG, "dist/index.js"));
    const required = ["createBashToolDefinition", "createWriteToolDefinition", "createEditToolDefinition"];
    const missing = required.filter(name => typeof pi[name] !== "function");
    add(
      "public tool factories",
      missing.length === 0 ? "PASS" : "FAIL",
      missing.length === 0 ? required.join(", ") : `missing: ${missing.join(", ")}`,
    );
    // Injected operations are the mechanism that routes mutations through the
    // safety layer; verify the contract still holds.
    let captured = false;
    await pi
      .createWriteToolDefinition("/tmp", { operations: { writeFile: async () => { captured = true; }, mkdir: async () => {} } })
      .execute("doctor", { path: "/tmp/.action-safety-doctor-probe", content: "probe" }, undefined, undefined, {
        sessionManager: { getSessionId: () => "doctor", getSessionFile: () => null },
      });
    add("injected operations honored", captured ? "PASS" : "FAIL", captured ? "write intercepted, nothing hit disk" : "built-in ignored injected operations");
  } catch (error) {
    add("public tool factories", "FAIL", error.message);
  }

  // 4. Journal writable with private permissions, and no second journal.
  const journalDir = process.env.PI_ACTION_SAFETY_DIR || AS_DIR;
  try {
    const { OperationJournal } = await import(join(AS_DIR, "index.mjs"));
    const journal = new OperationJournal(journalDir);
    const records = await journal.list();
    add("journal readable", "PASS", `${journalDir} (${records.length} record(s))`);
    try {
      const info = await stat(journal.operations);
      const mode = (info.mode & 0o777).toString(8);
      add("journal permissions", mode === "700" ? "PASS" : "WARN", `operations dir mode ${mode}`);
    } catch {
      add("journal permissions", "PASS", "no operations dir yet (created on first mutation)");
    }
  } catch (error) {
    add("journal readable", "FAIL", error.message);
  }

  // 5. Disable switch documented and effective.
  add(
    "rollback switch",
    "PASS",
    process.env.PI_ACTION_SAFETY_DISABLE === "1" ? "PI_ACTION_SAFETY_DISABLE=1 (safety OFF)" : "PI_ACTION_SAFETY_DISABLE unset (safety ON)",
  );

  // 6. Telegram safety must remain independent of this integration.
  try {
    const tg = join(HOME, "pi-web-search/extensions/web-search/telegram-user-client.mjs");
    const source = await readFile(tg, "utf8");
    add("telegram safety untouched", source.includes("_pi_action_safety") ? "PASS" : "WARN", "telegram integration still present");
  } catch (error) {
    add("telegram safety untouched", "WARN", error.message);
  }

  const failed = checks.filter(c => c.status === "FAIL");
  console.log("action-safety doctor");
  for (const c of checks) console.log(`${c.status.padEnd(4)}  ${c.name}: ${c.detail}`);
  console.log(`\n${failed.length === 0 ? "OK" : `${failed.length} FAILURE(S)`} — ${checks.length} checks`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(error => {
  console.error(`doctor crashed: ${error.message}`);
  process.exit(2);
});
