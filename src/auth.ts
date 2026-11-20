export type Role = "viewer" | "editor" | "admin";

export interface Member {
  name: string;
  role: Role;
}

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };

export function hasRole(member: Member, needed: Role): boolean {
  return ROLE_RANK[member.role] >= ROLE_RANK[needed];
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The key can arrive three ways, so it works with every Claude plan:
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

/**
 * MEMBERS is a JSON object whose keys are SHA-256 hashes of member keys, so the
 * real keys are never stored anywhere on the server:
 *   { "<sha256 of key>": { "name": "Itay", "role": "editor" } }
 */
export function parseMembers(raw: string | undefined): Record<string, Member> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("MEMBERS secret is not valid JSON");
  }
  const out: Record<string, Member> = {};
  for (const [hash, value] of Object.entries(parsed as Record<string, any>)) {
    const role: Role = ["viewer", "editor", "admin"].includes(value?.role) ? value.role : "viewer";
    out[hash.toLowerCase()] = { name: String(value?.name ?? "unknown"), role };
  }
  return out;
}

export interface AuthEnv {
  /** One shared secret for the whole team: everyone uses the same link. */
  TEAM_KEY?: string;
  /** Role for people using the team link (default: editor). */
  TEAM_ROLE?: string;
  /** Optional personal keys (e.g. admins), see scripts/gen-key.mjs. */
  MEMBERS?: string;
}

/** Constant-time string comparison, so the team key can't be guessed byte by byte. */
function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export async function authenticate(request: Request, env: AuthEnv): Promise<Member | null> {
  const key = extractKey(request);
  if (!key) return null;

  const team = env.TEAM_KEY?.trim();
  if (team && team.length >= 16 && safeEqual(key, team)) {
    // Optional, unverified name for the action log: .../mcp/<team-key>?name=Itay
    const name = new URL(request.url).searchParams.get("name")?.trim().slice(0, 40);
    const role: Role = env.TEAM_ROLE === "viewer" || env.TEAM_ROLE === "admin" ? env.TEAM_ROLE : "editor";
    return { name: name ? `${name} (team link)` : "Orion team", role };
  }

  const members = parseMembers(env.MEMBERS);
  return members[await sha256Hex(key)] ?? null;
}
