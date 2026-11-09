// @effect-diagnostics nodeBuiltinImport:off - the test makes real folders in a temp dir.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import { worktreeRefusal } from "./T4Spawn.ts";

const run = <A, E>(effect: Effect.Effect<A, E, ProcessRunner.ProcessRunner>) =>
  effect.pipe(
    Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  ) as Effect.Effect<A, E, never>;

describe("t4 worktreeRefusal", () => {
  it.live("refuses a project folder that is not a git checkout", () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t4-norepo-"));
      const refused = yield* run(worktreeRefusal({ title: "opencode", workspaceRoot: root }));
      expect(refused).toContain("is not a git repository");
      expect(refused).toContain("nothing was created");
    }),
  );

  it.live("accepts a git checkout", () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t4-repo-"));
      NodeChildProcess.execFileSync("git", ["init", "-q", root]);
      expect(yield* run(worktreeRefusal({ title: "usa-rs", workspaceRoot: root }))).toBeUndefined();
    }),
  );

  it.live("refuses a folder that does not exist", () =>
    Effect.gen(function* () {
      const refused = yield* run(
        worktreeRefusal({ title: "gone", workspaceRoot: "/nonexistent/t4-spawn-test" }),
      );
      expect(refused).toContain("is not a git repository");
    }),
  );
});
