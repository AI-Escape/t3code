/**
 * t4 fork: limit-stopped threads resume a few at a time, oldest stop first, at
 * the reset and from the dashboard's Resume all (one shared pace): ~20 at once
 * used a fresh 5-hour window in minutes (usa-rs, 2026-11-06). Per client:
 * `T4_LIMIT_RESUME_BATCH` per `T4_LIMIT_RESUME_GAP_MINUTES` (default 3 per 5).
 */
export interface ResumePace {
  readonly batch: number;
  readonly gapMs: number;
}

const HAND_OFF_MS = 2 * 60_000;

const positive = (raw: string | undefined, fallback: number) => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const resumePace = (env: NodeJS.ProcessEnv = process.env): ResumePace => ({
  batch: Math.floor(positive(env.T4_LIMIT_RESUME_BATCH, 3)),
  gapMs: positive(env.T4_LIMIT_RESUME_GAP_MINUTES, 5) * 60_000,
});

/** Not paced: the adapter reports a reset a minute past the stop when another account is free. */
export const isAccountHandOff = (stoppedAtMs: number, resetAtMs: number): boolean =>
  resetAtMs - stoppedAtMs <= HAND_OFF_MS;

let recent: ReadonlyArray<number> = [];

const prune = (nowMs: number, pace: ResumePace) =>
  (recent = recent.filter((at) => at > nowMs - pace.gapMs));

/** Takes a resume slot when the pace has one free now. */
export const takeResumeSlot = (nowMs: number, pace: ResumePace = resumePace()): boolean => {
  if (prune(nowMs, pace).length >= pace.batch) return false;
  recent = [...recent, nowMs];
  return true;
};

/** When the next resume slot frees up (`nowMs` when one is free). */
export const nextResumeSlotAt = (nowMs: number, pace: ResumePace = resumePace()): number => {
  const taken = prune(nowMs, pace);
  return taken.length < pace.batch ? nowMs : taken[taken.length - pace.batch]! + pace.gapMs;
};

let resumeRunActive = false;

/** One Resume all at a time: false while another is still working through its threads. */
export const claimResumeRun = (): boolean => {
  if (resumeRunActive) return false;
  resumeRunActive = true;
  return true;
};

export const releaseResumeRun = () => {
  resumeRunActive = false;
};

/** Test hook. */
export const resetResumePace = () => {
  recent = [];
  resumeRunActive = false;
};
