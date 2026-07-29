import { renderFixPack } from "./fix-pack";

function audit(overrides: Partial<Parameters<typeof renderFixPack>[0]> = {}) {
  return {
    url: "https://example.com/",
    score: 64,
    pagesCrawled: 12,
    platform: "wordpress",
    createdAt: new Date("2026-07-29T10:00:00Z"),
    sitemapXml: null,
    robotsTxt: null,
    ...overrides,
  };
}

function fix(overrides: Partial<Parameters<typeof renderFixPack>[1][number]> = {}) {
  return {
    findingCode: "missing_description",
    kind: "HEAD_TAG",
    status: "PROPOSED",
    severity: "warning",
    targetUrl: "https://example.com/shop",
    title: "Set the meta description",
    before: null,
    after: '<meta name="description" content="Fresh coffee.">',
    filePath: null,
    guidance: "Edit the page, scroll to the Yoast SEO box.",
    ...overrides,
  };
}

describe("renderFixPack", () => {
  it("leads with the site, the score and the stack the fixes are written for", () => {
    const doc = renderFixPack(audit(), [fix()]);
    expect(doc).toContain("# SEO fix pack — example.com");
    expect(doc).toContain("12 pages crawled");
    expect(doc).toContain("score 64/100");
    expect(doc).toContain("WordPress");
  });

  it("puts critical fixes above warnings regardless of input order", () => {
    const doc = renderFixPack(audit(), [
      fix({ title: "Later", severity: "info" }),
      fix({ title: "First", severity: "critical" }),
      fix({ title: "Middle", severity: "warning" }),
    ]);
    expect(doc.indexOf("First")).toBeLessThan(doc.indexOf("Middle"));
    expect(doc.indexOf("Middle")).toBeLessThan(doc.indexOf("Later"));
  });

  it("shows before and after when the page already has a value", () => {
    const doc = renderFixPack(audit(), [
      fix({ before: "<title>Home</title>", after: "<title>Coffee | Acme</title>" }),
    ]);
    expect(doc).toContain("**Currently:**");
    expect(doc).toContain("**Change to:**");
  });

  it("labels a fix with no current value as an addition", () => {
    const doc = renderFixPack(audit(), [fix({ before: null })]);
    expect(doc).toContain("**Add this:**");
    expect(doc).not.toContain("**Currently:**");
  });

  it("escapes a snippet containing backticks so it can't break out of its block", () => {
    const doc = renderFixPack(audit(), [fix({ after: "```\nnot a fence\n```" })]);
    // The fence around it has to be longer than any run of backticks inside.
    expect(doc).toContain("````html");
  });

  it("omits dismissed fixes — they're not work the user still has to do", () => {
    const doc = renderFixPack(audit(), [
      fix({ title: "Keep me" }),
      fix({ title: "Not relevant", status: "DISMISSED" }),
    ]);
    expect(doc).toContain("Keep me");
    expect(doc).not.toContain("Not relevant");
  });

  it("says so plainly when there is nothing left to do", () => {
    const doc = renderFixPack(audit(), [fix({ status: "DISMISSED" })]);
    expect(doc).toContain("No outstanding fixes");
  });

  it("inlines the generated files so the pack stands alone", () => {
    const doc = renderFixPack(
      audit({ robotsTxt: "User-agent: *\nAllow: /", sitemapXml: "<urlset></urlset>" }),
      [fix()],
    );
    expect(doc).toContain("### robots.txt");
    expect(doc).toContain("User-agent: *");
    expect(doc).toContain("### sitemap.xml");
  });

  it("does not claim it can push pages into Google", () => {
    const doc = renderFixPack(audit(), [fix()]);
    expect(doc).toContain("Google operates no equivalent");
  });
});
