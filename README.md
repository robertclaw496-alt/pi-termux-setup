# pi-termux-setup

Конфигурация [Pi](https://github.com/earendil-works/pi) для Termux на Android: обёртка-супервизор, автовосстановление после падений, safety-слой для внешних действий и несколько расширений.

Устанавливаете впервые и нет ни Termux, ни Pi? → [пошаговая инструкция для Android](docs/install-android.md)

Собрано под конкретное окружение — Pi 0.84.3, Termux на Android, aarch64. Часть решений специфична для Android: нет systemd, процессы убиваются системой, `/tmp` недоступен на запись. Если у вас Linux или macOS, отсюда полезны в основном расширения и safety-слой.

## Что внутри

### bin/pi-safe — супервизор интерактивной сессии

Pi запускается как дочерний процесс под PTY. При падении супервизор разбирает причину и перезапускает сессию с тем же `--session-id`, поэтому история диалога сохраняется.

Что делает:

- различает штатный выход, краш, `SIGKILL` от Android и ошибку провайдера (429, исчерпанные кредиты) — перезапуск только там, где он осмыслен
- crash-loop protection: не больше 5 перезапусков за 10 минут и не больше 3 подряд с одинаковой причиной
- экспоненциальный backoff между перезапусками
- редактирует секреты из стектрейсов перед записью в `runtime/crashes.jsonl`
- ограничивает PTY-лог: за часы работы он вырастал до 160+ МБ, для разбора краша нужны последние килобайты

`bin/pi` — тонкая обёртка, которая направляет интерактивный запуск через супервизор, а административные команды (`--version`, `auth`, `update`) пропускает напрямую. Отключается через `PI_PROTECTED_DEFAULT_DISABLE=1`.

### agent/resurrect — восстановление, когда умер сам супервизор

Случай, который `pi-safe` закрыть не может: Android убил весь процесс-дерево. Здесь три независимых триггера, каждый привязан к тому, что Android реально запускает:

- shell-start hook в `~/.bashrc` — Termux стартует login shell, тот делает одну короткую проверку
- runit-сервис с опросом раз в 60 секунд — на случай, когда Termux жив, а Pi умер
- `~/.termux/boot/` скрипт для Termux:Boot APK — инертен, пока APK не установлен

Все триггеры проходят одну и ту же логику принятия решения: если пользователь сам остановил сессию, она остаётся остановленной. `pi-resurrect doctor` проверяет установку.

### agent/recovery — автопродолжение прерванной задачи

Если Pi упал посреди многошаговой задачи, восстановления сессии недостаточно: headless resume в Pi 0.84.3 не передаёт модели историю сессии. Поэтому continuation-промпт несёт собственную сводку сессии, собранную из транскрипта и отредактированную от секретов.

Проверено реальным unattended E2E: `SIGKILL` в середине задачи → resume той же сессии → задача добита, дублей внешних эффектов нет.

### agent/action-safety — защита от повтора внешних действий

Слой поверх tool-вызовов для случая, когда действие дошло до внешней системы, но результат неизвестен: запрос ушёл, ответ потерялся. Наивный retry здесь дублирует эффект — отправленное сообщение, созданный ресурс, списанные деньги.

Как работает:

- журнал операций с идемпотентными ключами
- при неподтверждённом исходе действие блокируется, а не повторяется, до явной проверки состояния
- fail closed при повреждении журнала
- редактирование секретов в записях журнала: ключи, токены, `Authorization: Bearer`, пути к SSH-ключам
- классификация shell-команд и файловых операций по риску

94 теста, включая потерю всего процесс-дерева и повреждённый журнал.

### agent/extensions

- `sticky-model.ts` — сохраняет выбранную модель и thinking level при `/new`. Штатно Pi при новой сессии берёт `defaultModel` из настроек, потому что выбор через `/model` живёт только в транскрипте сессии. Расширение пишет состояние в `state/sticky-model.json` и восстанавливает его на `session_start` с `reason === "new"`. Отключение: `PI_STICKY_MODEL=0`.
- `memory-query.ts`, `memory-daily-fallback.ts` — работа с памятью агента
- `llm-probe-pi/` — обработка фраз «проверь модель» с автоматическим прогоном тестов OpenAI-совместимого API

### agent/skills

- `finish-long-tasks` — доведение длительных задач до проверенного результата
- `llm-model-probe` — проверка модели через `llm-probe-agent`
- `security-analysis-router` — маршрутизация локального анализа бинарников, APK, JS для авторизованных целей
- `html-artifacts` — самодостаточные HTML-артефакты

### agent/scripts

`yunma-key-rotate.mjs` — round-robin по связке ключей одного провайдера. Pi при одном запросе может разрешать `apiKey` несколько раз, поэтому скрипт удерживает один ключ за вызывающим процессом (TTL 60 с) и не проматывает ротацию лишний раз. Ключи читаются из файла (по одному на строку), в лог пишется только первые 8 символов SHA-256 от ключа. Подключается через `"apiKey": "!node ~/.pi/agent/scripts/yunma-key-rotate.mjs"` в `models.json`; переменные `YUNMA_KEY_FILE` и `YUNMA_KEY_ROTATION_STATE` позволяют тестировать без реальных ключей.

Остальное в каталоге — тесты супервизора.

## Установка

Требуется установленный Pi и Node.js в Termux.

```bash
git clone https://github.com/robertclaw496-alt/pi-termux-setup
cd pi-termux-setup

# расширения, скиллы, safety-слой, восстановление
cp -r agent/extensions agent/skills agent/action-safety \
      agent/recovery agent/resurrect agent/scripts ~/.pi/agent/

# инструкции агента
cp agent/AGENTS.md agent/APPEND_SYSTEM.md ~/.pi/agent/

# обёртки
mkdir -p ~/.local/bin
cp bin/pi bin/pi-safe bin/pi-resurrect ~/.local/bin/
chmod +x ~/.local/bin/pi ~/.local/bin/pi-safe ~/.local/bin/pi-resurrect
chmod +x ~/.pi/agent/resurrect/*.sh
```

Настройки:

```bash
cp agent/settings.json.example ~/.pi/agent/settings.json
```

В `settings.json.example` провайдер и модель заданы как заглушка — подставьте своё. `packages` оставлен пустым: Pi не запустится, если в списке есть пакет, которого нет на диске.

Подробная установка с нуля, включая Termux и Node.js: [docs/install-android.md](docs/install-android.md).

Триггеры восстановления (опционально):

```bash
# shell hook
echo '. ~/.pi/agent/resurrect/hook.sh' >> ~/.bashrc

# проверка установки
pi-resurrect doctor
```

## Тесты

```bash
# safety-слой: 94 теста
cd agent/action-safety && node --test test/*.test.mjs

# восстановление: 18 + 18
cd agent && node --test recovery/test/*.test.mjs
cd agent && node --test resurrect/test/*.test.mjs

# супервизор (с фейковым pi, без запуска реального)
PI_SAFE_LAUNCHER="$PWD/bin/pi-safe" \
PI_SAFE_FAKE="$PWD/agent/scripts/pi-safe-test-fake.mjs" \
  node agent/scripts/pi-safe-test.mjs
```

Тесты `sticky-model` запускают реальный Pi в RPC-режиме и требуют двух настроенных рабочих моделей:

```bash
PI_TEST_START_MODEL="provider/default-model" \
PI_TEST_STICKY_MODEL="provider/other-model" \
  node agent/tests/sticky-model.test.mjs
```

`PI_TEST_START_MODEL` должен совпадать с `defaultProvider`/`defaultModel` из ваших настроек, `PI_TEST_STICKY_MODEL` — быть другой моделью с поддержкой reasoning.

## Чего здесь нет

Ключей провайдеров, `auth.json`, `models.json`, содержимого памяти агента, логов сессий и журналов операций. В тестовых данных, где по смыслу нужен похожий на настоящий ключ или Telegram ID, стоят заведомо фейковые значения.

## Лицензия

MIT
