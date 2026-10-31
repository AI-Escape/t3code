/**
 * t4 fork: while a phone's software keyboard is open, the thread view takes
 * the visible part of the screen, so the composer sits right above the
 * keyboard.
 *
 * The thread route is `h-svh` under a body that cannot scroll, and T3 relies
 * on iOS panning the page to reveal the focused editor. Inside a Home Screen
 * app's in-app browser it did not: the composer stayed under the keyboard and
 * the user typed without seeing the text (ai-escape, 2026-10-31). Sizing the
 * view to `visualViewport.height` puts the composer above the keyboard, and
 * following `offsetTop` keeps it in place when iOS does pan.
 */
import type { CSSProperties } from "react";
import { useEffect, useState } from "react";

import { isElectron } from "../env";
import { useSoftwareKeyboardOpen } from "./useSoftwareKeyboardOpen";

interface Frame {
  readonly height: number;
  readonly top: number;
}

export function useKeyboardViewportFrame(): CSSProperties | undefined {
  const keyboardOpen = useSoftwareKeyboardOpen();
  const [frame, setFrame] = useState<Frame | null>(null);

  useEffect(() => {
    const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
    if (!keyboardOpen || isElectron || viewport === undefined || viewport === null) {
      setFrame(null);
      return;
    }
    const update = () => {
      // Pinch zoom moves the visual viewport too; leave a zoomed page alone.
      if (Math.abs(viewport.scale - 1) > 0.01) {
        setFrame(null);
        return;
      }
      // iOS reveals a focused field by moving the visual viewport or by
      // scrolling the page; either way the frame follows what is on screen.
      setFrame({
        height: Math.round(viewport.height),
        top: Math.round(viewport.offsetTop + window.scrollY),
      });
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    window.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("scroll", update);
    };
  }, [keyboardOpen]);

  return frame === null
    ? undefined
    : { height: `${frame.height}px`, transform: `translateY(${frame.top}px)` };
}
