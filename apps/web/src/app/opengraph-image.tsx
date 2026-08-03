import { ImageResponse } from "next/og";
import { SITE_NAME } from "@/lib/site";

/**
 * The picture that appears when someone shares the site.
 *
 * twitter:card is summary_large_image, which promises one — without it the
 * platform picks something off the page, and on a page with no photographs it
 * picks nothing and renders a bare grey box. Generated here rather than
 * committed as a file so it cannot drift from the wording on the page.
 *
 * Deliberately no web fonts: fetching one at render time is a network call
 * that can fail, and a share image that sometimes fails is worse than a plain
 * one that always works.
 */
export const runtime = "edge";
export const alt = "GODEYE — marketing that runs without you in the room";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px",
          background: "#0b0d12",
          color: "#f6f7f9",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          {/* The crest, drawn inline: an external asset is one more thing that
              can 404 at the moment someone shares the link. */}
          <svg width="64" height="64" viewBox="0 0 100 100" fill="none">
            <path d="M50 8 L92 82 H8 Z" stroke="#8b5cf6" strokeWidth="6" fill="none" />
            <circle cx="50" cy="58" r="13" stroke="#8b5cf6" strokeWidth="6" fill="none" />
            <circle cx="50" cy="58" r="4" fill="#8b5cf6" />
          </svg>
          <span style={{ fontSize: 40, letterSpacing: 10, fontWeight: 700 }}>{SITE_NAME}</span>
        </div>
        {/* Satori refuses any div holding more than one child without an
            explicit display, so each line is its own element inside a flex
            column rather than text split by <br>. The build does not catch
            this — only rendering does. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: 48,
            fontSize: 62,
            lineHeight: 1.15,
            fontWeight: 700,
          }}
        >
          <div>Marketing that runs</div>
          <div>without you in the room</div>
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: 32,
            fontSize: 27,
            color: "#98a0ad",
            lineHeight: 1.4,
          }}
        >
          <div>Writes for every platform, publishes on its own schedule,</div>
          <div>and keeps your site findable.</div>
        </div>
      </div>
    ),
    size,
  );
}
