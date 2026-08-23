/**
 * TikTok's Content Sharing Guidelines, "Required UX Implementation in Your App".
 *
 * The app was rejected against points 2, 3 and 4 — and the rejection was
 * correct, because none of this existed. The server read `creator_info` at
 * publish time and picked the most public visibility the account allowed.
 *
 * Each test below names the point it covers. They are the answer to "how do you
 * know this will not be rejected again", and they are the reason a future
 * refactor cannot quietly reintroduce a default.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  TikTokPostSettingsPanel,
  tiktokSettingsComplete,
  disclosureLabel,
  EMPTY_TIKTOK_SETTINGS,
  type TikTokSettings,
} from "../components/tiktok-post-settings";

const CREATOR_INFO = {
  creatorNickname: "Tyson",
  creatorUsername: "tyson",
  privacyLevelOptions: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"],
  commentDisabled: false,
  duetDisabled: false,
  stitchDisabled: false,
};

const apiMock = vi.fn();
vi.mock("@/lib/api", () => ({ api: (...args: unknown[]) => apiMock(...args) }));

function renderPanel(value: TikTokSettings = EMPTY_TIKTOK_SETTINGS, onChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TikTokPostSettingsPanel connectionId="c1" value={value} onChange={onChange} />
    </QueryClientProvider>,
  );
  return onChange;
}

beforeEach(() => {
  apiMock.mockReset();
  apiMock.mockResolvedValue(CREATOR_INFO);
});

describe("point 2 — privacy level", () => {
  /**
   * The single most important assertion in this file. TikTok requires the
   * creator to select an audience with **nothing pre-selected**, and a default
   * here is exactly the behaviour the app was rejected for, moved from the
   * server into the client.
   */
  it("pre-selects nothing", async () => {
    renderPanel();
    await screen.findByText("Who can see this post");
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).not.toBeChecked();
    }
  });

  it("blocks publishing until an audience is chosen", () => {
    expect(tiktokSettingsComplete(EMPTY_TIKTOK_SETTINGS)).toBe(false);
    expect(
      tiktokSettingsComplete({ ...EMPTY_TIKTOK_SETTINGS, privacyLevel: "SELF_ONLY" }),
    ).toBe(true);
  });

  /**
   * Only what this account allows. `creator_info` is the authority — offering
   * an audience TikTok did not list produces a rejection at publish time,
   * minutes or weeks after the creator thought they had chosen it.
   */
  it("offers only the audiences the account allows", async () => {
    renderPanel();
    await screen.findByText("Who can see this post");
    expect(screen.getByLabelText(/Everyone/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Friends/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Only me/)).toBeInTheDocument();
    // FOLLOWER_OF_CREATOR was not in privacyLevelOptions.
    expect(screen.queryByLabelText(/^Followers/)).not.toBeInTheDocument();
  });

  it("reports an account with no available audiences rather than showing an empty list", async () => {
    apiMock.mockResolvedValue({ ...CREATOR_INFO, privacyLevelOptions: [] });
    renderPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent(/no available audiences/i);
  });

  it("records the creator's choice", async () => {
    const onChange = renderPanel();
    await screen.findByText("Who can see this post");
    await userEvent.click(screen.getByLabelText(/Everyone/));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ privacyLevel: "PUBLIC_TO_EVERYONE" }),
    );
  });
});

describe("point 3 — interaction settings", () => {
  it("offers comment, duet and stitch", async () => {
    renderPanel();
    await screen.findByText("Allow people to");
    expect(screen.getByLabelText(/Comment/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Duet/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Stitch/)).toBeInTheDocument();
  });

  /**
   * The guideline is specific: an interaction the creator's own account
   * forbids must be shown **disabled**, not hidden. Hiding it looks like our
   * app took the option away; disabling it with the reason shows it is their
   * setting, and where to change it.
   */
  it("shows an account-disabled interaction as disabled, not hidden", async () => {
    apiMock.mockResolvedValue({ ...CREATOR_INFO, duetDisabled: true, stitchDisabled: true });
    renderPanel();
    await screen.findByText("Allow people to");

    expect(screen.getByLabelText(/Duet/)).toBeDisabled();
    expect(screen.getByLabelText(/Stitch/)).toBeDisabled();
    expect(screen.getByLabelText(/Comment/)).toBeEnabled();
    expect(screen.getAllByText(/Turned off in your TikTok account settings/)).toHaveLength(2);
  });

  /**
   * The control reads "Allow", the state stores "disable". Getting this
   * backwards silently inverts every creator's choice, and nothing else in the
   * system would notice.
   */
  it("stores the inverse of what the checkbox reads", async () => {
    const onChange = renderPanel();
    await screen.findByText("Allow people to");
    // Checked by default (nothing disabled) — unticking it means "disable".
    await userEvent.click(screen.getByLabelText(/Comment/));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ disableComment: true }));
  });
});

describe("point 4 — content disclosure", () => {
  it("offers both disclosure kinds", async () => {
    renderPanel();
    await screen.findByText("Disclose post content");
    expect(screen.getByLabelText(/Your brand/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Branded content/)).toBeInTheDocument();
  });

  it("names the label TikTok will apply", () => {
    expect(disclosureLabel(EMPTY_TIKTOK_SETTINGS)).toBeNull();
    expect(disclosureLabel({ ...EMPTY_TIKTOK_SETTINGS, brandOrganic: true })).toBe(
      "Promotional content",
    );
    expect(disclosureLabel({ ...EMPTY_TIKTOK_SETTINGS, brandedContent: true })).toBe(
      "Paid partnership",
    );
    // Both on is still a paid partnership: the third-party relationship is the
    // one with the disclosure obligation attached.
    expect(
      disclosureLabel({ ...EMPTY_TIKTOK_SETTINGS, brandOrganic: true, brandedContent: true }),
    ).toBe("Paid partnership");
  });

  it("shows the Music Usage Confirmation link whenever anything is disclosed", async () => {
    renderPanel({ ...EMPTY_TIKTOK_SETTINGS, brandOrganic: true, privacyLevel: "SELF_ONLY" });
    await screen.findByText("Disclose post content");
    const link = screen.getByRole("link", { name: /Music Usage Confirmation/ });
    expect(link).toHaveAttribute("href", expect.stringContaining("music-usage-confirmation"));
  });

  /** Branded content carries a second required link. */
  it("shows the Branded Content Policy link only for branded content", async () => {
    renderPanel({ ...EMPTY_TIKTOK_SETTINGS, brandOrganic: true, privacyLevel: "SELF_ONLY" });
    await screen.findByText("Disclose post content");
    expect(screen.queryByRole("link", { name: /Branded Content Policy/ })).not.toBeInTheDocument();
  });

  it("shows both links for branded content", async () => {
    renderPanel({
      ...EMPTY_TIKTOK_SETTINGS,
      brandedContent: true,
      privacyLevel: "PUBLIC_TO_EVERYONE",
    });
    await screen.findByText("Disclose post content");
    expect(screen.getByRole("link", { name: /Branded Content Policy/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Music Usage Confirmation/ })).toBeInTheDocument();
  });

  describe("branded content cannot be private", () => {
    /** TikTok's rule: a paid partnership nobody can see cannot be disclosed. */
    it("refuses the combination", () => {
      expect(
        tiktokSettingsComplete({
          ...EMPTY_TIKTOK_SETTINGS,
          privacyLevel: "SELF_ONLY",
          brandedContent: true,
        }),
      ).toBe(false);
    });

    it("disables Only me while branded content is on", async () => {
      renderPanel({ ...EMPTY_TIKTOK_SETTINGS, brandedContent: true });
      await screen.findByText("Who can see this post");
      expect(screen.getByLabelText(/Only me/)).toBeDisabled();
      expect(screen.getByLabelText(/Everyone/)).toBeEnabled();
    });

    /**
     * Clears the selection rather than quietly moving it to a more public
     * audience. Silently widening who can see a post, because of a disclosure
     * toggle, is the app choosing a visibility for somebody — which is the
     * whole thing this panel exists to prevent.
     */
    it("clears an already-chosen Only me rather than switching it", async () => {
      const onChange = vi.fn();
      renderPanel(
        { ...EMPTY_TIKTOK_SETTINGS, privacyLevel: "SELF_ONLY", brandedContent: true },
        onChange,
      );
      await waitFor(() =>
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ privacyLevel: null })),
      );
    });
  });
});

describe("when TikTok will not answer", () => {
  /**
   * Fail closed. Without creator_info the app does not know which audiences
   * this account allows, and guessing is the rejected behaviour — so it says
   * so and the post cannot be scheduled.
   */
  it("refuses to offer options it could not verify", async () => {
    apiMock.mockRejectedValue(new Error("TikTok connection needs reconnecting"));
    renderPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent(/cannot be scheduled yet/i);
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("says what to do about it", async () => {
    apiMock.mockRejectedValue(new Error("nope"));
    renderPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Reconnect TikTok/i);
  });
});
