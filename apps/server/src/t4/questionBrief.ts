/**
 * t4 fork (AI-116, AI-154): an open question's brief. Claude writes it right after asking, Codex
 * before. `send_to_user` text is a tool call, passed in marked `sent`: USA-3219 sent its plan that
 * way and the card showed only "The plan ... is in the message above".
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
