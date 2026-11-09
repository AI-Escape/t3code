/**
 * t4 fork: on a phone the thread view is framed to the visible area so the composer
 * sits above the keyboard (iOS in-app browsers left it hidden). It measures rather than
 * computes: iOS reports the keyboard's pan in both `visualViewport.offsetTop` and
 * `scrollY`. Framed views are `position: fixed` because #root clips its overflow.
 */
import type { CSSProperties, RefCallback } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { isElectron } from "../env";

interface Frame {
  readonly height: number;
  readonly shift: number;
}

export function useKeyboardViewportFrame(): {
  readonly ref: RefCallback<HTMLElement>;
  readonly style: CSSProperties | undefined;
} {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  // The shift the view is rendered with now; a measurement subtracts it.
  const applied = useRef(0);
  // Where the view's top sits in the visible area with nothing panned.
  const restingTop = useRef<number | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the next measurement reads the shift the DOM is rendered with, after commit
  useLayoutEffect(() => {
    applied.current = frame?.shift ?? 0;
  }, [frame]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to visualViewport and window scroll/resize to measure the DOM
  useEffect(() => {
    const viewport = typeof window === "undefined" ? undefined : window.visualViewport;
    if (
      node === null ||
      isElectron ||
      viewport === undefined ||
      viewport === null ||
      // Phones only: a tablet keeps its sidebar beside the view.
      !window.matchMedia("(pointer: coarse) and (max-width: 767px)").matches
    ) {
      return;
    }
    let request: number | null = null;
    const measure = () => {
      request = null;
      // Pinch zoom moves the visual viewport too; leave a zoomed page alone.
      if (Math.abs(viewport.scale - 1) > 0.01) {
        setFrame(null);
        return;
      }
      // On iOS getBoundingClientRect is already relative to the visible area
      // (keyboard up: offsetTop = scrollY = 293, the fixed view's rect.top -293),
      // so subtracting offsetTop too pushed the header mid-screen. Only the
      // rendered shift is taken out.
      const rectTop = node.getBoundingClientRect().top;
      const unshiftedTop = rectTop - applied.current;
      if (restingTop.current === null) restingTop.current = Math.max(0, unshiftedTop);
      const resting = restingTop.current;
      setFrame({
        height: Math.max(0, Math.round(viewport.height - resting)),
        shift: Math.round(resting - unshiftedTop),
      });
    };
    const update = () => {
      if (request !== null) cancelAnimationFrame(request);
      request = requestAnimationFrame(measure);
    };
    measure();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    window.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      if (request !== null) cancelAnimationFrame(request);
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [node]);

  return {
    ref: setNode,
    style:
      frame === null
        ? undefined
        : {
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            height: `${frame.height}px`,
            ...(frame.shift === 0 ? {} : { transform: `translateY(${frame.shift}px)` }),
          },
  };
}
