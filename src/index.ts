import { authenticate, type Member } from "./auth.js";
import { Notion, NotionError } from "./notion.js";
import { TOOLS } from "./registry.js";
import type { Env, ToolContext } from "./tools.js";
import { CONVENTIONS } from "./workspace.js";
import { handleGithubWebhook, runScheduled, type AutomationEnv } from "./automation.js";

/** The part of Cloudflare's ExecutionContext this server uses. */
interface Exec {
  waitUntil(promise: Promise<unknown>): void;
}

const SERVER_INFO = { name: "orion-notion", title: "Orion FRC Notion", version: "1.0.0" };
const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

const rpcResult = (id: RpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: RpcRequest["id"], code: number, message: string) => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function instructions(env: Env, member: Member) {
  return [
    "This server is the Orion FRC robotics team's Notion workspace.",
    `Actions are logged under "${member.name}".`,
    env.ROOT_PAGE_ID
      ? `The season's root page is ${env.ROOT_PAGE_ID}; start there (notion_fetch) when you need to find your way around.`
      : "",
    "Before editing a page, read it with notion_fetch. Before adding rows, read the database schema with notion_fetch.",
    "Prefer small, targeted edits (search_replace) over rewriting whole pages.",
    "Before deleting anything (trash, removing columns, allow_deleting_content), confirm with the user.",
    "Team members often write in Hebrew; reply in the language they use.",
    "Call notion_workspace_guide once at the start: it lists every database, its columns and exact option names, read live from Notion.",
    "",
    CONVENTIONS,
  ]
    .filter(Boolean)
    .join("\n");
}

async function handleRpc(msg: RpcRequest, member: Member, env: Env, exec: Exec): Promise<object | null> {
  const isNotification = msg.id === undefined || msg.id === null;

  switch (msg.method) {
    case "initialize": {
      const requested = msg.params?.protocolVersion;
      return rpcResult(msg.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: instructions(env, member),
      });
    }

    case "ping":
      return rpcResult(msg.id, {});

    case "tools/list":
      return rpcResult(msg.id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { title: t.title, openWorldHint: false, ...t.annotations },
        })),
      });

    case "tools/call": {
      const name = msg.params?.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
      const ctx: ToolContext = {
        notion: new Notion(env.NOTION_TOKEN),
        member,
        env,
        background: (p) => exec.waitUntil(p),
        cache: new Map(),
      };
      try {
        const out = await tool.run(msg.params?.arguments ?? {}, ctx);
        const text = typeof out === "string" ? out : JSON.stringify(out, null, 1);
        return rpcResult(msg.id, { content: [{ type: "text", text }] });
      } catch (e) {
        const message =
          e instanceof NotionError
            ? `Notion API error ${e.status} (${e.code}): ${e.message}` +
              (e.status === 404 ? " — the page may not be shared with the team's integration." : "")
            : (e as Error).message;
        return rpcResult(msg.id, { content: [{ type: "text", text: message }], isError: true });
      }
    }

    default:
      if (isNotification) return null; // e.g. notifications/initialized
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export default {
  async fetch(request: Request, env: Env, exec: Exec): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/github/webhook" && request.method === "POST") {
      return handleGithubWebhook(request, env as Env & AutomationEnv);
    }
    if (url.pathname === "/" && request.method === "GET") {
      return new Response("Orion Notion MCP server is running. Connect Claude to /mcp/<team key>.\n");
    }
    if (!/^\/mcp(\/|$)/.test(url.pathname)) return new Response("Not found", { status: 404 });

    if (!env.NOTION_TOKEN) return json(rpcError(null, -32603, "Server is missing NOTION_TOKEN"), 500);

    const member = authenticate(request, env);
    if (!member) return json(rpcError(null, -32001, "Unknown or missing key in the link"), 401);

    // Stateless server: no SSE stream and no sessions to close.
    if (request.method === "GET" || request.method === "DELETE") {
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    }
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });

    let payload: RpcRequest | RpcRequest[];
    try {
      payload = await request.json();
    } catch {
      return json(rpcError(null, -32700, "Parse error"), 400);
    }

    if (Array.isArray(payload)) {
      const replies = (await Promise.all(payload.map((m) => handleRpc(m, member, env, exec)))).filter(Boolean);
      return replies.length ? json(replies) : new Response(null, { status: 202 });
    }
    const reply = await handleRpc(payload, member, env, exec);
    return reply ? json(reply) : new Response(null, { status: 202 });
  },

  /** Daily cron (see [triggers] in wrangler.toml): next meeting page + digest. */
  async scheduled(_event: unknown, env: Env, exec: Exec): Promise<void> {
    exec.waitUntil(runScheduled(env as Env & AutomationEnv).then((r) => console.log("scheduled", JSON.stringify(r))));
  },
};
