import { BadRequestException } from "@nestjs/common";
import { env } from "../common/env";

/**
 * Thin HTTP clients used to VALIDATE credentials when a user connects a
 * platform. Publishing itself happens in the Python engine — these only
 * confirm the credentials work and fetch display metadata.
 */

async function getJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, init);
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
  const tokenRes = await fetch("https://www.reddit.com/api/v1/access_token", {
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
      "Reddit did not return a refresh token — re-try the authorization (duration=permanent).",
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
  const tokenRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
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
    scope: [
      "pages_manage_posts",
      "pages_read_engagement",
      "pages_show_list",
      "instagram_basic",
      "instagram_content_publish",
      "business_management",
    ].join(","),
  });
  return `https://www.facebook.com/${env.meta.graphVersion}/dialog/oauth?${params}`;
}

/** Upgrade a short-lived user token (e.g. from the Graph API Explorer) to a
 *  ~60-day long-lived one, so the Page tokens derived from it don't expire in
 *  ~1 hour. Returns the input unchanged if it's already long-lived. */
export async function metaExchangeUserToken(userToken: string): Promise<string> {
  const longLived = await getJson(
    graph(
      `/oauth/access_token?grant_type=fb_exchange_token&client_id=${env.meta.appId}` +
        `&client_secret=${env.meta.appSecret}&fb_exchange_token=${encodeURIComponent(userToken)}`,
    ),
  );
  return (longLived.access_token as string) ?? userToken;
}

export async function metaExchangeCode(code: string): Promise<string> {
  const shortLived = await getJson(
    graph(
      `/oauth/access_token?client_id=${env.meta.appId}&client_secret=${env.meta.appSecret}` +
        `&redirect_uri=${encodeURIComponent(env.meta.redirectUri)}&code=${encodeURIComponent(code)}`,
    ),
  );
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
  igUserId: string | null;
  igUsername: string | null;
}

/** Treat the token as a Page access token and read that one Page directly.
 *  Returns null if it isn't a Page token (Page nodes carry a `category`; a User
 *  token's /me does not), so a plain user token can't be mistaken for a Page. */
export async function metaPageFromToken(pageToken: string): Promise<MetaPage | null> {
  try {
    const me = await getJson(
      graph(
        `/me?fields=id,name,category,instagram_business_account{id,username}` +
          `&access_token=${encodeURIComponent(pageToken)}`,
      ),
    );
    if (!me.id || !me.name || !me.category) return null;
    return {
      pageId: me.id,
      pageName: me.name,
      pageAccessToken: pageToken,
      igUserId: me.instagram_business_account?.id ?? null,
      igUsername: me.instagram_business_account?.username ?? null,
    };
  } catch {
    return null;
  }
}

export async function metaListPages(userToken: string): Promise<MetaPage[]> {
  const accounts = await getJson(
    graph(`/me/accounts?fields=id,name,access_token&access_token=${userToken}`),
  );
  const pages: MetaPage[] = [];
  for (const page of accounts.data ?? []) {
    let igUserId: string | null = null;
    let igUsername: string | null = null;
    try {
      const ig = await getJson(
        graph(
          `/${page.id}?fields=instagram_business_account{id,username}&access_token=${page.access_token}`,
        ),
      );
      igUserId = ig.instagram_business_account?.id ?? null;
      igUsername = ig.instagram_business_account?.username ?? null;
    } catch {
      // page without a linked IG business account — fine
    }
    pages.push({
      pageId: page.id,
      pageName: page.name,
      pageAccessToken: page.access_token,
      igUserId,
      igUsername,
    });
  }
  return pages;
}
