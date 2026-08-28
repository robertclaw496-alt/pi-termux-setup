#!/data/data/com.termux/files/usr/bin/node
// Регрессия: pi-safe не должен читать в память весь PTY-лог дочернего Pi.
// Долгие интерактивные сессии выращивают child-<pid>.typescript до сотен МБ;
// чтение целиком (readFile) добавляет пик RSS ровно в момент разбора краха,
// то есть именно тогда, когда Android уже под давлением памяти.
//
// Тест работает без запуска Pi: он проверяет контракт функции чтения хвоста
// лога, экспортируемой pi-safe (tailFile), на файле заведомо больше лимита.
import { mkdtemp, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mod = await import(`file://${process.env.HOME}/.local/bin/pi-safe`);
if (typeof mod.tailFile !== "function") {
  throw Error("pi-safe must export tailFile(path, maxBytes) for bounded log reads");
}
if (typeof mod.CHILD_LOG_TAIL_BYTES !== "number" || mod.CHILD_LOG_TAIL_BYTES <= 0) {
  throw Error("pi-safe must export a positive CHILD_LOG_TAIL_BYTES limit");
}

const dir = await mkdtemp(join(tmpdir(), "pi-safe-tail-"));
try {
  const limit = mod.CHILD_LOG_TAIL_BYTES;
  const head = "X".repeat(limit * 2);
  const tailMark = "TAIL-MARKER-END";
  const big = join(dir, "big.typescript");
  await writeFile(big, head + tailMark);
  const size = (await stat(big)).size;
  if (size <= limit) throw Error("fixture must exceed the limit");

  const tail = await mod.tailFile(big, limit);
  if (Buffer.byteLength(tail) > limit) {
    throw Error(`tailFile returned ${Buffer.byteLength(tail)} bytes, limit ${limit}`);
  }
  if (!tail.endsWith(tailMark)) {
    throw Error("tailFile must return the END of the file (most recent output)");
  }

  // Небольшой файл должен читаться целиком, без потерь.
  const small = join(dir, "small.typescript");
  await writeFile(small, "short output");
  if (await mod.tailFile(small, limit) !== "short output") {
    throw Error("tailFile must return small files verbatim");
  }

  // Отсутствующий файл не должен ломать разбор краха.
  if (await mod.tailFile(join(dir, "missing.typescript"), limit) !== "") {
    throw Error("tailFile must return empty string for a missing file");
  }

  console.log("PI_SAFE_LOG_BOUND_TEST_OK");
} finally {
  await rm(dir, { recursive: true, force: true });
}
