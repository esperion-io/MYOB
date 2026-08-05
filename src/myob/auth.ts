import { config } from "../config.js";
import type { MyobTokenResponse, StoredTokens } from "./types.js";

export function buildAuthorizeUrl(state?: string): string {
  const params = new URLSearchParams({
    client_id: config.myob.apiKey(),
    redirect_uri: config.myob.redirectUri(),
    response_type: "code",
    scope: config.myob.scopes,
    prompt: "consent",
  });
  if (state) params.set("state", state);

  return `${config.myob.authorizeUrl}?${params.toString()}`;
}

function toStoredTokens(token: MyobTokenResponse): StoredTokens {
  const expiresInSeconds = Number(token.expires_in) || 1200;
  // Refresh ~60s early so API calls don't race expiry.
  const expiresAt = Date.now() + Math.max(expiresInSeconds - 60, 30) * 1000;

  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt,
    scope: token.scope,
    userUid: token.user?.uid,
    username: token.user?.username,
  };
}

async function postToken(
  body: Record<string, string>,
): Promise<MyobTokenResponse> {
  const response = await fetch(config.myob.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(body),
  });

  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `MYOB token endpoint returned non-JSON (${response.status}): ${text.slice(0, 300)}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `MYOB token exchange failed (${response.status}): ${JSON.stringify(data)}`,
    );
  }

  return data as MyobTokenResponse;
}

export async function exchangeCodeForTokens(
  code: string,
): Promise<StoredTokens> {
  const token = await postToken({
    client_id: config.myob.apiKey(),
    client_secret: config.myob.apiSecret(),
    scope: config.myob.scopes,
    code,
    redirect_uri: config.myob.redirectUri(),
    grant_type: "authorization_code",
  });
  return toStoredTokens(token);
}

export async function refreshAccessToken(
  refreshToken: string,
): Promise<StoredTokens> {
  const token = await postToken({
    client_id: config.myob.apiKey(),
    client_secret: config.myob.apiSecret(),
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  return toStoredTokens(token);
}

export function companyFileTokenHeader(): string | undefined {
  const { cfUsername, cfPassword } = config.myob;
  if (!cfUsername || !cfPassword) return undefined;
  return Buffer.from(`${cfUsername}:${cfPassword}`, "utf8").toString("base64");
}
