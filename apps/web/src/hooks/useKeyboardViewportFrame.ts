/**
 * t4 fork: on a touch screen the thread view is the visible part of the
 * screen, so the composer always sits right above the software keyboard.
 *
 * The thread route is `h-svh` under a body that cannot scroll. Safari reveals
 * a focused editor by panning the page, but the in-app browser a Home Screen
 * app opens links in shrinks the whole page for the keyboard instead - and
 * `svh` does not shrink with it, so the view kept its full height and the
 * composer was cut off under the keyboard: the user typed blind (ai-escape,
 * 2026-10-31). Sizing the view to `visualViewport.height`, and following its
 * offset and any page scroll, covers both: a shrunken page and a panned one.
 */
import type { CSSProperties } from "react";
import { useEffect, useState } from "react";

import { isElectron } from "../env";

interface Frame {
  readonly height: number;
  readonly top: number;
}

export function useKeyboardViewportFrame(): CSSProperties | undefined {
  const [frame, setFrame] = useState<Frame | null>(null);

  useEffect(() => {
    const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
    if (
      isElectron ||
      viewport === undefined ||
      viewport === null ||
      !window.matchMedia("(pointer: coarse)").matches
    ) {
      return;
    }
    const update = () => {
      // Pinch zoom moves the visual viewport too; leave a zoomed page alone.
      if (Math.abs(viewport.scale - 1) > 0.01) {
        setFrame(null);
        return;
      }
      setFrame({
        height: Math.round(viewport.height),
        top: Math.round(viewport.offsetTop + window.scrollY),
      });
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    window.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  return frame === null
    ? undefined
    : {
        height: `${frame.height}px`,
        ...(frame.top === 0 ? {} : { transform: `translateY(${frame.top}px)` }),
      };
}
