/**
 * t4 fork: with summarized thinking, Claude's prose between tool calls can reach the user only as a
 * summary; just a turn's final text is verbatim. With `T4_CLAUDE_QUESTIONS_AS_MESSAGES=1`,
 * AskUserQuestion posts a message-mode request (answerable after the turn) and returns at once,
 * telling Claude to end its turn with everything the user decides from as its final reply.
 */
export const t4QuestionsAsMessages = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.T4_CLAUDE_QUESTIONS_AS_MESSAGES?.trim() === "1";

export const QUESTION_POSTED_NOTE =
  "Your question is posted to the user; their answer will arrive as your next message. " +
  "End your turn now with your reply to them as your final message: everything they decide " +
  "from - what changed, links, screenshots embedded as ![alt](/absolute/path.png). Text you " +
  "write before a tool call can reach them only as a short summary. Don't ask it again in " +
  "this turn.";
