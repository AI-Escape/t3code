/**
 * t4 fork: with `T4_SPAWN_BROKER=1`, git, gh, ps and lsof start in a small Node helper over IPC,
 * since forking the ~1.3 GB T3 process stalls its main thread. Long-lived processes, anything the
 * helper can't take (pipelines, extra fds, non-pipe stdio) and starts while it is down use the
 * normal spawner. Release and kill follow `@effect/platform-node-shared/NodeChildProcessSpawner`.
 */
// @effect-diagnostics globalTimers:off
// @effect-diagnostics nodeBuiltinImport:off -- the helper is a Node child process with an IPC channel, fed and read through Node streams.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSink from "@effect/platform-node/NodeSink";
import * as EffectNodeStream from "@effect/platform-node/NodeStream";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const enabled = () => process.env.T4_SPAWN_BROKER === "1";

// The helper: CommonJS, run with `node -e`. It spawns, streams output back,
// and kills every process group it started when T3 goes away.
const HELPER_SOURCE = String.raw`"use strict";
const cp = require("node:child_process");
const kids = new Map();
const send = (message) => { if (process.connected) process.send(message); };
const errorOf = (e) => ({ message: String(e && e.message), code: e && e.code, errno: e && e.errno, syscall: e && e.syscall, path: e && e.path });
process.on("message", (m) => {
  if (m.t === "spawn") {
    let child;
    try {
      child = cp.spawn(m.command, m.args, { cwd: m.cwd, env: m.env, shell: m.shell, detached: true, stdio: "pipe", windowsHide: true });
    } catch (e) {
      send({ t: "error", id: m.id, error: errorOf(e) });
      return;
    }
    kids.set(m.id, child);
    child.on("error", (e) => send({ t: "error", id: m.id, error: errorOf(e) }));
    child.on("spawn", () => send({ t: "spawned", id: m.id, pid: child.pid }));
    child.stdout.on("data", (data) => send({ t: "out", id: m.id, fd: 1, data }));
    child.stderr.on("data", (data) => send({ t: "out", id: m.id, fd: 2, data }));
    child.stdout.on("end", () => send({ t: "eof", id: m.id, fd: 1 }));
    child.stderr.on("end", () => send({ t: "eof", id: m.id, fd: 2 }));
    child.stdin.on("error", () => {});
    child.on("exit", (code, signal) => send({ t: "exit", id: m.id, code, signal }));
    child.on("close", () => kids.delete(m.id));
  } else if (m.t === "stdin") {
    const child = kids.get(m.id);
    if (child) child.stdin.write(Buffer.from(m.data));
  } else if (m.t === "stdin-end") {
    const child = kids.get(m.id);
    if (child) child.stdin.end();
  }
});
process.on("disconnect", () => {
  for (const child of kids.values()) {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
  }
  process.exit(0);
});
`;

interface HelperError {
  readonly message: string;
  readonly code?: string;
  readonly errno?: number;
  readonly syscall?: string;
  readonly path?: string;
}

type ExitInfo = readonly [code: number | null, signal: NodeJS.Signals | null];

interface Entry {
  readonly started: (
    result:
      | { readonly pid: number }
      | { readonly error: HelperError }
      | { readonly helperGone: true },
  ) => void;
  readonly stdout: NodeStream.PassThrough;
  readonly stderr: NodeStream.PassThrough;
  readonly exit: Deferred.Deferred<ExitInfo>;
  pid: number | undefined;
  abandoned: boolean;
  ended: number;
}

type HelperMessage =
  | { readonly t: "spawned"; readonly id: number; readonly pid: number }
  | { readonly t: "error"; readonly id: number; readonly error: HelperError }
  | { readonly t: "out"; readonly id: number; readonly fd: 1 | 2; readonly data: Uint8Array }
  | { readonly t: "eof"; readonly id: number; readonly fd: 1 | 2 }
  | {
      readonly t: "exit";
      readonly id: number;
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    };

const GRACE_MS = 1_000;
const POLL_MS = 10;

// Effect's mapping of a Node errno failure (platform-node-shared internal/utils.ts).
const errnoError = (
  module: "ChildProcess" | "FileSystem",
  method: string,
  error: HelperError | NodeJS.ErrnoException,
  pathOrDescriptor: string,
) => {
  const reasons: Record<string, PlatformError.SystemErrorTag> = {
    ENOENT: "NotFound",
    EACCES: "PermissionDenied",
    EEXIST: "AlreadyExists",
    EISDIR: "BadResource",
    ENOTDIR: "BadResource",
    EBUSY: "Busy",
    ELOOP: "BadResource",
  };
  const cause =
    error instanceof Error
      ? error
      : Object.assign(new Error(error.message), {
          code: error.code,
          errno: error.errno,
          syscall: error.syscall,
          path: error.path,
        });
  return PlatformError.systemError({
    _tag: reasons[error.code ?? ""] ?? "Unknown",
    module,
    method,
    pathOrDescriptor,
    syscall: error.syscall,
    cause,
  });
};

const commandText = (command: ChildProcess.StandardCommand) =>
  `${command.command} ${command.args.join(" ")}`;

const SHORT_COMMANDS = new Set(["git", "gh", "ps", "lsof"]);

/** Commands the helper runs: a named command, every stdio a pipe, no extra fds. */
const brokerable = (
  command: ChildProcess.Command,
  names: ReadonlySet<string> | "any",
): command is ChildProcess.StandardCommand => {
  if (command._tag !== "StandardCommand") return false;
  if (names !== "any" && !names.has(NodePath.basename(command.command))) return false;
  const options = command.options;
  const isPipe = (value: unknown) => value === undefined || value === "pipe";
  return (
    options.additionalFds === undefined &&
    isPipe(options.stdin) &&
    isPipe(options.stdout) &&
    isPipe(options.stderr) &&
    options.detached !== false
  );
};

const makeHelper = () => {
  let helper: NodeChildProcess.ChildProcess | undefined;
  let nextId = 1;
  const entries = new Map<number, Entry>();

  const failAll = () => {
    for (const [id, entry] of entries) {
      entries.delete(id);
      if (entry.pid === undefined) {
        entry.started({ helperGone: true });
      } else {
        entry.stdout.end();
        entry.stderr.end();
        Deferred.doneUnsafe(entry.exit, Exit.succeed([null, "SIGKILL"] as const));
      }
    }
  };

  // Forgotten once it has exited and both outputs ended.
  const forgetIfDone = (id: number, entry: Entry) => {
    if (entry.ended === 2 && Deferred.isDoneUnsafe(entry.exit)) entries.delete(id);
  };

  const onMessage = (message: HelperMessage) => {
    const entry = entries.get(message.id);
    if (entry === undefined) return;
    switch (message.t) {
      case "spawned":
        entry.pid = message.pid;
        if (entry.abandoned) {
          try {
            process.kill(-message.pid, "SIGTERM");
          } catch {
            // already gone
          }
        }
        entry.started({ pid: message.pid });
        return;
      case "error":
        if (entry.pid === undefined) {
          entries.delete(message.id);
          entry.started({ error: message.error });
        }
        return;
      case "out":
        (message.fd === 1 ? entry.stdout : entry.stderr).write(message.data);
        return;
      case "eof":
        (message.fd === 1 ? entry.stdout : entry.stderr).end();
        entry.ended += 1;
        forgetIfDone(message.id, entry);
        return;
      case "exit":
        Deferred.doneUnsafe(entry.exit, Exit.succeed([message.code, message.signal] as const));
        forgetIfDone(message.id, entry);
        return;
    }
  };

  const current = (): NodeChildProcess.ChildProcess | undefined => {
    if (helper?.connected === true) return helper;
    try {
      const started = NodeChildProcess.spawn(process.execPath, ["-e", HELPER_SOURCE], {
        stdio: ["ignore", "ignore", "inherit", "ipc"],
        serialization: "advanced",
      });
      started.on("message", (message) => onMessage(message as HelperMessage));
      const gone = () => {
        if (helper === started) helper = undefined;
        failAll();
      };
      started.on("exit", gone);
      started.on("error", gone);
      started.unref();
      started.channel?.unref();
      helper = started;
      return started;
    } catch {
      return undefined;
    }
  };

  const send = (message: unknown) => {
    try {
      helper?.send(message as NodeChildProcess.Serializable);
    } catch {
      // the helper is gone; its exit handler fails what was pending
    }
  };

  return { entries, current, send, nextId: () => nextId++ };
};

// One helper for the whole server, started on first use.
let shared: ReturnType<typeof makeHelper> | undefined;

/** `fallback` for what the helper doesn't take; the helper for the rest. */
export const wrap = (
  fallback: ChildProcessSpawner.ChildProcessSpawner["Service"],
  names: ReadonlySet<string> | "any" = SHORT_COMMANDS,
): ChildProcessSpawner.ChildProcessSpawner["Service"] => {
  const helper = (shared ??= makeHelper());

  const resolveCwd = (command: ChildProcess.StandardCommand) =>
    command.options.cwd === undefined
      ? // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
        Effect.succeed(undefined)
      : Effect.tryPromise({
          try: () =>
            NodeFSP.access(command.options.cwd!).then(() => NodePath.resolve(command.options.cwd!)),
          catch: (error) =>
            errnoError(
              "FileSystem",
              "access",
              error as NodeJS.ErrnoException,
              command.options.cwd!,
            ),
        });

  const start = (command: ChildProcess.StandardCommand, cwd: string | undefined) =>
    Effect.callback<
      { readonly id: number; readonly entry: Entry } | undefined,
      PlatformError.PlatformError
    >((resume) => {
      if (helper.current() === undefined) {
        // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
        resume(Effect.succeed(undefined));
        return;
      }
      const id = helper.nextId();
      const options = command.options;
      const entry: Entry = {
        started: (result) =>
          "pid" in result
            ? resume(Effect.succeed({ id, entry }))
            : "helperGone" in result
              ? // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
                resume(Effect.succeed(undefined))
              : resume(
                  Effect.fail(
                    errnoError("ChildProcess", "spawn", result.error, commandText(command)),
                  ),
                ),
        stdout: new NodeStream.PassThrough(),
        stderr: new NodeStream.PassThrough(),
        exit: Deferred.makeUnsafe<ExitInfo>(),
        pid: undefined,
        abandoned: false,
        ended: 0,
      };
      helper.entries.set(id, entry);
      helper.send({
        t: "spawn",
        id,
        command: command.command,
        args: command.args,
        cwd,
        env: options.extendEnv ? { ...process.env, ...options.env } : (options.env ?? process.env),
        shell: options.shell,
      });
      return Effect.sync(() => {
        entry.abandoned = true;
        if (entry.pid !== undefined) {
          try {
            process.kill(-entry.pid, "SIGTERM");
          } catch {
            // already gone
          }
        }
      });
    });

  const isAlive = (entry: Entry) => {
    if (!Deferred.isDoneUnsafe(entry.exit)) return true;
    try {
      process.kill(-entry.pid!, 0);
      return true;
    } catch {
      return false;
    }
  };

  // Real timers, as Effect's spawner: a waiting release must not depend on the
  // fiber's Clock (a test clock never moves on its own).
  const awaitExit = (entry: Entry, millis: number) =>
    Effect.callback<void>((resume) => {
      let polls = Math.ceil(millis / POLL_MS);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const poll = () => {
        if (polls <= 0 || !isAlive(entry)) {
          resume(Effect.void);
          return;
        }
        polls -= 1;
        timer = setTimeout(poll, POLL_MS);
      };
      poll();
      return Effect.sync(() => clearTimeout(timer));
    });

  const terminate = Effect.fnUntraced(function* (
    command: ChildProcess.StandardCommand,
    entry: Entry,
    options: ChildProcess.KillOptions | undefined,
  ) {
    const signal = (name: NodeJS.Signals) =>
      Effect.try({
        try: () => {
          try {
            process.kill(-entry.pid!, name);
          } catch {
            process.kill(entry.pid!, name);
          }
        },
        catch: (error) =>
          errnoError("ChildProcess", "kill", error as NodeJS.ErrnoException, commandText(command)),
      });
    yield* signal(options?.killSignal ?? "SIGTERM");
    if (options?.forceKillAfter === undefined) {
      yield* awaitExit(entry, GRACE_MS);
    } else {
      yield* awaitExit(entry, Duration.toMillis(options.forceKillAfter));
      if (isAlive(entry)) {
        yield* signal("SIGKILL");
        yield* awaitExit(entry, GRACE_MS);
      }
    }
    yield* Deferred.await(entry.exit);
  });

  const spawnBrokered = Effect.fnUntraced(function* (command: ChildProcess.StandardCommand) {
    const cwd = yield* resolveCwd(command);
    const started = yield* Effect.acquireRelease(start(command, cwd), (started) => {
      if (started === undefined) return Effect.void;
      const { entry } = started;
      return Effect.gen(function* () {
        if (Deferred.isDoneUnsafe(entry.exit)) {
          // As Effect's spawner: after any exit with a code, signal the
          // group, so nothing the command left running outlives it.
          const [code] = yield* Deferred.await(entry.exit);
          if (code !== null) yield* Effect.ignore(terminate(command, entry, command.options));
          return;
        }
        yield* Effect.ignore(terminate(command, entry, command.options));
      });
    });
    if (started === undefined) return yield* fallback.spawn(command);
    const { id, entry } = started;
    const pid = entry.pid!;
    yield* Effect.forkScoped(
      Deferred.await(entry.exit).pipe(
        Effect.tap(([code]) =>
          Effect.sync(() => {
            if (code !== 0 && code !== null) {
              try {
                process.kill(-pid, command.options.killSignal ?? "SIGTERM");
              } catch {
                // best effort, as Effect's spawner
              }
            }
          }),
        ),
      ),
    );
    const readable = (stream: NodeStream.PassThrough, name: "stdout" | "stderr") =>
      EffectNodeStream.fromReadable<Uint8Array, PlatformError.PlatformError>({
        evaluate: () => stream,
        onError: (error) =>
          errnoError(
            "ChildProcess",
            `fromReadable(${name})`,
            error as NodeJS.ErrnoException,
            commandText(command),
          ),
      });
    const stdout = readable(entry.stdout, "stdout");
    const stderr = readable(entry.stderr, "stderr");
    const stdinWritable = new NodeStream.Writable({
      write(chunk: Uint8Array, _encoding, callback) {
        helper.send({ t: "stdin", id, data: chunk });
        callback();
      },
      final(callback) {
        helper.send({ t: "stdin-end", id });
        callback();
      },
    });
    const stdin = NodeSink.fromWritable<PlatformError.PlatformError, Uint8Array>({
      evaluate: () => stdinWritable,
      onError: (error) =>
        errnoError(
          "ChildProcess",
          "fromWritable(stdin)",
          error as NodeJS.ErrnoException,
          commandText(command),
        ),
      endOnDone: true,
      encoding: "utf-8",
    });
    const exitCode = Effect.flatMap(Deferred.await(entry.exit), ([code, signal]) =>
      code !== null
        ? Effect.succeed(ChildProcessSpawner.ExitCode(code))
        : Effect.fail(
            errnoError(
              "ChildProcess",
              "exitCode",
              { message: `Process interrupted due to receipt of signal: '${signal}'` },
              commandText(command),
            ),
          ),
    );
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(pid),
      exitCode,
      isRunning: Effect.sync(() => !Deferred.isDoneUnsafe(entry.exit)),
      kill: (options) => terminate(command, entry, options),
      stdin,
      stdout,
      stderr,
      all: Stream.merge(stdout, stderr),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });
  });

  return ChildProcessSpawner.make((command) =>
    brokerable(command, names) ? spawnBrokered(command) : fallback.spawn(command),
  );
};

/** The Node spawner with git, gh, ps and lsof started by the helper, when `T4_SPAWN_BROKER=1`. */
export const layer = Layer.effect(
  ChildProcessSpawner.ChildProcessSpawner,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return enabled() ? wrap(spawner) : spawner;
  }),
);

/** Node's services with the helper's spawner; the root of the CLI and server runtimes. */
export const layerNodeServices = Layer.merge(
  NodeServices.layer,
  layer.pipe(Layer.provide(NodeServices.layer)),
);
