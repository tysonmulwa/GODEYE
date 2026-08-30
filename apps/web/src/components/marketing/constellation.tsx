"use client";

import { useEffect, useRef } from "react";

/**
 * The drifting network behind the marketing pages.
 *
 * ## Why canvas and not CSS
 *
 * The effect is nodes that drift and *lines that appear between them when they
 * come close*. That is a per-frame distance test between every pair of points,
 * which CSS cannot express: a CSS-only version can move dots along fixed paths
 * but cannot draw an edge whose existence depends on where two dots currently
 * are. The stretching is the whole point, so canvas it is.
 *
 * One `<canvas>`, one rAF loop, no library, ~3KB.
 *
 * ## The part that makes it ours
 *
 * Where three nodes are mutually close the triangle between them is filled,
 * very faintly. It reads as the network briefly forming a surface and then
 * letting go, and it is what stops this looking like every other particles.js
 * header. The fill is capped hard (`TRI_ALPHA`) because at any strength you can
 * actually see clearly it competes with the headline sitting on top of it.
 *
 * ## Cost control
 *
 * - Node count scales with viewport area and is capped, so a 4K monitor does
 *   not quadratically increase the pair tests.
 * - Distances are compared squared; no `Math.sqrt` in the inner loop.
 * - The loop stops entirely when the tab is hidden, and when the page is
 *   scrolled past the canvas.
 * - Under `prefers-reduced-motion` it paints ONE static frame and never starts
 *   a loop. A network of dots is still a nice backdrop; it just holds still.
 */

const LINK_DIST = 132;
const LINK_DIST_SQ = LINK_DIST * LINK_DIST;
const TRI_ALPHA = 0.035;
const SPEED = 0.052;

interface Node {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  alt: boolean;
}

/** Reads the palette off the element, so the network follows the theme. */
function palette(el: HTMLElement) {
  const cs = getComputedStyle(el);
  return {
    node: cs.getPropertyValue("--net-node").trim() || "rgba(167,139,250,0.85)",
    nodeAlt: cs.getPropertyValue("--net-node-alt").trim() || "rgba(34,211,238,0.8)",
    line: cs.getPropertyValue("--net-line").trim() || "rgba(160,150,220,0.2)",
  };
}

export function Constellation() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const scope = canvas.closest(".marketing") as HTMLElement | null;
    let colors = palette(scope ?? canvas);

    let nodes: Node[] = [];
    let w = 0;
    let h = 0;
    let frame = 0;
    let running = false;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = canvas!.clientWidth;
      h = canvas!.clientHeight;
      canvas!.width = Math.floor(w * dpr);
      canvas!.height = Math.floor(h * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Density by area, capped. A 4K display should look the same as a
      // laptop, not four times as busy and four times as expensive.
      const count = Math.min(90, Math.max(28, Math.round((w * h) / 21000)));
      nodes = Array.from({ length: count }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        vx: (Math.random() - 0.5) * SPEED,
        vy: (Math.random() - 0.5) * SPEED,
        r: Math.random() * 1.5 + 0.9,
        alt: Math.random() < 0.28,
      }));
    }

    function draw() {
      ctx!.clearRect(0, 0, w, h);

      // Edges first, so nodes sit on top of the web rather than under it.
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > LINK_DIST_SQ) continue;

          const closeness = 1 - d2 / LINK_DIST_SQ;
          ctx!.globalAlpha = closeness * 0.9;
          ctx!.strokeStyle = colors.line;
          ctx!.lineWidth = 1;
          ctx!.beginPath();
          ctx!.moveTo(a.x, a.y);
          ctx!.lineTo(b.x, b.y);
          ctx!.stroke();

          // Third node close to both: fill the triangle, barely.
          for (let k = j + 1; k < nodes.length; k++) {
            const c = nodes[k];
            const acx = a.x - c.x;
            const acy = a.y - c.y;
            const bcx = b.x - c.x;
            const bcy = b.y - c.y;
            if (acx * acx + acy * acy > LINK_DIST_SQ) continue;
            if (bcx * bcx + bcy * bcy > LINK_DIST_SQ) continue;

            ctx!.globalAlpha = closeness * TRI_ALPHA;
            ctx!.fillStyle = colors.line;
            ctx!.beginPath();
            ctx!.moveTo(a.x, a.y);
            ctx!.lineTo(b.x, b.y);
            ctx!.lineTo(c.x, c.y);
            ctx!.closePath();
            ctx!.fill();
          }
        }
      }

      ctx!.globalAlpha = 1;
      for (const n of nodes) {
        ctx!.fillStyle = n.alt ? colors.nodeAlt : colors.node;
        ctx!.beginPath();
        ctx!.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx!.fill();
      }
    }

    function step() {
      for (const n of nodes) {
        n.x += n.vx;
        n.y += n.vy;
        // Wrap rather than bounce: bouncing makes the edges of the viewport
        // visibly busier than the middle, which draws the eye outward.
        if (n.x < -20) n.x = w + 20;
        else if (n.x > w + 20) n.x = -20;
        if (n.y < -20) n.y = h + 20;
        else if (n.y > h + 20) n.y = -20;
      }
      draw();
      frame = requestAnimationFrame(step);
    }

    function start() {
      if (running || reduced.matches) return;
      running = true;
      frame = requestAnimationFrame(step);
    }
    function stop() {
      running = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    }

    resize();
    draw();
    start();

    const onResize = () => {
      resize();
      draw();
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    const onMotionChange = () => {
      stop();
      draw();
      start();
    };

    window.addEventListener("resize", onResize, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    reduced.addEventListener("change", onMotionChange);

    // Scrolled past: nothing to animate, so stop paying for it.
    const io = new IntersectionObserver(
      ([e]) => (e.isIntersecting ? start() : stop()),
      { threshold: 0 },
    );
    io.observe(canvas);

    // The theme toggle rewrites the custom properties on .marketing; re-read
    // them rather than restarting the whole field, so the nodes keep their
    // positions across a theme change instead of teleporting.
    const themeObserver = scope
      ? new MutationObserver(() => {
          colors = palette(scope);
          draw();
        })
      : null;
    themeObserver?.observe(scope!, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      stop();
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      reduced.removeEventListener("change", onMotionChange);
      io.disconnect();
      themeObserver?.disconnect();
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 h-full w-full"
    />
  );
}
