// End-to-end check with the official MCP client: proves Claude-style clients can
// connect, list tools and call one over Streamable HTTP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import worker from "../src/index.js";

const KEY = "sdk-test-key-0123456789abcdef";
const env = {
  NOTION_TOKEN: "ntn_test",
  MEMBERS: JSON.stringify({ [createHash("sha256").update(KEY).digest("hex")]: { name: "Tester", role: "editor" } }),
};

test("official MCP SDK client can connect and call a tool", async () => {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const request = new Request(`http://localhost${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: ["GET", "HEAD"].includes(req.method!) ? undefined : Buffer.concat(chunks),
    });
    const response = await worker.fetch(request, env as any, { waitUntil() {} } as any);
    res.writeHead(response.status, Object.fromEntries((response.headers as any).entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;

  const client = new Client({ name: "sdk-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${port}/mcp/${KEY}`)));
  const { tools } = await client.listTools();
  assert.ok(tools.length >= 20, `got ${tools.length} tools`);
  assert.ok(tools.some((t) => t.name === "notion_create_pages"));
  assert.ok(!tools.some((t) => t.name === "notion_trash_page"), "editor must not see admin tools");
  const result: any = await client.callTool({ name: "notion_workspace_guide", arguments: {} });
  assert.match(result.content[0].text, /Missions/);
  assert.match(client.getInstructions() ?? "", /Tester/);
  await client.close();
  server.close();
});
