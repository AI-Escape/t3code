// @effect-diagnostics processEnvInEffect:off -- t4 settings come from the client container's env.
/**
 * Who may frame T3's web app (AI-131).
 *
 * Upstream v0.1.11 (#36395) answers every HTML page with `frame-ancestors
 * 'none'` and `X-Frame-Options: DENY`, so no site can frame it. The t4
 * dashboard opens T3 in a full-screen frame on a phone (`T3Frame.tsx`), and
 * after the v0.1.11 rollout that frame was a white screen. `T4_FRAME_ANCESTORS`
 * (compose) lists the origins allowed to frame T3 - the dashboard's - and every
 * other site is still refused. X-Frame-Options has no allow-list, so it is left
 * out when origins are named; browsers that read `frame-ancestors` ignore it.
 */

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
