/**
 * t4 fork: under `bypassPermissions` Claude Code still forwards some safety checks (e.g. its
 * dangerous-rm guard) to the permission callback. With `T4_CLAUDE_DECLINE_SAFETY_CHECKS=1`, such a
 * `provider_check` is declined at once with a note on how to rewrite the command so the check can
 * verify it; asks from the user's own ask rules still reach the user.
 */
export const t4DeclineSafetyChecks = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.T4_CLAUDE_DECLINE_SAFETY_CHECKS?.trim() === "1";

const RM_COMMAND = /(?:^|[\s;&|(`])rm(?:dir)?(?=\s|$)/m;

/** Without the command, the note assumes a removal. */
export const safetyCheckDeclinedNote = (reason: string | undefined, command?: string): string =>
  `Claude Code's safety check stopped this command${reason ? ` (${reason})` : ""}, and no one ` +
  "approves commands on this thread, so it was not run. " +
  (command === undefined || RM_COMMAND.test(command)
    ? "Do it in a form the check can verify: for a removal, one rm per target with its literal " +
      "absolute path - no `cd` before it in the same command, no relative glob, no glob across " +
      "directories, no variable or command substitution in the path."
    : "Don't run a script inline through a heredoc or `-c`: save it with the Write tool to a " +
      "file (outside the repository or in a gitignored folder) and run that file.") +
  " Don't ask the user to approve it.";
