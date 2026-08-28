#!/usr/bin/env node
/**
 * Return one Yunma API key from a newline-delimited keyring in round-robin order.
 *
 * Keyring format: one key per line; blank lines and lines beginning with # are ignored.
 * Add a key by appending it to ~/.pi/agent/secrets/yunma-api-key.
 * The optional environment variables make isolated, non-secret tests possible:
 *   YUNMA_KEY_FILE, YUNMA_KEY_ROTATION_STATE
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const home = process.env.HOME;
const keyFile = process.env.YUNMA_KEY_FILE ?? path.join(home, ".pi", "agent", "secrets", "yunma-api-key");
const stateFile = process.env.YUNMA_KEY_ROTATION_STATE ?? path.join(home, ".pi", "agent", "state", "yunma-key-rotation.json");
const lockDir = `${stateFile}.lock`;
const debugLog = process.env.YUNMA_KEY_DEBUG_LOG ?? path.join(path.dirname(stateFile), "yunma-key-rotation.log");

function fail(message) {
  process.stderr.write(`yunma-key-rotate: ${message}\n`);
  process.exit(1);
}

function readKeys() {
  let contents;
  try {
    contents = fs.readFileSync(keyFile, "utf8");
  } catch (error) {
    fail(`cannot read keyring (${error.code ?? error.message})`);
  }
  const keys = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (!keys.length) fail("keyring has no usable keys");
  return keys;
}

function acquireLock() {
  fs.mkdirSync(path.dirname(lockDir), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 2000;
  while (true) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      return;
    } catch (error) {
      if (error.code !== "EEXIST" || Date.now() >= deadline) fail("timed out waiting for rotation lock");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

function nextKey(keys) {
  const pid = process.ppid || process.pid; // caller process: all child script calls share it
  const now = Date.now();
  const TTL_MS = 60000; // keep returning the same key for repeated calls from the same caller process
  let index = 0;
  let lastKeyIndex = -1;
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (Number.isSafeInteger(state.lastKeyIndex) && state.lastPid === pid && now - state.lastTs < TTL_MS) {
      // Same caller, recent call: reuse the same key so pi's multiple uncached
      // resolutions for one request don't advance rotation multiple times.
      lastKeyIndex = state.lastKeyIndex;
    } else if (Number.isSafeInteger(state.nextIndex) && state.nextIndex >= 0) {
      index = state.nextIndex % keys.length;
    }
  } catch (error) {
    // Missing or corrupt state: start rotation from key 0.
  }
  if (lastKeyIndex >= 0) {
    index = lastKeyIndex;
  }
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  const next = (index + 1) % keys.length;
  const temporary = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ nextIndex: next, lastKeyIndex: index, lastPid: pid, lastTs: now })}\n`, { mode: 0o600 });
  fs.renameSync(temporary, stateFile);
  if (process.env.YUNMA_KEY_DEBUG_LOG !== "off") {
    try {
      const hash8 = createHash("sha256").update(keys[index]).digest("hex").slice(0, 8);
      fs.appendFileSync(debugLog, `${JSON.stringify({ t: new Date().toISOString(), index, hash8, pid })}\n`, { mode: 0o600 });
    } catch {
      // Debug logging must never break key resolution.
    }
  }
  return keys[index];
}

const keys = readKeys();
acquireLock();
try {
  process.stdout.write(`${nextKey(keys)}\n`);
} finally {
  fs.rmdirSync(lockDir);
}
