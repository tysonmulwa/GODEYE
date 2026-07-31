"use client";

import { useEffect, useState } from "react";

/**
 * The next milestone the engine will report, keyed by the current one.
 *
 * Shared by the image and video pipelines. Both write their stage percentages
 * into AgentRun.output.percent, so a bar can ease toward the next number
 * without ever passing it. Keep in step with STAGES in tasks/image.py and
 * STAGE_PERCENT in tasks/video.py.
 */
const NEXT_MILESTONE: Record<number, number> = {
  // image: prompt, generate, fit, brand, upload
  8: 20,
  20: 80,
  80: 88,
  88: 93,
  93: 99,
  // video: script, then scenes across 10..70, then assembly, captions, upload
  5: 10,
  75: 85,
  85: 92,
  92: 99,
};

/**
 * A percentage that keeps moving between the engine's milestones.
 *
 * Both pipelines spend most of their time inside one step: a single 20 second
 * provider call for an image, and scene rendering for a video. A bar that only
 * moved on reported stages would sit still for almost the whole wait and read
 * as a hang.
 *
 * So it eases toward the next milestone on a timer, and stops one point short
 * of it. It never claims a stage the engine has not reported, and it snaps
 * forward the moment a real one lands. It also never reaches 100: only the run
 * finishing does that.
 */
export function useEasedProgress(reported: number, active: boolean): number {
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (!active) {
      setShown(0);
      return;
    }
    // Scene percentages are computed per scene, so they will not be in the map;
    // stepping a little past the last known one keeps the bar alive without
    // running away from the work.
    const ceiling = (NEXT_MILESTONE[reported] ?? reported + 8) - 1;

    setShown((current) => Math.max(current, reported));
    const timer = setInterval(() => {
      setShown((current) => {
        if (current >= ceiling) return current;
        // Decelerating, so it never stalls outright and never sprints ahead of
        // what has actually happened.
        return current + Math.max(0.15, (ceiling - current) * 0.02);
      });
    }, 120);
    return () => clearInterval(timer);
  }, [reported, active]);

  return Math.min(99, Math.round(shown));
}
