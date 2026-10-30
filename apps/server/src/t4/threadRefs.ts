/**
 * t4 fork: every MCP tool's `threadId` takes what t4 hands out.
 *
 * t4's own tools resolve a thread by full id, id prefix, short id or title
 * (resolveThreadRef); T3's thread tools took only the exact id, so agents
 * replying to a handoff header's short id, a bare uuid or a title got
 * "Thread … is no longer available" - 63 failed calls in a week (usa-rs,
 * ai-escape, 2026-10-29). A `threadId` that names no thread exactly is
 * resolved here before the tool runs, so the tool's own checks apply to the
 * resolved thread; one that matches none or several is passed on unchanged
 * and fails as before.
 */
import { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { resolveThreadRef } from "./T4Threads.ts";

export const resolveThreadIdParam = <P>(params: P): Effect.Effect<P> =>
  Effect.gen(function* () {
    if (!Predicate.hasProperty(params, "threadId") || typeof params.threadId !== "string") {
      return params;
    }
    const threads = yield* Effect.serviceOption(ThreadManagementService.ThreadManagementService);
    if (Option.isNone(threads)) return params;
    const ref = params.threadId.trim();
    if (ref.length === 0) return params;
    const exact = yield* threads.value
      .getThreadShell(ThreadId.make(ref))
      .pipe(Effect.orElseSucceed(() => null));
    if (exact !== null && exact.deletedAt === null) return params;
    const snapshot = yield* threads.value.getShellSnapshot().pipe(Effect.orElseSucceed(() => null));
    if (snapshot === null) return params;
    const found = resolveThreadRef(
      ref,
      [...snapshot.threads, ...snapshot.archivedThreads].filter(
        (thread) => thread.deletedAt === null,
      ),
    );
    return found.type === "found" ? { ...params, threadId: found.thread.id } : params;
  }).pipe(
    // Best effort: whatever goes wrong here, the tool gets the reference as given.
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      () => Effect.succeed(params),
    ),
  );

/** A tool handler whose `threadId` is resolved first (resolveThreadIdParam). */
export const withThreadRef = <Handler>(handle: Handler): Handler =>
  (typeof handle === "function"
    ? (params: unknown) =>
        resolveThreadIdParam(params).pipe(
          Effect.flatMap((resolved) =>
            (handle as (params: unknown) => Effect.Effect<unknown>)(resolved),
          ),
        )
    : handle) as Handler;
