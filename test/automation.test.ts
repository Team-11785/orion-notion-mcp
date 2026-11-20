import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  addDays,
  buildDigest,
  ensureNextMeeting,
  handleGithubWebhook,
  localDate,
  runScheduled,
  statusForPullRequest,
} from "../src/automation.js";

// ------------------------------------------------------------ fake Notion + chat APIs

const MISSIONS_DB = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const MISSIONS_DS = "aaaaaaaa-0000-0000-0000-000000000001";
const TEAM_DB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const TEAM_DS = "bbbbbbbb-0000-0000-0000-000000000001";
const MEET_DB = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const MEET_DS = "cccccccc-0000-0000-0000-000000000001";
const TASK_ROW = "dddddddd-dddd-dddd-dddd-dddddddddddd";

// 2026-11-22 is a Sunday; 05:00 UTC is 07:00 in Israel.
const NOW = new Date("2026-11-22T05:00:00Z");

const rt = (s: string) => [{ type: "text", text: { content: s }, plain_text: s }];
const statusCfg = (names: string[], complete: string[]) => ({
  status: {
    options: names.map((n) => ({ id: "id-" + n, name: n })),
    groups: [
      { name: "To-do", option_ids: names.filter((n) => !complete.includes(n)).map((n) => "id-" + n) },
      { name: "Complete", option_ids: complete.map((n) => "id-" + n) },
    ],
  },
});

const sources: Record<string, any> = {
  [MISSIONS_DS]: {
    id: MISSIONS_DS,
    title: rt("Missions"),
    properties: {
      Mission: { type: "title", title: {} },
      Status: { type: "status", ...statusCfg(["Backlog", "In Progress", "Stuck", "Complete"], ["Complete"]) },
      "Due Date": { type: "date", date: {} },
      Team: { type: "select", select: { options: [{ name: "Team 1" }] } },
    },
  },
  [TEAM_DS]: {
    id: TEAM_DS,
    title: rt("Mission Team 1 Tasks"),
    properties: {
      Task: { type: "title", title: {} },
      Status: { type: "status", ...statusCfg(["Not Started", "In Progress", "Ready for Review", "Done", "Skip"], ["Done", "Skip"]) },
      Date: { type: "date", date: {} },
      "Main Branch Name": { type: "rich_text", rich_text: {} },
    },
  },
  [MEET_DS]: {
    id: MEET_DS,
    title: rt("Weekly Meetings"),
    properties: {
      Meeting: { type: "title", title: {} },
      Date: { type: "date", date: {} },
      Day: { type: "rich_text", rich_text: {} },
      Time: { type: "rich_text", rich_text: {} },
      Agenda: { type: "rich_text", rich_text: {} },
    },
  },
};
const dbToDs: Record<string, string> = { [MISSIONS_DB]: MISSIONS_DS, [TEAM_DB]: TEAM_DS, [MEET_DB]: MEET_DS };

const row = (title: string, titleProp: string, props: Record<string, any> = {}) => ({
  object: "page",
  id: "row-" + title,
  properties: { [titleProp]: { type: "title", title: rt(title) }, ...props },
});
const status = (name: string) => ({ type: "status", status: { name } });
const date = (start: string | null) => ({ type: "date", date: start ? { start } : null });
const select = (name: string | null) => ({ type: "select", select: name ? { name } : null });

let meetingRows: any[] = [];
let calls: { url: string; method: string; body: any }[] = [];

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input.url;
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(init.body) : undefined;
  calls.push({ url, method, body });
  const json = (data: any, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

  if (url.startsWith("https://discord.example/")) return new Response(null, { status: 204 });
  if (url.startsWith("https://api.telegram.org/")) return json({ ok: true });

  const path = new URL(url).pathname.replace(/^\/v1/, "");
  let m;
  if ((m = path.match(/^\/databases\/([^/]+)$/))) {
    const ds = dbToDs[m[1]];
    return ds ? json({ id: m[1], title: sources[ds].title, data_sources: [{ id: ds }] }) : json({ code: "object_not_found" }, 404);
  }
  if ((m = path.match(/^\/data_sources\/([^/]+)$/))) return json(sources[m[1]]);
  if ((m = path.match(/^\/data_sources\/([^/]+)\/query$/))) {
    if (m[1] === MISSIONS_DS) {
      return json({ results: [
        row("Fix intake", "Mission", { Status: status("Stuck"), "Due Date": date(null), Team: select("Team 1") }),
        row("Order bumpers", "Mission", { Status: status("In Progress"), "Due Date": date("2026-11-20"), Team: select("Team 1") }),
        row("Sponsor deck", "Mission", { Status: status("Backlog"), "Due Date": date("2026-11-23"), Team: select(null) }),
        row("Far future", "Mission", { Status: status("Backlog"), "Due Date": date("2026-12-30"), Team: select("Team 1") }),
      ], has_more: false });
    }
    if (m[1] === TEAM_DS) {
      if (body?.filter?.property === "Main Branch Name") {
        return json({ results: body.filter.rich_text.equals === "feature/intake" ? [{ id: TASK_ROW }] : [], has_more: false });
      }
      return json({ results: [row("Tune PID", "Task", { Status: status("In Progress"), Date: date("2026-11-22") })], has_more: false });
    }
    if (m[1] === MEET_DS) return json({ results: meetingRows, has_more: false });
  }
  if (path === "/pages" && method === "POST") return json({ id: "new-page", url: "https://notion.so/new-page" });
  if ((m = path.match(/^\/pages\/([^/]+)$/)) && method === "PATCH") return json({ id: m[1] });
  if (path === "/comments" && method === "POST") return json({ id: "c1" });
  return json({ code: "object_not_found", message: `no fake route ${method} ${path}` }, 404);
}) as typeof fetch;

const env = {
  NOTION_TOKEN: "ntn_test",
  TIMEZONE: "Asia/Jerusalem",
  MISSIONS_DB,
  TEAM_TASK_DBS: TEAM_DB,
  MEETINGS_DB: MEET_DB,
  MEETING_WEEKDAY: "2",
  MEETING_TIME: "18:00",
  MEETING_TITLE: "פגישה שבועית",
  DIGEST_DISCORD_WEBHOOK: "https://discord.example/webhook",
  GITHUB_WEBHOOK_SECRET: "gh-secret",
};

beforeEach(() => {
  calls = [];
  meetingRows = [];
});

// ------------------------------------------------------------ tests

test("dates are computed in the team's time zone", () => {
  assert.equal(localDate("Asia/Jerusalem", new Date("2026-11-21T23:30:00Z")), "2026-11-22");
  assert.equal(addDays("2026-11-30", 2), "2026-12-02");
});

test("digest groups overdue, due soon, stuck and unassigned work", async () => {
  meetingRows = [row("Weekly", "Meeting", { Date: date("2026-11-22"), Time: { type: "rich_text", rich_text: rt("18:00") } })];
  const text = await buildDigest(env, NOW);
  assert.match(text, /2026-11-22/);
  assert.match(text, /עבר הדדליין\*\n• Order bumpers \(2026-11-20\)/);
  assert.match(text, /דדליין עד מחרתיים\*\n• Sponsor deck \(2026-11-23\)\n• Tune PID \(Mission Team 1 · 2026-11-22\)/);
  assert.match(text, /תקועות\*\n• Fix intake/);
  assert.match(text, /בלי צוות\*\n• Sponsor deck/);
  assert.match(text, /פגישה היום\*\n• Weekly · 18:00/);
  assert.doesNotMatch(text, /Far future/);

  // Completed statuses are excluded in the query itself.
  const q = calls.find((c) => c.url.endsWith(`/data_sources/${TEAM_DS}/query`))!;
  assert.deepEqual(q.body.filter.and.map((f: any) => f.status.does_not_equal), ["Done", "Skip"]);
});

test("scheduled run posts to Discord with Discord-style bold", async () => {
  const result = await runScheduled({ ...env, MEETING_WEEKDAY: "" }, NOW);
  assert.deepEqual(result.digest, ["discord"]);
  const post = calls.find((c) => c.url.startsWith("https://discord.example/"))!;
  assert.match(post.body.content, /\*\*📋 עדכון יומי – Orion\*\*/);
  assert.deepEqual(post.body.allowed_mentions, { parse: [] });
});

test("next meeting page is created once, on the right weekday", async () => {
  const url = await ensureNextMeeting(env, NOW);
  assert.equal(url, "https://notion.so/new-page");
  const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/pages"))!;
  assert.deepEqual(create.body.properties.Date, { date: { start: "2026-11-24" } }); // the coming Tuesday
  assert.equal(create.body.properties.Day.rich_text[0].text.content, "שלישי");
  assert.equal(create.body.properties.Time.rich_text[0].text.content, "18:00");
  assert.deepEqual(create.body.template, { type: "default" });

  calls = [];
  meetingRows = [row("Existing", "Meeting")];
  assert.equal(await ensureNextMeeting(env, NOW), null);
  assert.ok(!calls.some((c) => c.method === "POST" && c.url.endsWith("/v1/pages")));

  assert.equal(await ensureNextMeeting({ ...env, MEETING_WEEKDAY: "" }, NOW), null);
});

test("pull request events map to task statuses", () => {
  assert.equal(statusForPullRequest("opened", false), "Ready for Review");
  assert.equal(statusForPullRequest("ready_for_review", false), "Ready for Review");
  assert.equal(statusForPullRequest("closed", true), "Done");
  assert.equal(statusForPullRequest("closed", false), null);
  assert.equal(statusForPullRequest("synchronize", false), null);
});

function githubRequest(payload: any, secret = "gh-secret", event = "pull_request") {
  const body = JSON.stringify(payload);
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  return new Request("https://srv.example/github/webhook", {
    method: "POST",
    headers: { "X-GitHub-Event": event, "X-Hub-Signature-256": sig, "Content-Type": "application/json" },
    body,
  });
}

test("GitHub webhook rejects bad signatures", async () => {
  const res = await handleGithubWebhook(githubRequest({}, "wrong-secret"), env);
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test("merged PR marks the matching task Done and links the PR", async () => {
  const res = await handleGithubWebhook(
    githubRequest({
      action: "closed",
      pull_request: { merged: true, number: 42, title: "Intake rollers", html_url: "https://github.com/x/y/pull/42", head: { ref: "feature/intake" } },
    }),
    env,
  );
  const out = await res.json();
  assert.deepEqual(out.updated, [TASK_ROW]);
  const patch = calls.find((c) => c.method === "PATCH")!;
  assert.deepEqual(patch.body, { properties: { Status: { status: { name: "Done" } } } });
  const comment = calls.find((c) => c.url.endsWith("/v1/comments"))!;
  assert.match(comment.body.markdown, /Merged.*#42 Intake rollers.*pull\/42/);
});

test("draft PRs and unrelated events are ignored", async () => {
  const draft = await handleGithubWebhook(githubRequest({ action: "opened", pull_request: { draft: true, head: { ref: "feature/intake" } } }), env);
  assert.equal(await draft.text(), "draft ignored");
  const push = await handleGithubWebhook(githubRequest({}, "gh-secret", "push"), env);
  assert.equal(await push.text(), "ignored");
  const ping = await handleGithubWebhook(githubRequest({}, "gh-secret", "ping"), env);
  assert.equal(await ping.text(), "pong");
  assert.ok(!calls.some((c) => c.method === "PATCH"));
});
