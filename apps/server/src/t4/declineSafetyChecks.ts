/**
 * t4 fork: on a full-access thread, nobody approves anything.
 *
 * Claude runs with `bypassPermissions`, yet Claude Code still forwards some
 * of its own safety checks to the permission callback - "cannot be
 * auto-allowed by permission rules", whatever the mode. The one t4 hit is
 * the dangerous-rm guard: `cd ../../frontend-dashboard; ... rm -f
 * ../backend/api/data/shots/*` (a relative glob after a `cd`) put an
 * Approve/Decline card in front of the user (usa-rs USA-1424, 2026-10-26),
 * and the turn waited on it.
 *
 * With `T4_CLAUDE_DECLINE_SAFETY_CHECKS=1`, such a check (bypass refused it
 * and no ask rule matched - T3's `provider_check`) is declined at once with
 * a note telling Claude how to do it in a form the check can verify. The
 * guard still stops a removal it can't resolve; the agent rewrites it
 * instead of a person approving it. Asks from the user's own ask rules
 * still reach the user.
 */
export const t4DeclineSafetyChecks = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.T4_CLAUDE_DECLINE_SAFETY_CHECKS?.trim() === "1";

export const safetyCheckDeclinedNote = (reason: string | undefined): string =>
  `Claude Code's safety check stopped this command${reason ? ` (${reason})` : ""}, and no one ` +
  "approves commands on this thread, so it was not run. Do it in a form the check can verify: " +
  "for a removal, one rm per target with its literal absolute path - no `cd` before it in the " +
  "same command, no relative glob, no glob across directories, no variable or command " +
  "substitution in the path. Don't ask the user to approve it.";
