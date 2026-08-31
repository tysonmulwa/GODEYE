/**
 * Transactional email.
 *
 * The properties worth holding are about what happens when Resend does NOT
 * cooperate, because that is when the difference between a courtesy and a
 * mechanism matters: a welcome email that fails must leave a working account,
 * and a password reset that fails must not leave someone staring at "check your
 * inbox" for a message that will never arrive.
 */
import { EmailService, redact } from "./email.service";
import { passwordResetEmail, purchaseEmail, welcomeEmail, weeklyReviewEmail } from "./templates";

const ORIGINAL_ENV = { ...process.env };

function message() {
  return { to: "a@b.com", subject: "s", html: "<p>h</p>", text: "t", template: "test" };
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.restoreAllMocks();
});

describe("when no API key is configured", () => {
  beforeEach(() => {
    delete process.env.RESEND_API_KEY;
  });

  it("reports itself disabled rather than pretending", () => {
    expect(new EmailService().enabled).toBe(false);
  });

  /**
   * The whole point of `send`. A deployment without a key is a deployment where
   * registration still works.
   */
  it("makes send() a no-op that resolves, never a throw", async () => {
    const result = await new EmailService().send(message());
    expect(result).toEqual({ sent: false, reason: "not-configured" });
  });

  /**
   * ...and the exception. A silent no-op here is worse than an error, because
   * the user is told to check an inbox nothing was sent to.
   */
  it("makes sendOrThrow() throw, so password reset cannot fail quietly", async () => {
    await expect(new EmailService().sendOrThrow(message())).rejects.toThrow(/RESEND_API_KEY/);
  });
});

describe("when Resend rejects the message", () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test_key";
  });

  it("swallows the failure for send(), and reports it", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response("nope", { status: 500 }) as never);
    const result = await new EmailService().send(message());
    expect(result.sent).toBe(false);
    expect(result.reason).toMatch(/500/);
  });

  /**
   * A 403 from Resend is almost always an unverified From domain, and it reads
   * like an auth failure. Someone debugging this at midnight should not have to
   * guess.
   */
  it("explains a 403 as a probable domain verification problem", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response("forbidden", { status: 403 }) as never);
    const result = await new EmailService().send(message());
    expect(result.reason).toMatch(/verified in Resend/i);
  });

  it("propagates the failure for sendOrThrow()", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(new Response("x", { status: 422 }) as never);
    await expect(new EmailService().sendOrThrow(message())).rejects.toThrow(/422/);
  });
});

describe("what actually goes over the wire", () => {
  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test_key";
  });

  it("sends both a text and an html part", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "m1" }), { status: 200 }) as never);

    await new EmailService().send(message());

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    // A message with no text part scores as spam, renders empty with images
    // off, and is unreadable to anyone whose client prefers plain text.
    expect(body.text).toBeTruthy();
    expect(body.html).toBeTruthy();
    expect(body.to).toEqual(["a@b.com"]);
  });

  it("does not put the API key anywhere but the authorization header", async () => {
    const fetchMock = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }) as never);

    await new EmailService().send(message());

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toContain("re_test_key");
    expect(init.body as string).not.toContain("re_test_key");
  });
});

describe("redact", () => {
  /** Logs are read by more people than the mailbox is. */
  it("shortens the local part but keeps the domain diagnosable", () => {
    expect(redact("tyson@godeyeautomation.com")).toBe("ty***@godeyeautomation.com");
  });

  it("does not throw on something that is not an address", () => {
    expect(redact("not-an-address")).toBe("invalid-address");
  });
});

describe("templates", () => {
  const templates = [
    welcomeEmail("a@b.com", "Tyson"),
    passwordResetEmail("a@b.com", "https://godeyeautomation.com/reset-password?token=x", 30),
    purchaseEmail("a@b.com", { planName: "Pro", amount: "$19.00", reference: "ref_1" }),
    weeklyReviewEmail("a@b.com", "Acme", {
      published: 4,
      scheduled: 3,
      failed: 0,
      topPlatform: "TikTok",
      seoScore: 91,
    }),
  ];

  it.each(templates)("$template has both parts and a subject", (t) => {
    expect(t.subject).toBeTruthy();
    expect(t.html).toContain("<!doctype html>");
    expect(t.text.length).toBeGreaterThan(20);
  });

  /**
   * Names and business names are user input and land in an HTML document.
   * `<script>` in a display name should not become a script tag in an inbox.
   */
  it("escapes user-supplied names", () => {
    const hostile = welcomeEmail("a@b.com", '<script>alert(1)</script>');
    expect(hostile.html).not.toContain("<script>alert");
    expect(hostile.html).toContain("&lt;script&gt;");
  });

  it("escapes an organization name in the weekly review", () => {
    const hostile = weeklyReviewEmail("a@b.com", '<img onerror=x>', {
      published: 1,
      scheduled: 0,
      failed: 0,
      topPlatform: null,
      seoScore: null,
    });
    expect(hostile.html).not.toContain("<img onerror");
  });

  /** No surveillance on a transactional message. */
  it("carries no tracking pixel", () => {
    for (const t of templates) {
      expect(t.html).not.toMatch(/<img[^>]+(track|pixel|open)/i);
    }
  });

  it("puts the reset token in the link and nowhere else", () => {
    const url = "https://godeyeautomation.com/reset-password?token=SECRETVALUE";
    const mail = passwordResetEmail("a@b.com", url, 30);
    // Present in both parts, because the button and the pasteable line are the
    // only two ways this email can be used.
    expect(mail.html).toContain("SECRETVALUE");
    expect(mail.text).toContain("SECRETVALUE");
    expect(mail.subject).not.toContain("SECRETVALUE");
  });

  /**
   * The weekly review must not invent a comparison. Nothing in the product
   * measures a baseline, and a fabricated "up 40%" in a recurring email is a
   * lie told every week.
   */
  it("states counts without claiming a trend", () => {
    const mail = weeklyReviewEmail("a@b.com", "Acme", {
      published: 4,
      scheduled: 3,
      failed: 0,
      topPlatform: "TikTok",
      seoScore: 91,
    });
    expect(mail.html).not.toMatch(/\b(up|down|increase|decrease|growth)\b\s*\d*%?/i);
    expect(mail.html).toContain("4");
  });
});
