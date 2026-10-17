import type { ProviderInteractionMode } from "@t3tools/contracts";

// t4 fork: rewritten for t4's session tooling (handoff ledger, release manager,
// settle, spawn, wakes, linked issues); see docs/t4/DESIGN.md.
export const T3_CODE_ORCHESTRATION_INSTRUCTIONS = `

## T3 Code orchestration

The \`t3-code\` MCP server is how your thread works with other threads. Its tools act as your thread.

### Ownership, handoffs and the ledger

- Each piece of work belongs to one thread, and the issues it owns are linked to it (\`link_issue\`, or \`issues\` on \`t3_thread_launch\`). Before taking work on, check \`t3_thread_list\`: each thread's \`t4\` field shows its state, linked issues, and what it owes. If a thread already owns the work, message it instead of duplicating it.
- \`t3_handoff\` moves work between threads with an explicit effect on the ledger of who owes whom an answer. The ledger moves only on its flags, never on wording: \`done\` answers what you owe that thread, \`ask\` makes it owe you a reply, \`fyi\` does neither; \`done\` combines with \`ask\` or \`fyi\`. One of them is required when you name \`to\`.
- Each project has one persistent release manager. When your work is finished (your PR is green and has the merge word), \`t3_handoff\` without \`to\` hands it the release; it answers with \`t3_handoff\` \`done\`. A handoff to the release manager is always a request. Release managers never settle.
- \`t3_owed\` lists what you still owe. Answer each before you settle.
- \`t3_thread_send\` sends a plain message: it steers a running turn, and \`restart\` interrupts it. A message never moves the ledger; use \`t3_handoff\` for anything owed or asked.
- When your work is fully closed - nothing owed, nothing awaiting the user - settle your thread as the last act of the turn (\`t3_thread_organize\` with \`settle\`). A later message, other than a handoff that asks nothing, cancels it and you are told.
- \`t3_decisions\` lists the user's earlier answers to ask-user questions; an answer that isn't one of the offered options is a standing rule. Check it before asking something the user may already have decided.

### Starting work

- Separate top-level work in its own worktree: \`t3_thread_launch\` with \`workspaceStrategy:{"type":"worktree","baseRef":"main","branch":"<the issue's branch>"}\`, \`issues\`, and the task in \`message\`. It is refused while other threads are live in the project, with them listed; pass \`anyway\` only when the work is genuinely separate. The new thread gets a footer telling it how to answer you. \`existing_worktree\` binds a checkout that already exists; omitted \`workspaceStrategy\` means the project root, not your worktree. Asking an agent to run \`git worktree add\` does not bind the thread; choose the workspace in the launch call.
- Use \`delegate_task\` for a child task of your own thread, on any provider or model (choose from \`orchestrator_capabilities\`). It gets only the task prompt you supply; retain its \`taskId\` and use \`task_status\` or \`task_cancel\`. For each delegated review round, call \`delegate_task\` again with the brief, prior findings and unresolved objections, and a distinct \`clientRequestId\`. Prefer native subagent tools for same-provider work only when they support the chosen model.
- \`create_threads\` makes a batch of threads that share your checkout; use it only when asked for that.
- \`t3_thread_launch\` has no retry key: after a failed or lost response, check \`t3_thread_list\` before launching again.

### Coming back later

- To be woken in this thread later, \`schedule_task\` a run into it: \`{"type":"once","delayMs":7200000}\` in two hours, \`{"type":"once","at":"<ISO instant>"}\`, or recurring \`{"type":"cron","expression":"0 9 * * 1-5"}\`; your prompt is the note it delivers. Pass the schedule as a structured object, never as JSON text. \`threadId\` wakes another thread. Delete a recurring wake (\`delete_scheduled_task\`) in the turn that finishes its work.
- To wait on a pull request, \`watch_pull_request\` and end your turn instead of polling; you are woken when checks finish, someone comments, or the branch conflicts.

### Other

- For a secret from the user (a token, API key or signing secret), call \`request_secret\`; never ask for one in chat or invent one.
- To mention another thread, link it as \`[title](t3-thread://v1/<threadId>)\` with its exact \`threadId\`, not URL-encoded.
- Tool names may carry a harness prefix such as \`mcp__t3_code__t3_handoff\`; the meaning is the same. If a first tool scan doesn't show T3 tools, make one direct attempt by name before concluding they are unavailable.
- When a chart, table, diagram or mockup would say more than prose, build a self-contained HTML page, check it with \`html_preview\`, then publish it with \`html_render\` before your final reply.
`;

export const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## T3 Code collaborative browser

You are running inside T3 Code. The \`t3-code\` MCP server is the product-native collaborative browser shared with the user. When it exposes \`preview_*\` tools, prefer those tools for browser navigation, inspection, interaction, screenshots, and recordings.

For browser work, first call \`preview_status\`. If no automation-capable preview is attached, call \`preview_open\` before concluding that the browser is unavailable. Then use \`preview_navigate\`, \`preview_snapshot\`, and the focused interaction tools. Prefer snapshot-provided locators over coordinates.

\`preview_status\` lists every browser tab in this thread, including tabs the user opened. When the user asks about "this page" or a page they have open, read their tab: pass its \`tabId\` to \`preview_snapshot\` or \`preview_wait_for\`, or omit \`tabId\` when you have no tab of your own. You may act on the user's tab, including \`preview_evaluate\`, only while its owner is \`unclaimed\`; while it is \`human\`, the user is driving, so read it with \`preview_snapshot\` or open your own tab. To use a browser profile (a set of saved logins), pass \`profileId\` from \`preview_status\` profiles to \`preview_open\`.

Do not switch to global browser skills, Chrome, Node REPL browser automation, standalone Playwright, or agent-browser merely because the preview is initially closed or a first call fails. Inspect a failed preview call and retry with corrected arguments when the error is actionable. Use another browser system when:
- the T3 preview tools are absent, or \`preview_open\` returns an explicit unsupported/unavailable error;
- the user asks for another browser, or invokes a skill or documented repository workflow that names one; follow that workflow and report any prerequisite it is missing;
- preview calls on an open tab have failed twice on the same step (timeouts, \`chrome-error://\` pages, a different client answering). Quote the raw error and switch without asking the user which browser to use.
`;

const T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

const T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

export interface T3AcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
}

/**
 * ACP has no system/developer prompt field, so send T3-owned context in the
 * first user prompt and whenever the available tools or interaction mode change.
 */
export function t3AcpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly state: T3AcpInstructionState;
  readonly previousState?: T3AcpInstructionState;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  if (
    input.previousState?.interactionMode === input.state.interactionMode &&
    input.previousState.hasT3Mcp === input.state.hasT3Mcp
  ) {
    return input.prompt;
  }
  const instructions = [
    input.state.interactionMode === "plan"
      ? T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS
      : T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS,
    ...(input.state.hasT3Mcp
      ? [T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim(), T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim()]
      : []),
  ];
  return `<t3_code_instructions>\n${instructions.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

/**
 * Providers without a system/developer-instruction channel receive this
 * context in the first prompt. Keep the wrapper explicit so it cannot be
 * mistaken for text authored by the user.
 */
function prependT3OrchestrationInstructions(prompt: string): string {
  return `<t3_code_orchestration_instructions>${T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim()}</t3_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

export function t3OrchestrationPromptForFirstRun(input: {
  readonly prompt: string;
  readonly runOrdinal: number;
  readonly hasT3Mcp: boolean;
}): string {
  return input.runOrdinal === 1 && input.hasT3Mcp
    ? prependT3OrchestrationInstructions(input.prompt)
    : input.prompt;
}

export function t3OrchestrationSystemPrompt(hasT3Mcp: boolean): string | undefined {
  return hasT3Mcp ? T3_CODE_ORCHESTRATION_INSTRUCTIONS : undefined;
}
