/**
 * t4 fork: under `bypassPermissions` Claude Code still forwards some safety checks (e.g. its
 * dangerous-rm guard) to the permission callback. With `T4_CLAUDE_DECLINE_SAFETY_CHECKS=1`, such a
 * `provider_check` is declined at once with a note on how to rewrite the command so the check can
 * verify it; asks from the user's own ask rules still reach the user.
 *
 * Claude Code 2.1.326-2.1.330 widened the checks (AI-124): `cp` and `mv` get the removal check
 * ("Dangerous cp operation detected"), a target that is the working directory or a parent of it,
 * a critical or top-level folder, a path through a variable that may be empty, and a command the
 * check can't parse even with no rm in it. The note gives the advice that fits the reason.
 */
export const t4DeclineSafetyChecks = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.T4_CLAUDE_DECLINE_SAFETY_CHECKS?.trim() === "1";

const RM_COMMAND = /(?:^|[\s;&|(`])rm(?:dir)?(?=\s|$)/m;
const COPY_MOVE = /(?:^|[\s;&|(`])(?:cp|mv)(?=\s|$)/m;

const LITERAL =
  "literal absolute paths - no `cd` before it in the same command, no relative glob, no glob " +
  "across directories, no variable, `~` or command substitution in a path";

export type SafetyCheckKind =
  | "workspace"
  | "critical"
  | "unresolved"
  | "copy-move"
  | "rm"
  | "unparsed";

/** Which kind of check stopped the command (logged, so declines can be counted by kind). */
export const safetyCheckKind = (reason: string | undefined, command?: string): SafetyCheckKind => {
  const r = (reason ?? "").toLowerCase();
  if (/workspace directory|working directory|parent director/.test(r)) return "workspace";
  if (/critical|top-level|system director/.test(r)) return "critical";
  if (/variable|expansion|statically|unresolv/.test(r)) return "unresolved";
  if (/dangerous (cp|mv) /.test(r)) return "copy-move";
  if (command !== undefined && COPY_MOVE.test(command) && !RM_COMMAND.test(command))
    return "copy-move";
  if (command === undefined || RM_COMMAND.test(command)) return "rm";
  return "unparsed";
};

const ADVICE: Record<SafetyCheckKind, (reason: string) => string> = {
  workspace: () =>
    "The target is your working directory or a folder above it - never remove or overwrite " +
    "that (your thread runs in it). Name the exact file or folder inside it by its literal " +
    "absolute path.",
  critical: () =>
    "The target is (or could become, if a variable is empty) `/`, your home, `/tmp` or a " +
    "top-level folder. Name the exact path deeper inside, written out literally.",
  unresolved: () => `The check could not tell where the path points. Write it out: ${LITERAL}.`,
  "copy-move": (reason) => {
    const op = /dangerous (cp|mv) /i.exec(reason)?.[1];
    return (
      `For a copy or move: one \`${op ?? "cp/mv"}\` per target, source and destination as ` +
      `${LITERAL}; never a destination of \`/\`, your home or a top-level folder.`
    );
  },
  rm: () =>
    `Do it in a form the check can verify: for a removal, one rm per target with its ${LITERAL}.`,
  unparsed: () =>
    "The check could not read this command the way the shell will, and it has no removal in " +
    "it: resend it in plain syntax. Don't run a script inline through a heredoc or `-c`: save " +
    "it with the Write tool to a file (outside the repository or in a gitignored folder) and run " +
    "that file.",
};

/** Without the command, the note assumes a removal. */
export const safetyCheckDeclinedNote = (reason: string | undefined, command?: string): string =>
  `Claude Code's safety check stopped this command${reason ? ` (${reason})` : ""}, and no one ` +
  "approves commands on this thread, so it was not run. " +
  ADVICE[safetyCheckKind(reason, command)](reason ?? "") +
  " Don't ask the user to approve it.";
