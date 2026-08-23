import { createHmac, randomBytes } from "node:crypto";
import { BadRequestException, Logger } from "@nestjs/common";
import { env } from "../common/env";
import { httpRequest, TIMEOUTS } from "../common/http-client";

const metaLogger = new Logger("MetaClient");

/**
 * Thin HTTP clients used to VALIDATE credentials when a user connects a
 * platform. Publishing itself happens in the Python engine, these only
 * confirm the credentials work and fetch display metadata.
 */

async function getJson(url: string, init?: RequestInit): Promise<any> {
  // Every platform call is bounded. Node's fetch has no total-request timeout,
  // so one unresponsive provider used to hold a request, an event-loop slot and
  // a database connection for up to five minutes (B-4).
  const res = await httpRequest(url, {
    ...init,
    timeoutMs: TIMEOUTS.platform,
    upstream: hostOf(url),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = body?.description ?? body?.message ?? body?.error?.message ?? res.statusText;
    throw new BadRequestException(`Platform API error: ${detail}`);
  }
  return body;
}

// ---------- Telegram ----------

export interface TelegramValidation {
  botUsername: string;
  chatId: string;
  chatTitle: string;
}

export async function validateTelegram(
  botToken: string,
  chatId: string,
): Promise<TelegramValidation> {
  const me = await getJson(`https://api.telegram.org/bot${botToken}/getMe`);
  if (!me.ok) throw new BadRequestException("Telegram bot token rejected");
  const chat = await getJson(
    `https://api.telegram.org/bot${botToken}/getChat?chat_id=${encodeURIComponent(chatId)}`,
  );
  if (!chat.ok) throw new BadRequestException("Telegram chat not found or bot not a member");

  // A bot can't message itself, reject pointing the chat at the bot.
  const botUsername = String(me.result.username ?? "").toLowerCase();
  const chatUsername = String(chat.result.username ?? "").toLowerCase();
  if (chat.result.id === me.result.id || (chatUsername && chatUsername === botUsername)) {
    throw new BadRequestException(
      "That points the bot at itself. Create a channel or group, add this bot as an " +
        "admin with 'Post Messages', then use the channel's @handle here.",
    );
  }

  // For channels/supergroups the bot must be an administrator to post.
  if (chat.result.type === "channel" || chat.result.type === "supergroup") {
    const member = await getJson(
      `https://api.telegram.org/bot${botToken}/getChatMember` +
        `?chat_id=${encodeURIComponent(chatId)}&user_id=${me.result.id}`,
    );
    const statusName = member.ok ? member.result.status : null;
    if (statusName !== "administrator" && statusName !== "creator") {
      throw new BadRequestException(
        `The bot isn't an admin of "${chat.result.title ?? chatId}". Add @${me.result.username} ` +
          "as an administrator with 'Post Messages' permission, then reconnect.",
      );
    }
  }

  return {
    botUsername: me.result.username,
    chatId: String(chat.result.id),
    chatTitle: chat.result.title ?? chat.result.username ?? String(chat.result.id),
  };
}

// ---------- Discord ----------

export interface DiscordValidation {
  botName: string;
  channelId: string;
  channelName: string;
}

export async function validateDiscord(
  botToken: string,
  channelId: string,
): Promise<DiscordValidation> {
  const headers = { Authorization: `Bot ${botToken}` };
  const me = await getJson("https://discord.com/api/v10/users/@me", { headers });
  const channel = await getJson(`https://discord.com/api/v10/channels/${channelId}`, { headers });
  return {
    botName: me.username,
    channelId: channel.id,
    channelName: channel.name ?? channel.id,
  };
}

// ---------- Reddit OAuth (click-to-connect) ----------

/** The host a URL points at, so the circuit breaker is per provider. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "platform";
  }
}

export function redditAuthorizeUrl(state: string): string {
  if (!env.reddit.clientId) {
    throw new BadRequestException(
      "Reddit is not configured on this server (REDDIT_CLIENT_ID missing)",
    );
  }
  const params = new URLSearchParams({
    client_id: env.reddit.clientId,
    response_type: "code",
    state,
    redirect_uri: env.reddit.redirectUri,
    duration: "permanent", // returns a refresh_token so we can post later
    scope: "identity submit read",
  });
  return `https://www.reddit.com/api/v1/authorize?${params}`;
}

export interface RedditAccount {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  username: string;
}

export async function redditExchangeCode(code: string): Promise<RedditAccount> {
  const { clientId, clientSecret, userAgent, redirectUri } = env.reddit;
  if (!clientId || !clientSecret) {
    throw new BadRequestException(
      "Reddit is not configured on this server (REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET missing)",
    );
  }
  const tokenRes = await httpRequest("https://www.reddit.com/api/v1/access_token", {
    timeoutMs: TIMEOUTS.platform,
    upstream: "reddit",
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  const token: any = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !token.access_token) {
    throw new BadRequestException(
      `Reddit token exchange failed: ${token.error ?? tokenRes.statusText}`,
    );
  }
  if (!token.refresh_token) {
    throw new BadRequestException(
      "Reddit did not return a refresh token, re-try the authorization (duration=permanent).",
    );
  }
  const me = await getJson("https://oauth.reddit.com/api/v1/me", {
    headers: { Authorization: `Bearer ${token.access_token}`, "User-Agent": userAgent },
  });
  if (!me?.name) throw new BadRequestException("Could not read your Reddit username");
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresInSeconds: token.expires_in ?? 3600,
    username: me.name,
  };
}

// ---------- LinkedIn ----------

export function linkedinAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.linkedin.clientId,
    redirect_uri: env.linkedin.redirectUri,
    state,
    scope: "openid profile w_member_social",
  });
  return `https://www.linkedin.com/oauth/v2/authorization?${params}`;
}

export interface LinkedInAccount {
  accessToken: string;
  expiresInSeconds: number;
  memberUrn: string;
  name: string;
}

export async function linkedinExchangeCode(code: string): Promise<LinkedInAccount> {
  const tokenRes = await httpRequest("https://www.linkedin.com/oauth/v2/accessToken", {
    timeoutMs: TIMEOUTS.platform,
    upstream: "linkedin",
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: env.linkedin.clientId,
      client_secret: env.linkedin.clientSecret,
      redirect_uri: env.linkedin.redirectUri,
    }),
  });
  const token: any = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !token.access_token) {
    throw new BadRequestException(
      `LinkedIn token exchange failed: ${token.error_description ?? tokenRes.statusText}`,
    );
  }
  const userinfo: any = await getJson("https://api.linkedin.com/v2/userinfo", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  return {
    accessToken: token.access_token,
    expiresInSeconds: token.expires_in ?? 5184000,
    memberUrn: `urn:li:person:${userinfo.sub}`,
    name: userinfo.name ?? userinfo.given_name ?? "LinkedIn member",
  };
}

// ---------- Meta (Facebook / Instagram) ----------

const graph = (path: string) => `https://graph.facebook.com/${env.meta.graphVersion}${path}`;

export function metaAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.meta.appId,
    redirect_uri: env.meta.redirectUri,
    state,
    response_type: "code",
    // Facebook Login covers Pages only. Instagram has its own button and its
    // own API (Instagram Login → graph.instagram.com), which reaches every IG
    // Business account including ones attached to a Page, so requesting
    // instagram_basic/instagram_content_publish here bought no extra reach and
    // doubled the App Review surface. Do not add them back without also
    // restoring the permissions in the Meta app, or Meta rejects this whole
    // dialog and Page publishing goes down with it.
    //
    // business_management was requested here and used NOWHERE: no /businesses
    // call, no business_id, in either service. Meta's App Review rejects on
    // Policy 1.6 -- "not needed to support its core functionality" -- and an
    // unused permission in the request is the clearest possible instance of
    // that. It was removed after a second rejection.
    //
    // Every scope below is named against the call that needs it, because that
    // sentence is what App Review asks for and guessing it later is how the
    // list grew in the first place:
    //
    //   pages_show_list       GET /me/accounts -- list the Pages to publish to
    //   pages_manage_posts    POST /{page-id}/feed and /photos -- the publish
    //   pages_read_engagement GET /{post-id}/insights -- likes and comments back
    scope: ["pages_manage_posts", "pages_read_engagement", "pages_show_list"].join(","),
  });
  return `https://www.facebook.com/${env.meta.graphVersion}/dialog/oauth?${params}`;
}

export async function metaExchangeCode(code: string): Promise<string> {
  // Build with URLSearchParams, exactly as metaAuthorizeUrl does. Meta compares
  // redirect_uri between the dialog and this exchange as raw strings, and the
  // two encoders disagree on some characters (a space becomes "+" here and
  // "%20" with encodeURIComponent), enough to fail with "Error validating
  // verification code".
  const params = new URLSearchParams({
    client_id: env.meta.appId,
    client_secret: env.meta.appSecret,
    redirect_uri: env.meta.redirectUri,
    code,
  });
  const shortLived = await getJson(graph(`/oauth/access_token?${params}`));
  // Exchange for a ~60-day long-lived token
  const longLived = await getJson(
    graph(
      `/oauth/access_token?grant_type=fb_exchange_token&client_id=${env.meta.appId}` +
        `&client_secret=${env.meta.appSecret}&fb_exchange_token=${shortLived.access_token}`,
    ),
  );
  return longLived.access_token as string;
}

export interface MetaPage {
  pageId: string;
  pageName: string;
  pageAccessToken: string;
}

// ---------- TikTok (Content Posting API) ----------
// TikTok names the app identifier `client_key`, and the authorize host
// (www.tiktok.com) differs from the API host (open.tiktokapis.com).

const TIKTOK_API = "https://open.tiktokapis.com/v2";

export interface TikTokAccount {
  openId: string;
  displayName: string;
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export function tiktokAuthorizeUrl(state: string, codeChallenge?: string): string {
  if (!env.tiktok.clientKey) {
    throw new BadRequestException(
      "TikTok is not configured on this server (TIKTOK_CLIENT_KEY missing)",
    );
  }
  const params = new URLSearchParams({
    client_key: env.tiktok.clientKey,
    // The two posting routes need separate scopes, and they are not a
    // hierarchy: video.publish covers publishing straight to the account,
    // video.upload covers sending a draft to the user's inbox to finish in the
    // TikTok app. Requesting only video.publish and then sending a draft gets
    // scope_not_authorized, so ask for both.
    scope: "user.info.basic,video.publish,video.upload",
    response_type: "code",
    redirect_uri: env.tiktok.redirectUri,
    state,
  });
  // PKCE (RFC 7636). TikTok v2 is the one provider here that documents support
  // for the web flow; the others reject or ignore these parameters, so the
  // caller decides. See oauth-state.service.ts PKCE_SUPPORTED.
  if (codeChallenge) {
    params.set("code_challenge", codeChallenge);
    params.set("code_challenge_method", "S256");
  }
  return `https://www.tiktok.com/v2/auth/authorize/?${params}`;
}

export async function tiktokExchangeCode(
  code: string,
  codeVerifier?: string,
): Promise<TikTokAccount> {
  const body = new URLSearchParams({
    client_key: env.tiktok.clientKey,
    client_secret: env.tiktok.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: env.tiktok.redirectUri,
  });
  // Proves this exchange came from whoever started the authorize request, even
  // if the code itself was intercepted.
  if (codeVerifier) body.set("code_verifier", codeVerifier);
  const tokenRes = await httpRequest(`${TIKTOK_API}/oauth/token/`, {
    timeoutMs: TIMEOUTS.platform,
    upstream: "tiktok",
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const token: any = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !token.access_token) {
    throw new BadRequestException(
      `TikTok token exchange failed: ${token.error_description ?? token.error ?? tokenRes.statusText}`,
    );
  }

  const info = await getJson(`${TIKTOK_API}/user/info/?fields=open_id,display_name`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  const user = info?.data?.user ?? {};
  return {
    openId: String(user.open_id ?? token.open_id ?? ""),
    displayName: (user.display_name as string) ?? "TikTok",
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? "",
    expiresInSeconds: token.expires_in ?? 86400,
  };
}

// ---------- Instagram API with Instagram Login ----------
// Publishes to an Instagram Business/Creator account with no Facebook Page.
// Note the hosts differ from the Facebook-Login flow: authorization is on
// www.instagram.com, the code exchange on api.instagram.com, and everything
// after that on graph.instagram.com.

const IG_GRAPH = "https://graph.instagram.com";

export interface InstagramAccount {
  igUserId: string;
  username: string;
  accessToken: string;
  expiresInSeconds: number;
}

export function instagramAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.instagram.appId,
    redirect_uri: env.instagram.redirectUri,
    scope: "instagram_business_basic,instagram_business_content_publish",
    response_type: "code",
    state,
  });
  return `https://www.instagram.com/oauth/authorize?${params}`;
}

export async function instagramExchangeCode(code: string): Promise<InstagramAccount> {
  // The code exchange is form-encoded POST, unlike Meta's query-string GET.
  const form = new URLSearchParams({
    client_id: env.instagram.appId,
    client_secret: env.instagram.appSecret,
    grant_type: "authorization_code",
    redirect_uri: env.instagram.redirectUri,
    code,
  });
  const shortRes = await httpRequest("https://api.instagram.com/oauth/access_token", {
    timeoutMs: TIMEOUTS.platform,
    upstream: "instagram",
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const short = (await shortRes.json()) as {
    access_token?: string;
    user_id?: string | number;
    error_message?: string;
  };
  if (!shortRes.ok || !short.access_token) {
    throw new BadRequestException(
      `Instagram rejected the authorization: ${short.error_message ?? shortRes.status}`,
    );
  }

  // Short-lived tokens last ~1 hour; trade up for the 60-day one.
  const longParams = new URLSearchParams({
    grant_type: "ig_exchange_token",
    client_secret: env.instagram.appSecret,
    access_token: short.access_token,
  });
  const long = await getJson(`${IG_GRAPH}/access_token?${longParams}`);
  const accessToken = (long.access_token as string) ?? short.access_token;
  const expiresInSeconds = (long.expires_in as number) ?? 3600;

  const me = await getJson(
    `${IG_GRAPH}/me?fields=id,username&access_token=${encodeURIComponent(accessToken)}`,
  );
  return {
    igUserId: String(me.id ?? short.user_id ?? ""),
    username: (me.username as string) ?? "instagram",
    accessToken,
    expiresInSeconds,
  };
}

/**
 * The Facebook Pages this user administers.
 *
 * No Instagram lookup happens here any more. Reading a Page's linked
 * instagram_business_account requires instagram_basic, which we deliberately no
 * longer request. Instagram is connected through its own button. Keeping the
 * call would spend a request per Page to be told we lack permission.
 */
export async function metaListPages(userToken: string): Promise<MetaPage[]> {
  const accounts = await getJson(
    graph(`/me/accounts?fields=id,name,access_token&access_token=${userToken}`),
  );
  const pages: MetaPage[] = (accounts.data ?? []).map(
    (page: { id: string; name: string; access_token: string }) => ({
      pageId: page.id,
      pageName: page.name,
      pageAccessToken: page.access_token,
    }),
  );
  if (pages.length === 0) {
    metaLogger.log(
      "Facebook returned no Pages for this user, they may administer none, or " +
        "may not have granted access to any during the dialog.",
    );
  }
  return pages;
}

// ---------- X OAuth 1.0a (click-to-connect) ----------

/**
 * X never adopted OAuth 2.0 for the posting endpoints this product uses, so
 * connecting an account means the three-legged OAuth 1.0a dance rather than
 * the redirect-and-exchange every other platform here does.
 *
 * It was previously not done at all: the connect card asked the customer to
 * visit developer.x.com, create a project and an app, and paste an access
 * token and secret out of it. That is a developer's chore, not a customer's,
 * and it is the reason the card sat unused.
 *
 * The reward for doing it properly is that the token pair this returns is
 * exactly what the engine's existing OAuth 1.0a signer already posts with, so
 * nothing downstream changes.
 */

const X_API = "https://api.twitter.com";

/**
 * RFC 3986 percent-encoding, which is not what encodeURIComponent does: it
 * leaves !'()* alone and OAuth requires them escaped. A signature computed
 * with the wrong escaping fails as a bare 401 with no body, so this is the
 * single easiest place in the flow to lose an afternoon.
 */
function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function oauth1Header(params: {
  method: "POST" | "GET";
  url: string;
  consumerKey: string;
  consumerSecret: string;
  /** Absent for the request-token step, which has no token yet. */
  token?: string;
  /** Empty string for the request-token step, the & separator is still required. */
  tokenSecret?: string;
  /** oauth_callback or oauth_verifier, which are signed like any other parameter. */
  extra?: Record<string, string>;
  /** Fixed values for tests; real calls generate them. */
  nonce?: string;
  timestamp?: string;
}): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: params.consumerKey,
    oauth_nonce: params.nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: params.timestamp ?? Math.floor(Date.now() / 1000).toString(),
    oauth_version: "1.0",
    ...(params.token ? { oauth_token: params.token } : {}),
    ...(params.extra ?? {}),
  };

  // The base string sorts every parameter by encoded key, then by encoded
  // value, and joins them before the whole collection is encoded again.
  const normalized = Object.keys(oauth)
    .map((k) => [percentEncode(k), percentEncode(oauth[k])] as const)
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const base = [
    params.method,
    percentEncode(params.url),
    percentEncode(normalized),
  ].join("&");
  const key = `${percentEncode(params.consumerSecret)}&${percentEncode(params.tokenSecret ?? "")}`;
  const signature = createHmac("sha1", key).update(base).digest("base64");

  // oauth_signature joins the header but never the base string it signs.
  const header: Record<string, string> = { ...oauth, oauth_signature: signature };
  return `OAuth ${Object.keys(header)
    .map((k) => `${percentEncode(k)}="${percentEncode(header[k])}"`)
    .join(", ")}`;
}

function requireXApp(): { apiKey: string; apiSecret: string } {
  if (!env.x.apiKey || !env.x.apiSecret) {
    throw new BadRequestException(
      "X is not configured on this server (X_API_KEY and X_API_SECRET missing)",
    );
  }
  return { apiKey: env.x.apiKey, apiSecret: env.x.apiSecret };
}

/** These endpoints answer in form encoding, not JSON. */
function parseForm(body: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(body).entries());
}

export interface XRequestToken {
  oauthToken: string;
  oauthTokenSecret: string;
}

/**
 * Step one: ask X for a temporary token, naming where to send the customer
 * back afterwards.
 */
export async function xRequestToken(): Promise<XRequestToken> {
  const { apiKey, apiSecret } = requireXApp();
  const url = `${X_API}/oauth/request_token`;
  const res = await httpRequest(url, {
    timeoutMs: TIMEOUTS.platform,
    upstream: "x",
    method: "POST",
    headers: {
      Authorization: oauth1Header({
        method: "POST",
        url,
        consumerKey: apiKey,
        consumerSecret: apiSecret,
        extra: { oauth_callback: env.x.redirectUri },
      }),
    },
  });
  const body = await res.text();
  if (!res.ok) {
    // X explains a rejected callback here and nowhere else, and it is the
    // failure people actually hit: the URL must be listed verbatim under the
    // app's "Callback URI / Redirect URL" settings.
    throw new BadRequestException(
      `X rejected the authorization request (${res.status}). ` +
        `Check that ${env.x.redirectUri} is listed as a Callback URI on the X app. ${body}`.trim(),
    );
  }
  const form = parseForm(body);
  if (form.oauth_callback_confirmed !== "true" || !form.oauth_token) {
    throw new BadRequestException(`X returned an unusable request token: ${body}`);
  }
  return { oauthToken: form.oauth_token, oauthTokenSecret: form.oauth_token_secret ?? "" };
}

/**
 * Step two. /authorize rather than /authenticate: the latter signs a returning
 * customer straight back in without showing the consent screen, which hides
 * from them that they are granting posting rights.
 */
export function xAuthorizeUrl(oauthToken: string): string {
  return `${X_API}/oauth/authorize?oauth_token=${encodeURIComponent(oauthToken)}`;
}

export interface XAccount {
  accessToken: string;
  accessSecret: string;
  userId: string;
  username: string;
}

/**
 * Step three: trade the verifier the customer came back with for the lasting
 * token pair. OAuth 1.0a tokens do not expire, so there is no refresh to
 * schedule, they end only when the account revokes them.
 */
export async function xExchangeVerifier(
  oauthToken: string,
  oauthTokenSecret: string,
  verifier: string,
): Promise<XAccount> {
  const { apiKey, apiSecret } = requireXApp();
  const url = `${X_API}/oauth/access_token`;
  const res = await httpRequest(url, {
    timeoutMs: TIMEOUTS.platform,
    upstream: "x",
    method: "POST",
    headers: {
      Authorization: oauth1Header({
        method: "POST",
        url,
        consumerKey: apiKey,
        consumerSecret: apiSecret,
        token: oauthToken,
        // Signed with the *request* token's secret. Using the consumer secret
        // alone here is the classic mistake and returns 401 with no detail.
        tokenSecret: oauthTokenSecret,
        extra: { oauth_verifier: verifier },
      }),
    },
  });
  const body = await res.text();
  if (!res.ok) {
    throw new BadRequestException(`X token exchange failed (${res.status}): ${body}`.trim());
  }
  const form = parseForm(body);
  if (!form.oauth_token || !form.oauth_token_secret) {
    throw new BadRequestException(`X returned an unusable access token: ${body}`);
  }
  return {
    accessToken: form.oauth_token,
    accessSecret: form.oauth_token_secret,
    userId: form.user_id ?? "",
    username: form.screen_name ?? "",
  };
}
