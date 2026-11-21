/**
 * t4 fork: background work a Claude thread is marked as waiting on without calling
 * `t3_background_wait` - a Monitor, or a Bash command that runs checks, tests or a build. Agents
 * called the tool after nearly every such command (5,944 calls a week, 19% after the task had
 * already finished, AI-125). A dev server or watcher left running stays unmarked.
 */
import type { OrchestrationV2PendingBackgroundTask } from "@t3tools/contracts";

const RUNS_CHECKS = new RegExp(
  String.raw`(?:^|[\s;&|(\x60/])(?:` +
    [
      String.raw`[\w.-]*check[\w-]*\.sh`,
      String.raw`[\w.-]*test[\w-]*\.sh`,
      "pytest",
      String.raw`py\.test`,
      "vitest",
      "jest",
      String.raw`playwright\s+test`,
      "tsc",
      "ruff",
      "mypy",
      "pyright",
      "eslint",
      "oxlint",
      String.raw`cargo\s+(?:test|build|check|clippy)`,
      String.raw`go\s+(?:test|build|vet)`,
      String.raw`(?:pnpm|npm|yarn|bun|vp|uv)\s+(?:run\s+|exec\s+)?(?:test|build|check|lint|typecheck)[\w:-]*`,
      String.raw`docker\s+(?:compose\s+)?build`,
      "make",
    ].join("|") +
    String.raw`)(?=\s|$|[;&|)])`,
  "m",
);
const LEFT_RUNNING = /(?:^|\s)(?:--watch|watch|--serve)(?:\s|$)/;
// Heredoc bodies and quoted text (a commit message, a PR body) name commands they don't run.
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?(?:\n\2(?=\n|$)|$)/g;
const QUOTED = /'[^']*'|"(?:[^"\\]|\\.)*"/g;
const runCommands = (command: string) => command.replace(HEREDOC, " ").replace(QUOTED, " ");

export const awaitsOnItsOwn = (task: OrchestrationV2PendingBackgroundTask): boolean =>
  task.kind === "monitor" ||
  (task.kind === "command" &&
    task.command !== undefined &&
    RUNS_CHECKS.test(runCommands(task.command)) &&
    !LEFT_RUNNING.test(task.command));
