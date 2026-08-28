# Установка Pi на Android с нуля

Пошаговая установка Pi (coding agent в терминале) на телефон с Android: Termux, Node.js, сам Pi, ключ провайдера, конфиг из этого репозитория.

Проверено на: Android 16, aarch64, Termux 0.119.0-beta.3, Node.js 24.18.0, Pi 0.84.3.

Времени займёт 20–40 минут, большая часть — скачивание пакетов. Root не нужен.

## Содержание

- [Шаг 0. Что понадобится](#шаг-0-что-понадобится)
- [Шаг 1. Установить Termux](#шаг-1-установить-termux)
- [Шаг 2. Установить Termux:API](#шаг-2-установить-termuxapi)
- [Шаг 3. Первый запуск и обновление пакетов](#шаг-3-первый-запуск-и-обновление-пакетов)
- [Шаг 4. Доступ к файлам телефона](#шаг-4-доступ-к-файлам-телефона)
- [Шаг 5. Установить Node.js и утилиты](#шаг-5-установить-nodejs-и-утилиты)
- [Шаг 6. Установить Pi](#шаг-6-установить-pi)
- [Шаг 7. Подключить модель](#шаг-7-подключить-модель)
- [Шаг 8. Первый запуск](#шаг-8-первый-запуск)
- [Шаг 9. Отключить убийство приложения системой](#шаг-9-отключить-убийство-приложения-системой)
- [Шаг 10. Поставить конфиг из этого репозитория](#шаг-10-поставить-конфиг-из-этого-репозитория)
- [Шаг 11. Автовосстановление сессии](#шаг-11-автовосстановление-сессии)
- [Удобство работы с телефона](#удобство-работы-с-телефона)
- [Обновление](#обновление)
- [Если что-то не работает](#если-что-то-не-работает)
- [Удаление](#удаление)

---

## Шаг 0. Что понадобится

- Android 7 или новее, желательно 4+ ГБ оперативной памяти
- около 2 ГБ свободного места
- Wi-Fi: скачается примерно 300–500 МБ пакетов
- ключ API от какого-нибудь AI-провайдера или подписка (Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot)

Ключ можно получить бесплатно, см. [список бесплатных API](https://github.com/robertclaw496-alt/free-ai-api-list).

## Шаг 1. Установить Termux

Termux — это терминал с окружением Linux внутри Android. Именно в нём работает Pi.

**Важно: не ставьте Termux из Google Play.** Та версия заброшена с 2020 года, пакеты в ней не обновляются, и установка Pi на ней не пройдёт.

Берите APK из одного из двух источников:

Вариант A, F-Droid (проще обновлять):
1. Откройте https://f-droid.org/packages/com.termux/
2. Нажмите Download APK
3. Android спросит разрешение на установку из этого источника — разрешите
4. Установите

Вариант B, GitHub (свежее версии):
1. Откройте https://github.com/termux/termux-app/releases
2. В последнем релизе выберите файл `termux-app_v*+apt-android-7-github-debug_universal.apk`
3. Скачайте и установите

Не смешивайте источники: приложения из F-Droid и GitHub подписаны разными ключами, и второе поверх первого не встанет. Если решите сменить источник, сначала удалите старое приложение.

## Шаг 2. Установить Termux:API

Отдельное приложение, через которое Termux получает доступ к буферу обмена, уведомлениям, батарее. Для Pi нужно как минимум ради копирования текста.

Ставьте **из того же источника, что и Termux** — иначе подписи не совпадут и связь между приложениями не заработает.

- F-Droid: https://f-droid.org/packages/com.termux.api/
- GitHub: https://github.com/termux/termux-api/releases

Само приложение открывать не нужно, оно работает в фоне.

## Шаг 3. Первый запуск и обновление пакетов

Откройте Termux. Появится приглашение вида `~ $`.

Первым делом обновите список пакетов:

```bash
pkg update && pkg upgrade -y
```

Может спросить про замену конфигурационных файлов — жмите Enter, согласившись с вариантом по умолчанию.

Если качается медленно, смените зеркало на ближайшее:

```bash
termux-change-repo
```

Стрелками и пробелом выберите `Mirrors hosted by Grimler` или любое из своего региона, подтвердите, потом снова `pkg update`.

## Шаг 4. Доступ к файлам телефона

Чтобы Pi мог читать и писать в загрузки и документы:

```bash
termux-setup-storage
```

Android покажет запрос разрешения — разрешите. После этого появится каталог `~/storage`, а папка загрузок будет доступна как `~/storage/downloads` (полный путь `/storage/emulated/0/Download`).

## Шаг 5. Установить Node.js и утилиты

```bash
pkg install -y nodejs-lts git termux-api ripgrep
```

Что зачем:
- `nodejs-lts` — Pi написан на JavaScript, нужна версия Node.js не ниже 22.19
- `git` — для установки пакетов и работы с репозиториями
- `termux-api` — консольные команды к приложению Termux:API из шага 2
- `ripgrep` — быстрый поиск по файлам, Pi им пользуется

Проверьте:

```bash
node -v    # должно быть v22.19 или выше
git --version
```

## Шаг 6. Установить Pi

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Флаг `--ignore-scripts` здесь обязателен: у Pi есть необязательные зависимости с нативным кодом, который под Android ARM64 не собирается. Без флага установка упадёт на попытке компиляции. С флагом Pi работает полностью, отваливается только вставка картинок из буфера обмена.

Создайте каталог конфигурации и проверьте установку:

```bash
mkdir -p ~/.pi/agent
pi --version
```

Должна вывестись версия, например `0.84.3`.

## Шаг 7. Подключить модель

Два способа на выбор.

### Способ A: подписка

Если у вас есть Claude Pro/Max, ChatGPT Plus/Pro или GitHub Copilot:

```bash
pi
```

Внутри Pi введите:

```
/login
```

Выберите провайдера и пройдите авторизацию в браузере.

### Способ B: ключ API

Ключ можно передать переменной окружения:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi
```

Чтобы не вводить каждый раз, допишите строку в `~/.bashrc`. Но учтите: файл лежит в открытом виде. Надёжнее хранить ключ отдельным файлом с правами только для владельца:

```bash
mkdir -p ~/.pi/agent/secrets
umask 077
# впишите ключ в файл, без перевода строки в конце
nano ~/.pi/agent/secrets/my-api-key
chmod 600 ~/.pi/agent/secrets/my-api-key
```

Потом внутри Pi:

```
/login
```

и вставьте ключ туда — Pi сохранит его в `~/.pi/agent/auth.json`.

### Свой провайдер или OpenAI-совместимый шлюз

Для провайдера, которого нет в списке встроенных, создайте `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "myprovider": {
      "baseUrl": "https://api.example.com/v1",
      "api": "openai-completions",
      "apiKey": "!cat ~/.pi/agent/secrets/my-api-key",
      "models": [
        { "id": "gpt-4o-mini" },
        { "id": "claude-3-5-sonnet" }
      ]
    }
  }
}
```

Синтаксис `!команда` в поле `apiKey` означает, что Pi выполнит команду и возьмёт её вывод как ключ. Так ключ не лежит в конфиге открытым текстом.

Некоторые шлюзы не понимают роль `developer`, которую Pi использует для reasoning-моделей. Если получаете ошибки о неизвестной роли, добавьте провайдеру:

```json
"compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false }
```

Подробности — в `docs/models.md` внутри установленного Pi:

```bash
cat $PREFIX/lib/node_modules/@earendil-works/pi-coding-agent/docs/models.md
```

## Шаг 8. Первый запуск

```bash
cd ~
pi
```

Полезные команды внутри:

| Команда | Что делает |
|---|---|
| `/model` или Ctrl+L | выбрать модель |
| `/new` | начать новую сессию |
| `/help` | список всех команд |
| `/login`, `/logout` | управление доступом к провайдерам |
| Ctrl+C дважды | выйти |

Проверьте, что всё работает, простым запросом: попросите Pi показать содержимое текущего каталога.

## Шаг 9. Отключить убийство приложения системой

Это самый важный шаг на Android, и его чаще всего пропускают. Система агрессивно выгружает фоновые приложения, и Termux с работающим Pi убивается через несколько минут после того, как вы свернули экран. Задача обрывается на середине.

Что нужно сделать:

1. **Отключить оптимизацию батареи для Termux.** Настройки → Приложения → Termux → Батарея → выберите «Без ограничений» (формулировки различаются: Unrestricted, «Не экономить», «Разрешить работу в фоне»).

2. **Закрепить приложение в списке недавних.** Откройте список запущенных приложений, найдите Termux, нажмите на его иконку и выберите «Закрепить» (замочек). На Xiaomi, Huawei, Oppo и Samsung это отдельный механизм помимо настроек батареи, и без него всё равно убивает.

3. **Взять wake lock в самом Termux.** Разверните уведомление Termux и нажмите ACQUIRE WAKELOCK. Тогда процессор не уйдёт в глубокий сон.

На телефонах Xiaomi/Redmi дополнительно: Настройки → Приложения → Termux → Автозапуск → включить.

Даже со всеми настройками Android иногда убивает процесс. Для этого случая в репозитории есть слой восстановления, см. шаги 10 и 11.

## Шаг 10. Поставить конфиг из этого репозитория

```bash
cd ~
git clone https://github.com/robertclaw496-alt/pi-termux-setup
cd pi-termux-setup
```

Дальше выбирайте, что нужно.

### Только расширения и скиллы

Минимальный вариант: sticky-model (сохраняет выбранную модель при `/new`), работа с памятью, скиллы.

```bash
cp -r agent/extensions agent/skills ~/.pi/agent/
```

Расширения из `~/.pi/agent/extensions/*.ts` подхватываются автоматически при следующем запуске.

### Safety-слой

Защита от повторного выполнения внешних действий, у которых неизвестен результат: отправленное сообщение, созданный ресурс, списанные деньги.

```bash
cp -r agent/action-safety ~/.pi/agent/
```

### Супервизор с автоперезапуском

Запускает Pi под наблюдением: при падении разбирает причину и перезапускает ту же сессию, сохраняя историю диалога.

```bash
mkdir -p ~/.local/bin
cp bin/pi bin/pi-safe ~/.local/bin/
chmod +x ~/.local/bin/pi ~/.local/bin/pi-safe
```

Убедитесь, что `~/.local/bin` идёт в `PATH` раньше системного каталога:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
which pi     # должно показать ~/.local/bin/pi
```

Теперь `pi` запускается через супервизор. Административные команды (`pi --version`, `pi auth`, `pi update`) идут напрямую. Отключить на один запуск: `PI_PROTECTED_DEFAULT_DISABLE=1 pi`.

### Инструкции агента

`AGENTS.md` описывает окружение и правила работы. Свой файл не перезаписывайте вслепую — посмотрите сначала, что внутри.

```bash
cp agent/AGENTS.md agent/APPEND_SYSTEM.md ~/.pi/agent/
```

### Настройки

```bash
cp agent/settings.json.example ~/.pi/agent/settings.json
nano ~/.pi/agent/settings.json
```

Обязательно поправьте `defaultProvider` и `defaultModel` — в примере стоит заглушка `anthropic` / `claude-sonnet-4`.

`packages` в примере пустой список — так и должно быть для чистой установки. Если будете добавлять внешние пакеты, убедитесь, что каждый из них реально установлен: Pi не запустится, если в списке есть пакет, которого нет на диске.

## Шаг 11. Автовосстановление сессии

Слой на случай, когда Android убил весь процесс целиком и супервизор из шага 10 тоже погиб.

```bash
cp -r agent/recovery agent/resurrect ~/.pi/agent/
cp bin/pi-resurrect ~/.local/bin/
chmod +x ~/.local/bin/pi-resurrect ~/.pi/agent/resurrect/*.sh
```

Подключите триггер в shell — он проверяет состояние при каждом открытии Termux:

```bash
cat >> ~/.bashrc <<'EOF'

# Pi resurrection trigger
if [ -r "$HOME/.pi/agent/resurrect/hook.sh" ]; then
  . "$HOME/.pi/agent/resurrect/hook.sh"
fi
EOF
```

Проверьте установку:

```bash
pi-resurrect doctor
```

Часть проверок будет провалена, если не установлены Termux:Boot и Termux:API — это нормально.

### Опционально: фоновый опрос через runit

Случай, когда Termux жив, а процесс Pi умер. Сервис проверяет состояние раз в 60 секунд.

```bash
pkg install -y termux-services
```

Перезапустите Termux, затем:

```bash
mkdir -p $PREFIX/var/service/pi-resurrect/log

cat > $PREFIX/var/service/pi-resurrect/run <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
exec 2>&1
cd /data/data/com.termux/files/home || exit 111
INTERVAL="${PI_RESURRECT_POLL_INTERVAL:-60}"
while true; do
  sleep "$INTERVAL"
  "$HOME/.local/bin/pi-resurrect" check --trigger runit --quiet >/dev/null 2>&1
done
EOF

cat > $PREFIX/var/service/pi-resurrect/log/run <<'EOF'
#!/data/data/com.termux/files/usr/bin/sh
export LOGDIR=/data/data/com.termux/files/usr/var/log
exec /data/data/com.termux/files/usr/share/termux-services/svlogger
EOF

chmod +x $PREFIX/var/service/pi-resurrect/run $PREFIX/var/service/pi-resurrect/log/run
sv up pi-resurrect
sv status pi-resurrect
```

Управление: `sv up pi-resurrect` включить, `sv down pi-resurrect` остановить.

Не отправляйте `SIGHUP` процессу `runsvdir` — в termux-services это штатная остановка **всех** сервисов, а не перечитывание каталога. Отдельный сервис перезапускается только через `sv term <имя>` и `sv up <имя>`.

### Опционально: восстановление после перезагрузки

Нужно приложение Termux:Boot из того же источника, что Termux: https://f-droid.org/packages/com.termux.boot/

```bash
mkdir -p ~/.termux/boot
cp ~/pi-termux-setup/agent/resurrect/boot.sh ~/.termux/boot/10-pi-resurrect.sh
chmod +x ~/.termux/boot/10-pi-resurrect.sh
```

После установки APK один раз откройте приложение Termux:Boot, иначе Android не выдаст ему право на автозапуск.

Скрипт не запускает Pi после перезагрузки безусловно: если вы сами остановили сессию, она останется остановленной.

## Удобство работы с телефона

**Клавиатура.** Экранная клавиатура плохо подходит для терминала. В Termux есть дополнительный ряд клавиш: свайп вверх от левого края экрана. Там Ctrl, Alt, Tab, стрелки. Ещё вариант — подключить bluetooth-клавиатуру.

**Копирование.** Долгое нажатие на текст открывает меню выделения. Через `termux-clipboard-get` и `termux-clipboard-set` можно работать с буфером из скриптов.

**Не закрывайте Termux свайпом** из списка недавних, пока Pi работает. Сворачивайте кнопкой Home.

**Полезные команды Termux:API:**

```bash
termux-notification -t "Pi" -c "задача готова"   # уведомление
termux-battery-status                             # заряд батареи
termux-open-url "https://example.com"             # открыть ссылку
termux-toast "сообщение"                          # всплывающее сообщение
```

## Обновление

```bash
pkg update && pkg upgrade -y                                        # пакеты Termux
npm install -g --ignore-scripts @earendil-works/pi-coding-agent      # Pi
pi update --models                                                   # каталоги моделей
```

Конфиг из этого репозитория:

```bash
cd ~/pi-termux-setup && git pull
```

и повторите нужные шаги копирования.

## Если что-то не работает

**`pi: command not found`**

`npm` кладёт бинарники в свой каталог, проверьте, что он в `PATH`:

```bash
npm config get prefix     # обычно /data/data/com.termux/files/usr
echo $PATH | tr ':' '\n' | grep usr/bin
```

**Установка Pi падает на компиляции нативного модуля**

Забыт флаг `--ignore-scripts`. Очистите кэш и повторите:

```bash
npm cache clean --force
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

**Пакеты не скачиваются или ошибки 404 от репозитория**

Зеркало недоступно. Смените: `termux-change-repo`, затем `pkg update`.

**Termux умирает через минуту после сворачивания**

Вернитесь к шагу 9. Одной настройки батареи обычно недостаточно, нужны все три пункта.

**Pi не видит модель, `/model` показывает её недоступной**

Не настроена авторизация. Ключ должен быть либо в `auth.json` (через `/login`), либо в поле `apiKey` провайдера в `models.json`, либо в переменной окружения. Проверьте конкретного провайдера:

```bash
pi auth check --provider anthropic
```

Команде обязательно нужен `--provider` или `--model`.

**Ошибки про роль `developer` или `reasoning_effort`**

Шлюз не поддерживает эти параметры. Добавьте провайдеру в `models.json`:

```json
"compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false }
```

**Буфер обмена не работает**

Приложение Termux:API не установлено, либо установлено из другого источника, чем Termux. Подписи должны совпадать. Также нужны консольные утилиты: `pkg install termux-api`.

**Нет доступа к `/storage/emulated/0`**

```bash
termux-setup-storage
```

**Pi не запускается после копирования settings.json**

Скорее всего в `packages` остались пакеты, которых нет в системе. Откройте `~/.pi/agent/settings.json` и уберите лишние строки или поставьте `"packages": []`.

**Ошибка `sqlite-vec` или проблемы с semantic-поиском в памяти**

Нативной сборки `sqlite-vec` под android-arm64 нет. Используйте keyword-поиск, он работает.

## Удаление

```bash
npm uninstall -g @earendil-works/pi-coding-agent
rm -rf ~/.pi
rm -f ~/.local/bin/pi ~/.local/bin/pi-safe ~/.local/bin/pi-resurrect
sv down pi-resurrect 2>/dev/null
rm -rf $PREFIX/var/service/pi-resurrect
```

Уберите из `~/.bashrc` строки про `pi-resurrect` и `PATH`, если добавляли.

Полностью убрать Termux — удалить приложение обычным способом через настройки Android. Все файлы окружения удалятся вместе с ним.

---

## Ссылки

- Termux: https://termux.dev, https://github.com/termux/termux-app
- Termux:API: https://github.com/termux/termux-api
- Termux:Boot: https://github.com/termux/termux-boot
- Pi: https://github.com/earendil-works/pi
- Документация Pi после установки: `$PREFIX/lib/node_modules/@earendil-works/pi-coding-agent/docs/`
- Официальная страница про Termux в документации Pi: `docs/termux.md` там же
