/**
 * t4 fork (AI-116, AI-154): what the agent wrote for an open question - its brief - for the
 * dashboard's card and question window.
 *
 * Claude asks first and writes the brief right after (message-mode questions); Codex writes it
 * before asking. Text an agent posts with `send_to_user` is a tool call, not a message, so it is
 * passed in here as a message marked `sent`: usa-rs USA-3219 posted its plan that way, ended with
 * "The plan ... is in the message above", and the card showed only that line.
 */
export interface QuestionMessage<RunId = string> {
  readonly role: string;
  readonly text: string;
  readonly createdAt: number;
  readonly runId: RunId | null;
  /** Posted with `send_to_user`. */
  readonly sent?: boolean;
}

export interface QuestionBrief<RunId = string> extends QuestionMessage<RunId> {
  /** The messages joined into the brief, in order, when there are several. */
  readonly parts?: ReadonlyArray<QuestionMessage<RunId>>;
}

export const questionBrief = <RunId>(input: {
  readonly said: ReadonlyArray<QuestionMessage<RunId>>;
  readonly askedAt: number;
  readonly askedRunId: RunId | null;
}): QuestionBrief<RunId> | undefined => {
  const ownRun = input.said
    .filter((m) => m.role === "assistant" && m.runId === input.askedRunId)
    .toSorted((a, b) => a.createdAt - b.createdAt);
  const pick = (candidates: ReadonlyArray<QuestionMessage<RunId>>) =>
    candidates.find((m) => m.createdAt >= input.askedAt) ??
    candidates.filter((m) => m.createdAt < input.askedAt).at(-1);
  const main = pick(ownRun.filter((m) => m.sent !== true)) ?? pick(ownRun);
  if (main === undefined) return undefined;
  // What the agent sent the user before asking belongs to the brief too.
  const sent = ownRun.filter(
    (m) => m.sent === true && m !== main && m.createdAt <= Math.max(input.askedAt, main.createdAt),
  );
  if (sent.length === 0) return main;
  const parts = [...sent, main].toSorted((a, b) => a.createdAt - b.createdAt);
  return {
    role: "assistant",
    text: parts.map((m) => m.text.trim()).join("\n\n"),
    createdAt: main.createdAt,
    runId: main.runId,
    parts,
  };
};
