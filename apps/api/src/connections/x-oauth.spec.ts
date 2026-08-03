import { oauth1Header } from "./platform-clients";

/**
 * X is the only platform here still on OAuth 1.0a, and a request signed even
 * slightly wrong comes back as a bare 401 with an empty body — no field name,
 * no reason. That makes the signature the one piece of this flow worth
 * pinning, because getting it wrong is silent.
 *
 * The expected value is not this implementation's own output recorded back at
 * it. It was produced by the engine's independent Python signer
 * (apps/engine/src/godeye_engine/publishers/oauth1.py), which has been posting
 * to X in production since launch. Two implementations written from the RFC
 * agreeing on a byte-exact signature is worth far more than either agreeing
 * with itself.
 */
describe("X OAuth 1.0a signing", () => {
  const fixture = {
    method: "POST" as const,
    url: "https://api.twitter.com/oauth/access_token",
    consumerKey: "ck",
    consumerSecret: "cs",
    token: "request-token",
    tokenSecret: "request-token-secret",
    // Deliberately carries ! * ' ( ) ~ and a space: encodeURIComponent leaves
    // the first five alone and OAuth requires them escaped, so a header built
    // without the RFC 3986 correction fails on exactly these characters.
    extra: { oauth_verifier: "verif !*'()~-" },
    nonce: "abc123",
    timestamp: "1700000000",
  };

  const signatureOf = (header: string) =>
    decodeURIComponent(/oauth_signature="([^"]+)"/.exec(header)![1]);

  it("agrees with the engine's signer byte for byte", () => {
    expect(signatureOf(oauth1Header(fixture))).toBe("9G25p3MgTokUKUzfvgsEiFriCOw=");
  });

  it("signs the access-token step with the request token's secret", () => {
    // The classic OAuth 1.0a mistake is signing this step with the consumer
    // secret alone and an empty token secret. X answers 401 with no body, so
    // nothing in the response says which half is wrong.
    const wrong = oauth1Header({ ...fixture, tokenSecret: "" });
    expect(signatureOf(wrong)).not.toBe(signatureOf(oauth1Header(fixture)));
  });

  it("escapes the characters encodeURIComponent leaves behind", () => {
    const header = oauth1Header(fixture);
    expect(header).toContain("oauth_verifier=");
    // Raw ! * ' ( ) would be a malformed header value.
    expect(/oauth_verifier="([^"]+)"/.exec(header)![1]).toBe("verif%20%21%2A%27%28%29~-");
  });

  it("never puts the signature inside the string it signs", () => {
    // If oauth_signature leaked into the base string it would change with the
    // nonce in a way the server could not reproduce, so a second call with the
    // same inputs must still be identical.
    expect(oauth1Header(fixture)).toBe(oauth1Header(fixture));
  });

  it("omits oauth_token on the request-token step, where none exists yet", () => {
    const header = oauth1Header({
      method: "POST",
      url: "https://api.twitter.com/oauth/request_token",
      consumerKey: "ck",
      consumerSecret: "cs",
      extra: { oauth_callback: "https://api.godeyeautomation.com/connections/x/callback" },
      nonce: "abc123",
      timestamp: "1700000000",
    });
    expect(header).not.toContain("oauth_token=");
    expect(header).toContain("oauth_callback=");
  });
});
