/**
 * t4 fork: Claude asks the way Codex does - as a message-mode question.
 *
 * Claude Opus 5.5 writes much of its prose between tool calls inside its
 * thinking, and with summarized thinking (T3's `showThinkingSummaries`) the
 * server returns that prose only as a summary ("narration" blocks). The
 * message an agent wrote just before AskUserQuestion - the Show, the links,
 * the screenshots - reached the user as one vague sentence, and a reply to
 * a follow-up question did too, before the same question was asked again.
 * Only a turn's final text is always delivered verbatim.
 *
 * With `T4_CLAUDE_QUESTIONS_AS_MESSAGES=1`, AskUserQuestion posts the
 * question as a message-mode request (it stays answerable after the turn,
 * and the answer arrives as the next user message) and returns at once,
 * telling Claude to end its turn with everything the user decides from as
 * its final reply.
 */
export const t4QuestionsAsMessages = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.T4_CLAUDE_QUESTIONS_AS_MESSAGES?.trim() === "1";

export const QUESTION_POSTED_NOTE =
  "Your question is posted to the user; their answer will arrive as your next message. " +
  "End your turn now with your reply to them as your final message: everything they decide " +
  "from - what changed, links, screenshots embedded as ![alt](/absolute/path.png). Text you " +
  "write before a tool call can reach them only as a short summary. Don't ask it again in " +
  "this turn.";
