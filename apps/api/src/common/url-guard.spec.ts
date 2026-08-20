/**
 * The API-side SSRF boundary (S-2, S-3), branch by branch.
 *
 * The exploit suite runs a target list against this and against the engine's
 * copy, which proves the two agree. What it does not do is walk every arm of
 * the address arithmetic — and that arithmetic is where an SSRF filter is
 * usually wrong: an off-by-one in a CIDR mask, a v6 form nobody thought of, a
 * signed-shift bug that makes `224.0.0.0/4` match nothing.
 *
 * DNS is mocked throughout. A resolver that hijacks NXDOMAIN — which many
 * consumer ISPs and some corporate networks do — would otherwise make these
 * pass or fail depending on whose wifi the suite ran on.
 */
import { assertPublicUrl, BlockedUrlError } from "./url-guard";

jest.mock("dns/promises", () => ({ lookup: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { lookup } = require("dns/promises") as { lookup: jest.Mock };

/** Resolve to one public address unless a test says otherwise. */
beforeEach(() => {
  lookup.mockReset();
  lookup.mockResolvedValue([{ address: "93.184.216.34" }]);
});

const reject = async (url: string) => {
  await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(BlockedUrlError);
};

describe("assertPublicUrl", () => {
  describe("the URL itself", () => {
    it("accepts an ordinary https URL", async () => {
      const url = await assertPublicUrl("https://example.com/page?q=1");
      expect(url.hostname).toBe("example.com");
    });

    it.each([
      ["nonsense", "not-a-url"],
      ["an empty string", ""],
      ["a bare host with no scheme", "example.com/path"],
    ])("refuses %s", async (_label, raw) => {
      await reject(raw);
    });

    /**
     * `file:` and `gopher:` are the classic SSRF escalations, and `data:` lets
     * a fetch return attacker-chosen bytes without a network round trip at all.
     */
    it.each([
      "file:///etc/passwd",
      "gopher://127.0.0.1:6379/_INFO",
      "data:text/html,<script>",
      "ftp://example.com/x",
      "redis://cache:6379",
      "javascript:alert(1)",
    ])("refuses the %s scheme", async (raw) => {
      await reject(raw);
    });

    /**
     * `http://user:pass@internal/` — credentials in a URL are how a fetch gets
     * talked into authenticating to something it should not be reaching, and
     * they are also how a host gets smuggled past a naive parser.
     */
    it("refuses credentials in the URL", async () => {
      await reject("https://user:password@example.com/");
      await reject("https://user@example.com/");
    });
  });

  describe("ports", () => {
    it("allows the two default ports, written or implied", async () => {
      await expect(assertPublicUrl("http://example.com")).resolves.toBeDefined();
      await expect(assertPublicUrl("https://example.com:443/x")).resolves.toBeDefined();
      await expect(assertPublicUrl("http://example.com:80/x")).resolves.toBeDefined();
    });

    /** Every one of these is a service that answers to a plain TCP write. */
    it.each([22, 25, 3306, 5432, 6379, 8080, 9200, 11211, 27017])(
      "refuses port %s",
      async (port) => {
        await reject(`http://example.com:${port}/`);
      },
    );
  });

  describe("hosts that name something internal", () => {
    it.each([
      "http://localhost/",
      "http://localhost.localdomain/",
      "http://metadata/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://instance-data/latest/meta-data/",
    ])("refuses %s", async (raw) => {
      await reject(raw);
    });

    it.each([
      "http://api.railway.internal/",
      "http://db.internal/",
      "http://printer.local/",
      "http://svc.cluster.local/",
      "http://engine.svc/",
    ])("refuses the internal suffix in %s", async (raw) => {
      await reject(raw);
    });

    /**
     * A trailing dot is the fully-qualified form of the same name, and it is a
     * different string. `localhost.` must not walk past a set membership test.
     */
    it("refuses the fully-qualified form of a blocked host", async () => {
      await reject("http://localhost./");
    });

    it("is not case sensitive", async () => {
      await reject("http://LOCALHOST/");
      await reject("http://Metadata.Google.Internal/");
    });

    /** Blocking `.local` must not also block `example.localdomain.com`. */
    it("does not refuse a public host that merely contains a blocked word", async () => {
      await expect(assertPublicUrl("https://internal-affairs.com/")).resolves.toBeDefined();
      await expect(assertPublicUrl("https://localhost-monitoring.io/")).resolves.toBeDefined();
    });
  });

  describe("literal IPv4 addresses", () => {
    it.each([
      ["loopback", "127.0.0.1"],
      ["loopback, other than .1", "127.99.42.7"],
      ["this network", "0.0.0.0"],
      ["private /8", "10.1.2.3"],
      ["carrier-grade NAT", "100.64.0.1"],
      ["AWS/GCP/Azure metadata", "169.254.169.254"],
      ["private /12", "172.16.0.1"],
      ["private /12, upper end", "172.31.255.254"],
      ["IETF protocol assignments", "192.0.0.1"],
      ["private /16", "192.168.1.1"],
      ["benchmarking", "198.18.0.1"],
      ["multicast", "224.0.0.1"],
      ["reserved", "240.0.0.1"],
      ["broadcast", "255.255.255.255"],
      ["Alibaba Cloud metadata", "100.100.100.200"],
    ])("refuses %s (%s)", async (_label, address) => {
      await reject(`http://${address}/`);
    });

    /**
     * The edges of each range, because a mask that is one bit wrong lets the
     * neighbouring address through and nothing else looks different.
     */
    it.each(["9.255.255.255", "11.0.0.1", "172.15.255.255", "172.32.0.1", "192.169.0.1"])(
      "allows %s, which sits just outside a blocked range",
      async (address) => {
        await expect(assertPublicUrl(`http://${address}/`)).resolves.toBeDefined();
      },
    );

    /** A literal never reaches DNS — judging it as written is the point. */
    it("does not resolve a literal address", async () => {
      await assertPublicUrl("http://93.184.216.34/");
      expect(lookup).not.toHaveBeenCalled();
    });
  });

  describe("literal IPv6 addresses", () => {
    it.each([
      ["loopback", "[::1]"],
      ["unspecified", "[::]"],
      ["unique-local fc00::/7", "[fc00::1]"],
      ["unique-local fd00::/8", "[fd12:3456::1]"],
      ["link-local fe80::/10", "[fe80::1]"],
      ["multicast", "[ff02::1]"],
    ])("refuses %s (%s)", async (_label, address) => {
      await reject(`http://${address}/`);
    });

    /**
     * The bypass that gets missed. `::ffff:127.0.0.1` belongs to no blocked
     * IPv6 range, passes a v6-only check untouched, and connects to loopback.
     */
    it.each(["[::ffff:127.0.0.1]", "[::ffff:169.254.169.254]", "[::ffff:10.0.0.1]"])(
      "refuses the IPv4-mapped address %s",
      async (address) => {
        await reject(`http://${address}/`);
      },
    );

    /**
     * `64:ff9b::/96` is the well-known NAT64 prefix. A translator on the path
     * turns it into a v4 connection to the embedded address, so the embedded
     * address is the one that matters — and a network with NAT64 is not exotic,
     * it is most mobile carriers.
     */
    it("refuses a NAT64 address embedding something private", async () => {
      await reject("http://[64:ff9b::169.254.169.254]/");
      await reject("http://[64:ff9b::10.0.0.1]/");
    });

    /** The deprecated IPv4-compatible form, `::a.b.c.d`. */
    it("refuses an IPv4-compatible address embedding something private", async () => {
      await reject("http://[::10.0.0.1]/");
    });

    it("allows a public IPv6 address", async () => {
      await expect(assertPublicUrl("http://[2606:2800:220:1:248:1893:25c8:1946]/")).resolves.toBeDefined();
    });
  });

  describe("DNS", () => {
    it("refuses a name that does not resolve", async () => {
      lookup.mockRejectedValue(new Error("ENOTFOUND"));
      await reject("https://nx.example.com/");
    });

    it("refuses a name that resolves to nothing", async () => {
      lookup.mockResolvedValue([]);
      await reject("https://empty.example.com/");
    });

    it("refuses a name that resolves into private space", async () => {
      lookup.mockResolvedValue([{ address: "10.0.0.7" }]);
      await reject("https://rebind.example.com/");
    });

    /**
     * One public answer and one private one is not a pass. Left to the
     * resolver's ordering it would be a coin flip, and an attacker only has to
     * win it once — the same record with both answers is the standard DNS
     * rebinding setup.
     */
    it("refuses when ANY answer is private", async () => {
      lookup.mockResolvedValue([{ address: "93.184.216.34" }, { address: "169.254.169.254" }]);
      await reject("https://mixed.example.com/");
    });

    it("allows a name whose every answer is public", async () => {
      lookup.mockResolvedValue([{ address: "93.184.216.34" }, { address: "1.1.1.1" }]);
      await expect(assertPublicUrl("https://ok.example.com/")).resolves.toBeDefined();
    });

    /** The trailing dot is stripped before the query, or the lookup misses. */
    it("resolves the name without its trailing dot", async () => {
      await assertPublicUrl("https://example.com./");
      expect(lookup).toHaveBeenCalledWith("example.com", { all: true });
    });
  });

  describe("the error", () => {
    it("is a 400 that names the URL and says why", async () => {
      await expect(assertPublicUrl("http://169.254.169.254/")).rejects.toMatchObject({
        status: 400,
        response: { code: "URL_NOT_ALLOWED", url: "http://169.254.169.254/" },
      });
    });

    /**
     * The message can carry the host, because it goes to the one customer who
     * sent it. The metric label cannot: a label built from customer input is
     * unbounded cardinality, which is the same mistake as putting an id in a
     * route label — and it takes a Prometheus down rather than a page.
     */
    it("explains without leaking anything the caller did not already send", async () => {
      await expect(assertPublicUrl("http://10.0.0.1/")).rejects.toMatchObject({
        response: { message: expect.stringContaining("10.0.0.1") },
      });
    });
  });
});
