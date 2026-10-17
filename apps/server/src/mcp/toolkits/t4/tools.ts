/**
 * t4 fork: session-tooling MCP tools - handoffs with an explicit ledger
 * effect, what a thread owes, the user's decisions, and linked issues.
 * Behaviour contract: t4's `t3agents.py` (`cmd_handoff`, `cmd_owed`,
 * `cmd_decisions`); docs/t4/DESIGN.md.
 */
import { OrchestratorMcpFailure, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as T4Config from "../../../t4/T4Config.ts";
import * as T4Delivery from "../../../t4/T4Delivery.ts";
import * as T4Ledger from "../../../t4/T4Ledger.ts";
import * as T4Store from "../../../t4/T4Store.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ThreadRef = Schema.String.annotate({
  description:
    "A thread: its id, the first characters of its id (as `t3_thread_list` shows), or its exact or unique partial title.",
});

const common = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ThreadLaunch.ThreadLaunchService,
    Project.ProjectService,
    T4Config.T4ServerConfig,
    T4Delivery.T4Delivery,
    T4Ledger.T4Ledger,
    T4Store.T4Store,
    Crypto.Crypto,
  ],
};

const ThreadSummary = Schema.Struct({
  threadId: ThreadId,
  shortId: Schema.String,
  title: Schema.String,
  state: Schema.String,
});

const HandoffTool = Tool.make("t3_handoff", {
  ...common,
  description: [
    "Hand work to another thread with an explicit effect on the handoff ledger (who owes whom an answer). The ledger moves only on these flags, never on wording.",
    "Without `to`: hand your finished work to this project's release manager. That always asks it to release (it then owes you an answer); a release manager is created and pinned if the project has none. The release manager itself must name `to`.",
    "With `to`: say what the handoff does - `done` answers what you owe that thread (settles its handoff to you), `ask` makes it owe you a reply, `fyi` does neither. `done` combines with `ask` (finished, and asking something new) or `fyi` (finished, nothing more). A handoff to a release manager from any other thread is always a request.",
    "`interrupt` stops the recipient's running turn and restarts it with your message; otherwise a running turn gets it steered in.",
    "`check` returns the project's release manager without sending anything.",
  ].join(" "),
  parameters: Schema.Struct({
    message: Schema.optional(
      Schema.String.annotate({ description: "What you hand over. Required unless `check`." }),
    ),
    to: Schema.optional(ThreadRef),
    done: Schema.optional(Schema.Boolean),
    ask: Schema.optional(Schema.Boolean),
    fyi: Schema.optional(Schema.Boolean),
    interrupt: Schema.optional(Schema.Boolean),
    check: Schema.optional(Schema.Boolean),
    includeRetired: Schema.optional(
      Schema.Boolean.annotate({
        description:
          "With `check` or no `to`: also consider a settled or archived release manager.",
      }),
    ),
  }),
  success: Schema.Struct({
    to: Schema.NullOr(ThreadSummary),
    isReleaseManager: Schema.Boolean,
    createdReleaseManager: Schema.Boolean,
    delivery: Schema.NullOr(Schema.String),
    settled: Schema.Number,
    nowOwesYou: Schema.Boolean,
    youStillOweThem: Schema.Boolean,
    notes: Schema.Array(Schema.String),
  }),
}).annotate(Tool.Destructive, false);

const OwedEntry = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  from: ThreadSummary,
  to: ThreadSummary,
  summary: Schema.String,
  createdAt: Schema.String,
  age: Schema.String,
});

const OwedTool = Tool.make("t3_owed", {
  ...common,
  description:
    "What you still owe: open handoffs to your thread, oldest first. Answer each with `t3_handoff` (`to` that thread, `done`; add `fyi` when you ask nothing back). `all` lists every open entry in your project. A debt to a thread that has since settled, archived or been deleted is void and not listed.",
  parameters: Schema.Struct({
    all: Schema.optional(Schema.Boolean),
    projectId: Schema.optional(ProjectId),
  }),
  success: Schema.Struct({ entries: Schema.Array(OwedEntry) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const DecisionEntry = Schema.Struct({
  answeredAt: Schema.String,
  threadId: ThreadId,
  threadTitle: Schema.String,
  question: Schema.String,
  answer: Schema.String,
  isNote: Schema.Boolean.annotate({
    description:
      "The answer is not one of the offered options: the user wrote it, and it is a standing rule.",
  }),
});

const DecisionsTool = Tool.make("t3_decisions", {
  ...common,
  description:
    "The user's answers to ask-user questions, newest first: this project (or `all` projects) over the last `days` (default 14). An answer that isn't one of the offered options is a note the user wrote - treat it as a standing rule.",
  parameters: Schema.Struct({
    days: Schema.optional(Schema.Number),
    all: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({ decisions: Schema.Array(DecisionEntry) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const IssueTarget = {
  identifier: Schema.optional(
    Schema.String.annotate({ description: "The issue identifier, e.g. USA-1234." }),
  ),
  url: Schema.optional(Schema.String.annotate({ description: "The issue URL." })),
  thread: Schema.optional(ThreadRef.annotate({ description: "Omit for your own thread." })),
};

const IssueLinkEntry = Schema.Struct({
  provider: Schema.String,
  identifier: Schema.String,
  url: Schema.NullOr(Schema.String),
  title: Schema.NullOr(Schema.String),
  linkedAt: Schema.String,
});

const LinkIssueTool = Tool.make("link_issue", {
  ...common,
  description:
    "Link an issue (Linear) to a thread, making that thread its owner: link every issue you take ownership of. Linking an issue another open thread owns is refused, naming that thread, unless `force`. Settling or archiving a thread releases its issues.",
  parameters: Schema.Struct({
    ...IssueTarget,
    title: Schema.optional(Schema.String),
    force: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({
    linked: Schema.Boolean,
    alreadyLinked: Schema.Boolean,
    issue: IssueLinkEntry,
    previousOwner: Schema.NullOr(ThreadSummary),
  }),
}).annotate(Tool.Destructive, false);

const UnlinkIssueTool = Tool.make("unlink_issue", {
  ...common,
  description:
    "Unlink an issue from a thread, e.g. one you hand back. Unlinking an issue that isn't linked succeeds with wasLinked=false.",
  parameters: Schema.Struct(IssueTarget),
  success: Schema.Struct({ wasLinked: Schema.Boolean, identifier: Schema.String }),
}).annotate(Tool.Destructive, false);

const ListThreadIssuesTool = Tool.make("list_thread_issues", {
  ...common,
  description:
    "The issues linked to a thread (omit `thread` for yours), and whether the thread currently owns them (it does while it is open).",
  parameters: Schema.Struct({ thread: IssueTarget.thread }),
  success: Schema.Struct({ owner: Schema.Boolean, issues: Schema.Array(IssueLinkEntry) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const T4Toolkit = Toolkit.make(
  HandoffTool,
  OwedTool,
  DecisionsTool,
  LinkIssueTool,
  UnlinkIssueTool,
  ListThreadIssuesTool,
);
