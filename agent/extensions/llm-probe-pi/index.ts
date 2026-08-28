import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import {
  parseNaturalProbeRequest,
  redactSecret,
  requestHelpText,
} from "./parser.mjs";

const STATUS_ID = "llm-probe-pi";

export default function (pi) {
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };

    const request = parseNaturalProbeRequest(event.text);
    if (!request) return { action: "continue" };

    if (!request.complete) {
      return {
        action: "transform",
        text: requestHelpText(request.missing),
        images: [],
      };
    }

    const secretDir = process.env.LLM_PROBE_SECRET_DIR ||
      path.join(os.homedir(), ".cache", "llm-probe-pi", "secrets");
    fs.mkdirSync(secretDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(secretDir, 0o700); } catch {}

    const keyFile = path.join(secretDir, `key-${process.pid}-${crypto.randomBytes(8).toString("hex")}`);
    fs.writeFileSync(keyFile, request.apiKey, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try { fs.chmodSync(keyFile, 0o600); } catch {}

    const agentBin = process.env.LLM_PROBE_AGENT_BIN ||
      path.join(os.homedir(), ".local", "bin", "llm-probe-agent");

    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_ID, "LLM Probe: подготовка");
      ctx.ui.notify(`Начинаю проверку ${request.model}`, "info");
    }

    try {
      const result = await executeProbe(agentBin, {
        site: request.site,
        model: request.model,
        keyFile,
        mode: request.mode,
        onProgress: (stage, message) => {
          if (ctx.hasUI) ctx.ui.setStatus(STATUS_ID, `LLM Probe: ${shorten(message || stage, 72)}`);
        },
      });

      const safeStdout = redactSecret(result.stdout, request.apiKey);
      let payload;
      try {
        payload = JSON.parse(safeStdout);
      } catch {
        payload = {
          ok: false,
          error: "Тестер вернул некорректный JSON",
          exit_code: result.code,
          stdout_tail: safeStdout.slice(-4000),
          stderr_tail: redactSecret(result.stderr, request.apiKey).slice(-4000),
        };
      }

      const safePayload = deepRedact(payload, request.apiKey);
      if (ctx.hasUI) {
        ctx.ui.notify(
          safePayload?.ok ? `Проверка ${request.model} завершена` : `Проверка ${request.model} завершена с ошибкой`,
          safePayload?.ok ? "info" : "warning",
        );
      }

      return {
        action: "transform",
        text: buildAgentPrompt(request, safePayload, result.code),
        images: [],
      };
    } catch (error) {
      const safeError = redactSecret(error?.stack || error?.message || String(error), request.apiKey);
      if (ctx.hasUI) ctx.ui.notify("Не удалось запустить LLM Probe", "error");
      return {
        action: "transform",
        text: [
          "Локальное расширение llm-probe-pi перехватило запрос, но тест не запустился.",
          `Модель: ${request.model}`,
          `Сайт: ${request.site}`,
          `Ошибка: ${safeError}`,
          "API-ключ в этот текст не включён. Объясни пользователю причину и предложи проверить установку командой llm-probe doctor.",
        ].join("\n"),
        images: [],
      };
    } finally {
      safeUnlink(keyFile);
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_ID, undefined);
    }
  });
}

function executeProbe(agentBin, { site, model, keyFile, mode, onProgress }) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(agentBin)) {
      reject(new Error(`Команда не найдена: ${agentBin}. Переустанови llm-probe-pi.`));
      return;
    }

    const args = [
      "--site", site,
      "--model", model,
      "--api-key-file", keyFile,
      "--cleanup-key-file",
      "--mode", mode,
    ];
    const child = spawn(agentBin, args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    let progressBuffer = "";

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      progressBuffer += text;
      let newline;
      while ((newline = progressBuffer.indexOf("\n")) >= 0) {
        const line = progressBuffer.slice(0, newline);
        progressBuffer = progressBuffer.slice(newline + 1);
        const match = line.match(/^PROGRESS\t([^\t]*)\t(.*)$/);
        if (match) onProgress(match[1], match[2]);
      }
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function buildAgentPrompt(request, payload, exitCode) {
  const json = JSON.stringify(payload, null, 2);
  return [
    "Автоматическая локальная проверка OpenAI-compatible API уже выполнена расширением llm-probe-pi.",
    "API-ключ был передан тестеру через временный файл с правами 600, удалён и в данные ниже не включён.",
    `Запрошенная модель: ${request.model}`,
    `Исходный сайт: ${request.site}`,
    `Режим: ${request.mode}`,
    `Код завершения тестера: ${exitCode}`,
    "",
    "Данные проверки:",
    "```json",
    json,
    "```",
    "",
    "Дай пользователю итог на русском без повторного запроса ключа. Укажи рабочий endpoint, базовую доступность, response.model, tools, reasoning, vision, streaming, TTFT, tok/s и фактический контекст. Различай максимальный принятый вход и максимальный контекст, где маркер реально вернулся. Не называй модель оригинальной только по self-identification или response.model. Укажи пути к JSON/Markdown отчётам, если они есть.",
  ].join("\n");
}

function deepRedact(value, secret) {
  if (typeof value === "string") return redactSecret(value, secret);
  if (Array.isArray(value)) return value.map((item) => deepRedact(item, secret));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepRedact(item, secret)]));
  }
  return value;
}

function shorten(value, max) {
  const text = String(value || "").replace(/[\r\n]+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function safeUnlink(file) {
  try { fs.unlinkSync(file); } catch (error) {
    if (error?.code !== "ENOENT") {
      // Do not throw from cleanup. The wrapper also attempts deletion.
    }
  }
}
