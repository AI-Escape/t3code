import { describe, expect, it } from "@effect/vitest";

import { questionBrief, type QuestionMessage } from "./questionBrief.ts";

const msg = (
  createdAt: number,
  text: string,
  extra: Partial<QuestionMessage> = {},
): QuestionMessage => ({ role: "assistant", text, createdAt, runId: "run-1", ...extra });

describe("t4 question brief", () => {
  it("is Claude's reply after asking", () => {
    const said = [msg(10, "Reading the code."), msg(30, "The plan: ...")];
    expect(questionBrief({ said, askedAt: 20, askedRunId: "run-1" })?.text).toBe("The plan: ...");
  });

  it("is Codex's last message before asking", () => {
    const said = [msg(10, "Reading the code."), msg(15, "The plan: ...")];
    expect(questionBrief({ said, askedAt: 20, askedRunId: "run-1" })?.text).toBe("The plan: ...");
  });

  it("leads with what the agent sent with send_to_user before asking (USA-3219)", () => {
    const said = [
      msg(5, "Mapping where action items are listed."),
      msg(12, "**USA-3219 plan** ...", { sent: true }),
      msg(30, "The plan for USA-3219 is in the message above, and the approval card is open."),
      msg(40, "From the user", { role: "user", runId: "run-2" }),
    ];
    const brief = questionBrief({ said, askedAt: 13, askedRunId: "run-1" });
    expect(brief?.text).toBe(
      "**USA-3219 plan** ...\n\nThe plan for USA-3219 is in the message above, and the approval card is open.",
    );
    expect(brief?.createdAt).toBe(30);
    expect(brief?.parts?.map((p) => p.createdAt)).toEqual([12, 30]);
  });

  it("is the sent message alone when the turn wrote nothing else", () => {
    const said = [msg(12, "The plan", { sent: true })];
    const brief = questionBrief({ said, askedAt: 13, askedRunId: "run-1" });
    expect(brief?.text).toBe("The plan");
    expect(brief?.parts).toBeUndefined();
  });

  it("leaves out other runs' messages", () => {
    const said = [
      msg(5, "Earlier turn's draft", { sent: true, runId: "run-0" }),
      msg(30, "The plan"),
    ];
    const brief = questionBrief({ said, askedAt: 20, askedRunId: "run-1" });
    expect(brief?.text).toBe("The plan");
  });

  it("is undefined when the asking turn wrote nothing", () => {
    expect(questionBrief({ said: [], askedAt: 20, askedRunId: "run-1" })).toBeUndefined();
  });
});
