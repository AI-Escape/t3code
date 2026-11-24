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
  "write before a tool call can reach them only as a short summary. It replaces any earlier " +
  "question of yours still open, so it must hold every decision still open. Don't ask it " +
  "again in this turn unless it left one out.";

/**
 * Upstream names a question's subject as a use of send_to_user; with message-mode questions the
 * brief belongs in the final reply, where the dashboard's card reads it (AI-154).
 */
export const T4_CLAUDE_SEND_TO_USER_INSTRUCTIONS = `
### Text the user must read mid-turn

Text you write before a tool call may reach the user only as a one-line summary. When the user must read something in full before your turn ends, such as a draft or a code block, send it with \`send_to_user\`. What a question you ask refers to is not that: ask it, then end the turn with it all as your final reply. Put everything else in your final reply.
`;
