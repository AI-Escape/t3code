/**
 * t4 fork: under `bypassPermissions` Claude Code still forwards some safety checks (e.g. its
 * dangerous-rm guard) to the permission callback. With `T4_CLAUDE_DECLINE_SAFETY_CHECKS=1`, such a
 * `provider_check` is declined at once with a note on how to rewrite the command so the check can
 * verify it; asks from the user's own ask rules still reach the user.
 */
export const t4DeclineSafetyChecks = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.T4_CLAUDE_DECLINE_SAFETY_CHECKS?.trim() === "1";

export const safetyCheckDeclinedNote = (reason: string | undefined): string =>
  `Claude Code's safety check stopped this command${reason ? ` (${reason})` : ""}, and no one ` +
  "approves commands on this thread, so it was not run. Do it in a form the check can verify: " +
  "for a removal, one rm per target with its literal absolute path - no `cd` before it in the " +
  "same command, no relative glob, no glob across directories, no variable or command " +
  "substitution in the path. Don't ask the user to approve it.";
