#!/data/data/com.termux/files/usr/bin/node
import { appendFileSync, existsSync } from "node:fs";
const mode = process.env.PI_SAFE_TEST_MODE || "normal";
const session = process.env.PI_SAFE_TEST_SESSION;
if (session && !existsSync(session)) appendFileSync(session, JSON.stringify({ type: "session", version: 3, id: "fake-session" }) + "\n");
if (mode === "sequence") {
  if (existsSync(process.env.PI_SAFE_TEST_MARKER)) process.exit(0);
  appendFileSync(process.env.PI_SAFE_TEST_MARKER, "crashed\n");
  console.error("pi exiting due to uncaughtException:");
  console.error("Error: write EPIPE\ncode: EPIPE\nsyscall: write");
  process.exit(1);
}
if (mode === "normal") process.exit(0);
if (mode === "hang") setInterval(() => {}, 1000);
if (mode === "epipe") { console.error("pi exiting due to uncaughtException:"); console.error("Error: write EPIPE\ncode: EPIPE\nsyscall: write"); process.exit(1); }
if (mode === "crash") { console.error("pi exiting due to uncaughtException:"); console.error("Error: simulated failure\n    at fake (fake.mjs:1:1)"); process.exit(1); }
if (mode === "api-error") { console.error('429: {"message":"daily_free_credits_exhausted","type":"new_api_error"}'); process.exit(1); }
if (mode === "sigterm") process.kill(process.pid, "SIGTERM");
if (mode === "sigkill") process.kill(process.pid, "SIGKILL");
