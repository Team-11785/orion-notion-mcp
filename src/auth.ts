export interface Member {
  /** Shown in the action log. Comes from the optional ?name= in the link; not verified. */
  name: string;
}

export interface AuthEnv {
  /** One shared secret for the whole team: everyone uses the same link. */
  TEAM_KEY?: string;
}

/**
 * The key can arrive three ways, so it works with every MCP client:
 *   1. In the URL:            https://<worker>/mcp/<key>
 *   2. As a bearer token:     Authorization: Bearer <key>
 *   3. As a custom header:    X-Api-Key: <key>
 */
export function extractKey(request: Request): string | null {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/mcp\/([A-Za-z0-9_-]{16,})\/?$/);
  if (match) return match[1];

  const auth = request.headers.get("Authorization");
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim() || null;

  return request.headers.get("X-Api-Key")?.trim() || null;
}

/** Constant-time string comparison, so the key can't be guessed byte by byte. */
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export function authenticate(request: Request, env: AuthEnv): Member | null {
  const team = env.TEAM_KEY?.trim();
  const key = extractKey(request);
  if (!team || team.length < 16 || !key || !safeEqual(key, team)) return null;

  const name = new URL(request.url).searchParams.get("name")?.trim().slice(0, 40);
  return { name: name || "Orion team" };
}
