/**
 * t4 fork: on a touch screen the thread view is the visible part of the
 * screen, so the composer always sits right above the software keyboard.
 *
 * The thread route is `h-svh` under a body that cannot scroll, and T3 relies
 * on iOS revealing the focused editor. In the in-app browser a Home Screen
 * app opens links in, the composer stayed under the keyboard and the user
 * typed blind (ai-escape, 2026-10-31). Two attempts that computed the offset
 * from viewport numbers failed on the phone (iOS reports the keyboard's pan
 * in both `visualViewport.offsetTop` and `scrollY`), so this one measures:
 * after every viewport change it reads where the view sits relative to the
 * visible area and moves it to the top of it, sized to the visible height.
 * The view is `position: fixed` while framed: #root clips its overflow, and a
 * view shifted inside it lost everything below the shift.
 */
import type { CSSProperties, RefCallback } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

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

  const ref = useCallback<RefCallback<HTMLElement>>((next) => setNode(next), []);

  useLayoutEffect(() => {
    applied.current = frame?.shift ?? 0;
  }, [frame]);

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
      // getBoundingClientRect is relative to the layout viewport, the visible
      // area starts offsetTop below it, and the rendered shift is taken out.
      const unshiftedTop = node.getBoundingClientRect().top - viewport.offsetTop - applied.current;
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
    ref,
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
