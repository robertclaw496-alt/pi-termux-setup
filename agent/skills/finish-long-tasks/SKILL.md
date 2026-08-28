---
name: finish-long-tasks
description: Применять к длительным, исследовательским и многошаговым задачам, требующим проверки результата и восстановления после прерывания.
---

# Finish Long Tasks

Use this skill only when the task is long-running, interruptible, multi-session, or likely to require crash/compaction recovery.

For short/medium tasks, do not create persistence ceremony.

When active:
- keep a compact checkpoint of verified progress;
- TODO should contain only meaningful remaining milestones;
- exactly one active implementation milestone is preferred, not mandatory bookkeeping;
- update the checkpoint after factual progress;
- after resume continue from the first genuinely incomplete milestone;
- do not repeat completed child runs;
- finish only when the requested artifact/result is verified.

State clear, verifiable completion criteria before beginning. Do not stop after a plan or an intermediate result. Verify with tests, a real run, or direct inspection. If a criterion remains unmet, diagnose and fix it before finishing. Use a continuation loop only while work is genuinely unfinished; do not create a loop for ordinary short tasks.
