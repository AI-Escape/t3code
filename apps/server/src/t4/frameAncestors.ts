// @effect-diagnostics processEnvInEffect:off -- t4 settings come from the client container's env.
// t4 fork: upstream sends `frame-ancestors 'none'`, which blanks the t4 dashboard's phone frame.
// T4_FRAME_ANCESTORS names the origins allowed to frame T3; every other site is still refused.
// X-Frame-Options has no allow-list, so it is left out when origins are named.

const ORIGIN = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i;

/** The origins in a comma- or space-separated list; anything not a plain origin is dropped. */
export function parseFrameAncestors(raw: string | undefined): ReadonlyArray<string> {
  return (raw ?? "")
    .split(/[\s,]+/)
    .map((value) => value.trim().replace(/\/+$/, ""))
    .filter((value) => ORIGIN.test(value));
}

export function frameHeaders(origins: ReadonlyArray<string>): Record<string, string> {
  if (origins.length === 0) {
    return { "Content-Security-Policy": "frame-ancestors 'none'", "X-Frame-Options": "DENY" };
  }
  return { "Content-Security-Policy": `frame-ancestors 'self' ${origins.join(" ")}` };
}

export const T4_SPA_FRAME_HEADERS = frameHeaders(
  parseFrameAncestors(process.env.T4_FRAME_ANCESTORS),
);
