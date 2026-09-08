import { gapi } from "gapi-script";

const TOKEN_KEY = "portfolio_gauth_token";

/**
 * How early a token is treated as dead. `restoreGoogleToken` and `hasValidGoogleToken` both
 * refuse a token inside this window, so anything DISPLAYING a countdown has to subtract it too -
 * otherwise the clock says "40 seconds left" about a token the app already will not use.
 */
export const TOKEN_SAFETY_MS = 60_000;

/**
 * Milliseconds until the token stops being USABLE, or `null` when there is no stored token.
 *
 * Null is "signed out", NOT "expired" - the two want opposite treatment on screen, so they are
 * kept distinguishable here rather than collapsed into 0.
 */
export function googleTokenMsRemaining(): number | null {
  try {
    const saved = localStorage.getItem(TOKEN_KEY);
    if (!saved) return null;
    const tok = JSON.parse(saved);
    if (!tok || !tok.access_token || !tok.expires_at) return null;
    return (tok.expires_at - TOKEN_SAFETY_MS) - Date.now();
  } catch {
    return null;
  }
}

// Persist the OAuth access token so a page reload within its lifetime (~1 hour)
// keeps the Sheets connection alive without re-prompting the user.
export function persistGoogleToken(tokenResponse: { access_token: string; expires_in?: number }) {
  try {
    if (gapi && gapi.client) {
      (gapi.client as any).setToken({ access_token: tokenResponse.access_token });
    }
    const expiresAt = Date.now() + ((tokenResponse.expires_in ?? 3599) * 1000);
    localStorage.setItem(TOKEN_KEY, JSON.stringify({
      access_token: tokenResponse.access_token,
      expires_at: expiresAt,
    }));
  } catch (e) {
    console.warn("Failed to persist Google token:", e);
  }
}

// Restore a previously granted token into gapi. Returns true if a valid token was restored.
export function restoreGoogleToken(): boolean {
  try {
    const saved = localStorage.getItem(TOKEN_KEY);
    if (!saved) return false;
    const tok = JSON.parse(saved);
    // 60s safety margin so we never hand out a token about to expire
    if (tok.access_token && tok.expires_at && Date.now() < tok.expires_at - TOKEN_SAFETY_MS) {
      if (gapi && gapi.client) {
        (gapi.client as any).setToken({ access_token: tok.access_token });
        return true;
      }
      return false;
    }
    localStorage.removeItem(TOKEN_KEY);
  } catch (e) {
    console.warn("Failed to restore Google token:", e);
  }
  return false;
}

export function hasValidGoogleToken(): boolean {
  try {
    if (!gapi || !gapi.client) return false;
    const token = (gapi.client as any).getToken();
    if (!token || !token.access_token) return false;
    const saved = localStorage.getItem(TOKEN_KEY);
    if (saved) {
      const tok = JSON.parse(saved);
      if (tok.expires_at && Date.now() >= tok.expires_at - TOKEN_SAFETY_MS) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function clearGoogleToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    if (gapi && gapi.client) {
      (gapi.client as any).setToken(null);
    }
  } catch (e) {
    console.warn("Failed to clear Google token:", e);
  }
}
