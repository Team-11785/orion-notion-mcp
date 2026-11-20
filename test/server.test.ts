import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { normalizeId } from "../src/notion.js";

// ------------------------------------------------------------ fake Notion API

const PAGE = "11111111-1111-1111-1111-111111111111";
const DB = "22222222-2222-2222-2222-222222222222";
const DS = "33333333-3333-3333-3333-333333333333";
const LOG_DS = "44444444-4444-4444-4444-444444444444";
const ROW = "55555555-5555-5555-5555-555555555555";
const USER_ITAY = "66666666-6666-6666-6666-666666666666";

const schema = {
  Name: { id: "title", type: "title", title: {} },
  Status: {
    id: "s1",
    type: "status",
    status: { options: [{ id: "o1", name: "Not started" }, { id: "o2", name: "In progress" }], groups: [] },
  },
  Due: { id: "d1", type: "date", date: {} },
  Owner: { id: "p1", type: "people", people: {} },
  Tags: { id: "t1", type: "multi_select", multi_select: { options: [{ name: "CAD" }] } },
  Done: { id: "c1", type: "checkbox", checkbox: {} },
};

let calls: { method: string; path: string; body: any }[] = [];

const rt = (s: string) => [{ type: "text", text: { content: s }, plain_text: s }];
const page = (id: string, title: string, parent: any) => ({
  object: "page",
  id,
  url: `https://www.notion.so/${id.replace(/-/g, "")}`,
  parent,
  created_time: "2026-11-01T00:00:00.000Z",
  last_edited_time: "2026-11-20T00:00:00.000Z",
  properties: { title: { id: "title", type: "title", title: rt(title) } },
});

function fakeNotion(method: string, path: string, body: any): [number, any] {
  const m = (re: RegExp) => path.match(re);
  if (method === "GET" && path === "/users/me") return [200, { bot: { workspace_name: "ORION FRC" } }];
  if (method === "GET" && path === "/users") {
    return [200, { results: [
      { object: "user", id: USER_ITAY, type: "person", name: "Itay Shamir", person: { email: "itay@example.com" } },
      { object: "user", id: "77777777-7777-7777-7777-777777777777", type: "person", name: "Noa", person: {} },
    ], has_more: false }];
  }
  if (method === "POST" && path === "/search") {
    if (body?.filter?.value === "data_source") {
      return [200, { results: [{ object: "data_source", id: DS, title: rt("Missions"), parent: { database_id: DB }, properties: schema }], has_more: false }];
    }
    return [200, { results: [page(PAGE, "Home", { type: "page_id" })], has_more: false }];
  }
  let r;
  if ((r = m(/^\/data_sources\/([^/]+)$/)) && method === "GET") {
    if (r[1] === DS) return [200, { object: "data_source", id: DS, title: rt("Missions"), parent: { database_id: DB }, properties: schema }];
    return [404, { code: "object_not_found", message: "Could not find data_source" }];
  }
  if ((r = m(/^\/data_sources\/([^/]+)$/)) && method === "PATCH") {
    return [200, { object: "data_source", id: DS, title: rt("Missions"), properties: schema }];
  }
  if ((r = m(/^\/data_sources\/([^/]+)\/query$/)) && method === "POST") {
    const row: any = page(ROW, "Print mount", { type: "data_source_id", data_source_id: DS });
    row.properties = {
      Name: { type: "title", title: rt("Print mount") },
      Status: { type: "status", status: { name: "In progress" } },
      Due: { type: "date", date: { start: "2026-11-26", end: null } },
      Owner: { type: "people", people: [{ id: USER_ITAY, name: "Itay Shamir" }] },
    };
    return [200, { results: [row], has_more: false }];
  }
  if ((r = m(/^\/databases\/([^/]+)$/)) && method === "GET") {
    if (r[1] === DB) return [200, { object: "database", id: DB, title: rt("Missions"), data_sources: [{ id: DS, name: "Missions" }] }];
    return [404, { code: "object_not_found", message: "Could not find database" }];
  }
  if ((r = m(/^\/pages\/([^/]+)\/markdown$/))) {
    if (method === "GET") {
      const md = r[1].replace(/-/g, "") === PAGE.replace(/-/g, "")
        ? '# Home\n\nWelcome Orion\n<database url="https://app.notion.com/p/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa">Tasks</database>\n<page url="https://app.notion.com/p/Team-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb">Team page</page>'
        : "child page";
      return [200, { object: "page_markdown", id: r[1], markdown: md, truncated: false }];
    }
    return [200, { object: "page_markdown", id: r[1], markdown: "updated" }];
  }
  if ((r = m(/^\/pages\/([^/]+)\/move$/)) && method === "POST") {
    return [200, page(r[1], "Moved", body.parent)];
  }
  if ((r = m(/^\/pages\/([^/]+)$/))) {
    if (r[1] !== PAGE && r[1] !== ROW) return [404, { code: "object_not_found", message: "Could not find page" }];
    if (method === "GET") {
      return [200, r[1] === ROW ? page(ROW, "Print mount", { type: "data_source_id", data_source_id: DS }) : page(PAGE, "Home", { type: "workspace" })];
    }
    if (method === "PATCH") return [200, { ...page(r[1], "Home", { type: "workspace" }), in_trash: body.in_trash }];
  }
  if (method === "POST" && path === "/pages") return [200, page("88888888-8888-8888-8888-888888888888", "New", body.parent)];
  if (method === "POST" && path === "/file_uploads") return [200, { object: "file_upload", id: "fu-1", status: "pending" }];
  if (method === "GET" && path === "/file_uploads/fu-1") return [200, { object: "file_upload", id: "fu-1", status: "uploaded", content_type: "image/png" }];
  if ((r = m(/^\/blocks\/([^/]+)\/children$/)) && method === "PATCH") return [200, { results: [] }];
  if (method === "POST" && path === "/comments") return [200, { object: "comment", id: "c-1", discussion_id: "d-1" }];
  return [404, { code: "object_not_found", message: `no fake route for ${method} ${path}` }];
}

globalThis.fetch = (async (input: any, init?: any) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  assert.equal(url.host, "api.notion.com");
  const path = url.pathname.replace(/^\/v1/, "");
  const body = init?.body ? JSON.parse(init.body) : undefined;
  calls.push({ method: init?.method ?? "GET", path, body });
  assert.equal(new Headers(init?.headers).get("Notion-Version"), "2026-03-11");
  const [status, data] = fakeNotion(init?.method ?? "GET", path, body);
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

// ------------------------------------------------------------ harness

const TEAM = "team-key-0123456789abcdef";
// Everyone uses the same team link; the names only make the tests easier to read.
const KEYS = { viewer: TEAM, editor: TEAM, admin: TEAM };
const env = {
  NOTION_TOKEN: "ntn_test",
  TEAM_KEY: TEAM,
  ROOT_PAGE_ID: PAGE,
  LOG_DATA_SOURCE_ID: LOG_DS,
};

let pending: Promise<unknown>[] = [];
const exec = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} } as any;

async function rpc(key: keyof typeof KEYS | null, method: string, params?: any, id: number | null = 1) {
  const url = key ? `https://srv.example/mcp/${KEYS[key]}?name=Itay` : "https://srv.example/mcp";
  const res = await worker.fetch(
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }),
    }),
    env as any,
    exec,
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function call(key: keyof typeof KEYS, name: string, args: any) {
  const { body } = await rpc(key, "tools/call", { name, arguments: args });
  const result = body.result;
  const text = result.content[0].text as string;
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch { /* markdown output */ }
  return { isError: Boolean(result.isError), text, data: parsed };
}

beforeEach(() => {
  calls = [];
  pending = [];
});

// ------------------------------------------------------------ tests

test("rejects missing and wrong keys", async () => {
  assert.equal((await rpc(null, "initialize")).status, 401);
  const bad = await worker.fetch(new Request("https://srv.example/mcp/not-a-real-key-zzzzzzzz", { method: "POST", body: "{}" }), env as any, exec);
  assert.equal(bad.status, 401);
});

test("accepts the key as a bearer header too", async () => {
  const res = await worker.fetch(
    new Request("https://srv.example/mcp", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEYS.editor}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    }),
    env as any,
    exec,
  );
  assert.equal(res.status, 200);
});

test("initialize negotiates the protocol and names the member", async () => {
  const { body } = await rpc("editor", "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude" } });
  assert.equal(body.result.protocolVersion, "2025-06-18");
  assert.ok(body.result.capabilities.tools);
  assert.match(body.result.instructions, /Itay/);
  const unknown = await rpc("editor", "initialize", { protocolVersion: "1999-01-01" });
  assert.equal(unknown.body.result.protocolVersion, "2025-11-25");
});

test("notifications get 202 with no body", async () => {
  const res = await rpc("editor", "notifications/initialized", undefined, null);
  assert.equal(res.status, 202);
});

test("every tool is available through the team link", async () => {
  const names = (await rpc("viewer", "tools/list")).body.result.tools.map((t: any) => t.name);
  assert.equal(names.length, 31);
  for (const n of ["notion_fetch", "notion_create_pages", "notion_trash_page", "notion_api_request", "notion_workspace_guide"]) {
    assert.ok(names.includes(n), n);
  }
});

test("fetch returns page properties and markdown", async () => {
  const r = await call("viewer", "notion_fetch", { id: `https://app.notion.com/p/Home-${PAGE.replace(/-/g, "")}?pvs=4` });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /"title": "Home"/);
  assert.match(r.text, /Welcome Orion/);
  assert.equal(calls.find((c) => c.path.endsWith("/markdown"))?.method, "GET");
});

test("fetch on a database returns its schema", async () => {
  const r = await call("viewer", "notion_fetch", { id: DB });
  assert.ok(!r.isError, r.text);
  assert.equal(r.data.object, "database");
  assert.equal(r.data.data_sources[0].schema.Status.type, "status");
  assert.deepEqual(r.data.data_sources[0].schema.Status.options, ["Not started", "In progress"]);
});

test("query simplifies rows", async () => {
  const r = await call("viewer", "notion_query_data_source", { id: DB, filter: { property: "Status", status: { equals: "In progress" } } });
  assert.ok(!r.isError, r.text);
  assert.equal(r.data.rows[0].properties.Status, "In progress");
  assert.equal(r.data.rows[0].properties.Due, "2026-11-26");
  const q = calls.find((c) => c.path.endsWith("/query"))!;
  assert.equal(q.path, `/data_sources/${DS}/query`);
  assert.deepEqual(q.body.filter, { property: "Status", status: { equals: "In progress" } });
});

test("create rows converts plain values using the schema", async () => {
  const r = await call("editor", "notion_create_pages", {
    parent_id: DB,
    pages: [{
      title: "Print motor mount",
      properties: { status: "In progress", Due: "2026-11-26", Owner: "itay", Tags: "CAD, Printing", Done: "yes" },
      markdown: "- [ ] slice the model",
      icon: "🔧",
    }],
  });
  assert.ok(!r.isError, r.text);
  assert.equal(r.data.created, 1, r.text);
  const post = calls.find((c) => c.method === "POST" && c.path === "/pages")!;
  assert.deepEqual(post.body.parent, { type: "data_source_id", data_source_id: DS });
  assert.equal(post.body.properties.Name.title[0].text.content, "Print motor mount");
  assert.deepEqual(post.body.properties.Status, { status: { name: "In progress" } });
  assert.deepEqual(post.body.properties.Due, { date: { start: "2026-11-26" } });
  assert.deepEqual(post.body.properties.Owner, { people: [{ id: USER_ITAY }] });
  assert.deepEqual(post.body.properties.Tags, { multi_select: [{ name: "CAD" }, { name: "Printing" }] });
  assert.deepEqual(post.body.properties.Done, { checkbox: true });
  assert.equal(post.body.markdown_version, "v2");
  assert.deepEqual(post.body.icon, { type: "emoji", emoji: "🔧" });
});

test("unknown property names are reported, not dropped", async () => {
  const r = await call("editor", "notion_create_pages", { parent_id: DS, pages: [{ title: "x", properties: { Priority: "High" } }] });
  assert.equal(r.data.created, 0);
  assert.match(r.data.results[0].error, /no property named "Priority"/);
});

test("pages under a plain page only accept a title", async () => {
  const r = await call("editor", "notion_create_pages", { parent_id: PAGE, pages: [{ title: "Notes", markdown: "hi" }] });
  assert.equal(r.data.created, 1, r.text);
  const post = calls.find((c) => c.method === "POST" && c.path === "/pages")!;
  assert.deepEqual(post.body.parent, { type: "page_id", page_id: PAGE });
  assert.ok(post.body.properties.title);
});

test("update_page sends search-and-replace edits and a log row", async () => {
  const r = await call("editor", "notion_update_page", {
    page_id: ROW,
    properties: { Status: "Not started" },
    content: { mode: "search_replace", edits: [{ old_text: "slice", new_text: "print" }] },
  });
  assert.ok(!r.isError, r.text);
  const md = calls.find((c) => c.method === "PATCH" && c.path.endsWith("/markdown"))!;
  assert.equal(md.body.type, "update_content");
  assert.deepEqual(md.body.update_content.content_updates[0], { old_str: "slice", new_str: "print", replace_all_matches: false });
  assert.equal(md.body.update_content.allow_deleting_content, false);
  const prop = calls.find((c) => c.method === "PATCH" && c.path === `/pages/${ROW}`)!;
  assert.deepEqual(prop.body.properties.Status, { status: { name: "Not started" } });

  await Promise.all(pending);
  const log = calls.find((c) => c.method === "POST" && c.body?.parent?.data_source_id === LOG_DS)!;
  assert.ok(log, "expected a log row");
  assert.equal(log.body.properties.Member.rich_text[0].text.content, "Itay");
});

test("deleting tools work (Claude is told to confirm first)", async () => {
  const a = await call("editor", "notion_update_page", { page_id: PAGE, content: { mode: "replace_all", markdown: "x" }, allow_deleting_content: true });
  assert.ok(!a.isError, a.text);
  assert.equal(calls.find((c) => c.path.endsWith("/markdown") && c.method === "PATCH")!.body.replace_content.allow_deleting_content, true);
  const c = await call("admin", "notion_trash_page", { page_id: PAGE });
  assert.ok(!c.isError, c.text);
  const init = await rpc("viewer", "initialize", {});
  assert.match(init.body.result.instructions, /confirm with the user/);
});

test("move into a database uses data_source_id parent", async () => {
  const r = await call("editor", "notion_move_page", { page_id: PAGE, new_parent_id: DB });
  assert.ok(!r.isError, r.text);
  assert.deepEqual(calls.find((c) => c.path.endsWith("/move"))!.body.parent, { type: "data_source_id", data_source_id: DS });
});

test("comments carry the member's name", async () => {
  const r = await call("editor", "notion_create_comment", { page_id: PAGE, text: "Looks good" });
  assert.ok(!r.isError, r.text);
  const post = calls.find((c) => c.path === "/comments")!;
  assert.deepEqual(post.body.display_name, { type: "custom", custom: { name: "Itay (Claude)" } });
  assert.equal(post.body.markdown, "Looks good");
});

test("ambiguous people names give a helpful error", async () => {
  // "a" matches both Itay Shamir and Noa
  const r = await call("editor", "notion_create_pages", { parent_id: DS, pages: [{ title: "x", properties: { Owner: "a" } }] });
  assert.match(r.data.results[0].error, /matches several people/);
});

test("raw API path is sanitized", async () => {
  const r = await call("admin", "notion_api_request", { method: "GET", path: "https://evil.example/x" });
  assert.ok(r.isError);
});

test("Notion errors explain missing sharing", async () => {
  const r = await call("viewer", "notion_query_data_source", { id: "99999999999999999999999999999999" });
  assert.ok(r.isError);
});

test("duplicate links sub-pages instead of moving them", async () => {
  const { detachChildren } = await import("../src/tools-extra.js");
  const r = detachChildren('Intro\n<page url="https://app.notion.com/p/abc">Child</page>\n<database url="https://app.notion.com/p/def" inline="true">Tasks</database>');
  assert.equal(r.detached, 2);
  assert.doesNotMatch(r.markdown, /<page|<database/);
  assert.match(r.markdown, /\[📄 Child\]\(https:\/\/app.notion.com\/p\/abc\)/);
});

test("duplicate copies a row into the same database", async () => {
  const r = await call("editor", "notion_duplicate_page", { page_id: ROW });
  assert.ok(!r.isError, r.text);
  const post = calls.find((c) => c.method === "POST" && c.path === "/pages")!;
  assert.deepEqual(post.body.parent, { type: "data_source_id", data_source_id: DS });
  assert.equal(post.body.properties.title.title[0].text.content, "Print mount (copy)");
});

test("upload from URL waits for import and appends an image block", async () => {
  const r = await call("editor", "notion_upload_file_from_url", { url: "https://example.com/robot.png", filename: "robot.png", page_id: PAGE });
  assert.ok(!r.isError, r.text);
  const block = calls.find((c) => c.path === `/blocks/${PAGE}/children`)!;
  assert.equal(block.body.children[0].type, "image");
  assert.deepEqual(block.body.children[0].image.file_upload, { id: "fu-1" });
});

test("workspace guide is built live from Notion", async () => {
  const { clearWorkspaceMapCache } = await import("../src/workspace.js");
  clearWorkspaceMapCache();
  const r = await call("viewer", "notion_workspace_guide", {});
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /Missions \(database 22222222222222222222222222222222, data source 33333333/);
  assert.match(r.text, /Status \(status: Not started \| In progress\)/);
  assert.match(r.text, /🗂️ Tasks \(database aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\)/);
  assert.match(r.text, /Team page \(page bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\)/);
  assert.match(r.text, /Conventions/);

  // Cached: a second call makes no Notion requests...
  calls = [];
  await call("viewer", "notion_workspace_guide", {});
  assert.equal(calls.length, 0);
  // ...unless refresh is asked for.
  await call("viewer", "notion_workspace_guide", { refresh: true });
  assert.ok(calls.length > 0);

  const init = await rpc("viewer", "initialize", { protocolVersion: "2025-06-18" });
  assert.match(init.body.result.instructions, /notion_workspace_guide/);
});

test("the shared team link works without personal keys", async () => {
  const post = (url: string) =>
    worker.fetch(
      new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) }),
      env as any,
      exec,
    );
  const ok = await post("https://srv.example/mcp/team-key-0123456789abcdef?name=Itay");
  assert.equal(ok.status, 200);
  assert.match((await ok.json()).result.instructions, /logged under "Itay"/);
  const anon = await post("https://srv.example/mcp/team-key-0123456789abcdef");
  assert.match((await anon.json()).result.instructions, /Orion team/);
  assert.equal((await post("https://srv.example/mcp/team-key-0123456789abcdeX")).status, 401);
  assert.equal((await post("https://srv.example/mcp")).status, 401);
});

test("a too-short team key is ignored", async () => {
  const res = await worker.fetch(
    new Request("https://srv.example/mcp/shortkey12345678", { method: "POST", body: "{}" }),
    { ...env, TEAM_KEY: "short" } as any,
    exec,
  );
  assert.equal(res.status, 401);
});

test("normalizeId handles Notion URL shapes", () => {
  const raw = "5c401eef9edb83a3bd9381079ff45d75";
  const dashed = "5c401eef-9edb-83a3-bd93-81079ff45d75";
  assert.equal(normalizeId(raw), dashed);
  assert.equal(normalizeId(`https://app.notion.com/p/2026-2027-${raw}?pvs=13`), dashed);
  assert.equal(normalizeId(`https://www.notion.so/orion/Home-${raw}`), dashed);
  assert.equal(normalizeId(`https://www.notion.so/x?p=${raw}&pm=s`), dashed);
  assert.equal(normalizeId(`collection://${dashed}`), dashed);
  assert.throws(() => normalizeId("hello"));
});
