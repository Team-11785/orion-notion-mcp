/**
 * Background jobs that replace what guests can't set up in Notion themselves:
 *   - a daily digest (stuck / due soon / unassigned tasks, today's meeting) sent to Discord or Telegram
 *   - creating the next weekly meeting page automatically
 *   - syncing GitHub pull requests to the team task databases
 *
 * Everything is driven by wrangler.toml vars, and each job is skipped if its settings are empty.
 * The Workers free plan allows 50 outgoing requests per run, so jobs stay well under that.
 */
import { Notion, normalizeId } from "./notion.js";
import { plainText, readProperty, titleOf } from "./properties.js";

export interface AutomationEnv {
  NOTION_TOKEN: string;
  TIMEZONE?: string;
  MISSIONS_DB?: string;
  TEAM_TASK_DBS?: string;
  MEETINGS_DB?: string;
  DIGEST_DISCORD_WEBHOOK?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  MEETING_WEEKDAY?: string;
  MEETING_TIME?: string;
  MEETING_TITLE?: string;
  GITHUB_WEBHOOK_SECRET?: string;
}

/** Text the team sees. Change it here if you want different wording. */
export const LABELS = {
  title: "📋 עדכון יומי – Orion",
  meetingToday: "🕝 פגישה היום",
  stuck: "🔴 תקועות",
  dueSoon: "⏰ דדליין עד מחרתיים",
  overdue: "⚠️ עבר הדדליין",
  unassigned: "🙋 משימות בלי צוות",
  nothing: "אין משהו דחוף היום 💪",
  more: (n: number) => `ועוד ${n}…`,
  weekdays: ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"],
};

const MAX_ITEMS = 6;

// ------------------------------------------------------------------ helpers

export function localDate(tz: string, date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const list = (raw: string | undefined) => (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);

interface Source {
  id: string;
  title: string;
  properties: Record<string, any>;
}

async function sourceOf(notion: Notion, databaseId: string): Promise<Source> {
  const db = await notion.get(`/databases/${normalizeId(databaseId)}`);
  const first = db.data_sources?.[0];
  if (!first) throw new Error(`database ${databaseId} has no data source`);
  const ds = await notion.get(`/data_sources/${first.id}`);
  return { id: ds.id, title: titleOf(db) || titleOf(ds), properties: ds.properties ?? {} };
}

const propOfType = (src: Source, type: string, preferred?: string[]) => {
  const entries = Object.entries<any>(src.properties).filter(([, p]) => p.type === type);
  return (entries.find(([n]) => preferred?.includes(n)) ?? entries[0])?.[0];
};

/** Status options in Notion's "Complete" group, so renamed options keep working. */
function doneOptions(src: Source, statusProp: string): string[] {
  const cfg = src.properties[statusProp]?.status;
  const group = cfg?.groups?.find((g: any) => /complete|done/i.test(g.name));
  const ids: string[] = group?.option_ids ?? [];
  const names = (cfg?.options ?? []).filter((o: any) => ids.includes(o.id)).map((o: any) => o.name);
  return names.length ? names : ["Done", "Complete", "Skip"];
}

async function queryAll(notion: Notion, dsId: string, body: Record<string, unknown>) {
  const res = await notion.post(`/data_sources/${dsId}/query`, { page_size: 100, ...body });
  return res.results as any[];
}

function line(page: any, extra = "") {
  return `• ${titleOf(page) || "ללא שם"}${extra ? ` (${extra})` : ""}`;
}

function section(title: string, items: string[]) {
  if (!items.length) return "";
  const shown = items.slice(0, MAX_ITEMS);
  const rest = items.length - shown.length;
  return [`*${title}*`, ...shown, ...(rest > 0 ? [LABELS.more(rest)] : [])].join("\n");
}

// ------------------------------------------------------------------ digest

export async function buildDigest(env: AutomationEnv, now = new Date()): Promise<string> {
  const notion = new Notion(env.NOTION_TOKEN);
  const tz = env.TIMEZONE || "Asia/Jerusalem";
  const today = localDate(tz, now);
  const soon = addDays(today, 2);

  const stuck: string[] = [];
  const dueSoon: string[] = [];
  const overdue: string[] = [];
  const unassigned: string[] = [];
  const meetings: string[] = [];

  const taskDbs = [...list(env.MISSIONS_DB).map((id) => ({ id, missions: true })), ...list(env.TEAM_TASK_DBS).map((id) => ({ id, missions: false }))];

  for (const { id, missions } of taskDbs) {
    let src: Source;
    try {
      src = await sourceOf(notion, id);
    } catch {
      continue; // not shared with the integration, or deleted
    }
    const statusProp = propOfType(src, "status", ["Status"]);
    const dateProp = propOfType(src, "date", ["Due Date", "Date", "Due"]);
    if (!statusProp) continue;
    const done = doneOptions(src, statusProp);
    const notDone = done.map((name) => ({ property: statusProp, status: { does_not_equal: name } }));
    const tag = missions ? "" : src.title.replace(/ Tasks$/, "");

    const open = await queryAll(notion, src.id, { filter: { and: notDone } });
    for (const page of open) {
      const status = readProperty(page.properties?.[statusProp]) as string | null;
      const due = dateProp ? (readProperty(page.properties?.[dateProp]) as any) : null;
      const dueDate = typeof due === "string" ? due.slice(0, 10) : due?.start?.slice(0, 10);

      if (status && /stuck|תקוע|blocked|on hold/i.test(status)) stuck.push(line(page, tag));
      if (dueDate && dueDate < today) overdue.push(line(page, [tag, dueDate].filter(Boolean).join(" · ")));
      else if (dueDate && dueDate <= soon) dueSoon.push(line(page, [tag, dueDate].filter(Boolean).join(" · ")));

      if (missions) {
        const teamProp = src.properties.Team ? "Team" : undefined;
        if (teamProp && !readProperty(page.properties?.[teamProp])) unassigned.push(line(page));
      }
    }
  }

  for (const id of list(env.MEETINGS_DB)) {
    try {
      const src = await sourceOf(notion, id);
      const dateProp = propOfType(src, "date", ["Date"]);
      if (!dateProp) continue;
      const rows = await queryAll(notion, src.id, { filter: { property: dateProp, date: { equals: today } } });
      for (const m of rows) {
        const time = plainText(m.properties?.Time?.rich_text);
        const agenda = plainText(m.properties?.Agenda?.rich_text);
        meetings.push(`• ${titleOf(m)}${time ? ` · ${time}` : ""}${agenda ? `\n  ${agenda.slice(0, 200)}` : ""}`);
      }
    } catch {
      /* skip */
    }
  }

  const body = [
    section(LABELS.meetingToday, meetings),
    section(LABELS.overdue, overdue),
    section(LABELS.dueSoon, dueSoon),
    section(LABELS.stuck, stuck),
    section(LABELS.unassigned, unassigned),
  ].filter(Boolean);

  return [`*${LABELS.title}* · ${today}`, "", body.length ? body.join("\n\n") : LABELS.nothing].join("\n");
}

export async function sendDigest(env: AutomationEnv, text: string): Promise<string[]> {
  const sent: string[] = [];
  if (env.DIGEST_DISCORD_WEBHOOK) {
    // Discord uses **bold**, and messages are capped at 2000 characters.
    const content = text.replace(/\*([^*\n]+)\*/g, "**$1**").slice(0, 1990);
    const res = await fetch(env.DIGEST_DISCORD_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    });
    if (res.ok) sent.push("discord");
  }
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: text.replace(/\*/g, ""), disable_web_page_preview: true }),
    });
    if (res.ok) sent.push("telegram");
  }
  return sent;
}

// ------------------------------------------------------------------ weekly meeting page

/**
 * Makes sure the next meeting (within the coming 7 days) has a page in Weekly Meetings.
 * Runs daily and is idempotent: it does nothing if a page for that date already exists.
 */
export async function ensureNextMeeting(env: AutomationEnv, now = new Date()): Promise<string | null> {
  const weekday = Number(env.MEETING_WEEKDAY);
  const meetingsDb = list(env.MEETINGS_DB)[0];
  if (!meetingsDb || env.MEETING_WEEKDAY === undefined || env.MEETING_WEEKDAY === "" || !(weekday >= 0 && weekday <= 6)) return null;

  const notion = new Notion(env.NOTION_TOKEN);
  const tz = env.TIMEZONE || "Asia/Jerusalem";
  const today = localDate(tz, now);
  const todayDow = new Date(today + "T12:00:00Z").getUTCDay();
  const date = addDays(today, (weekday - todayDow + 7) % 7);

  const src = await sourceOf(notion, meetingsDb);
  const dateProp = propOfType(src, "date", ["Date"]);
  const titleProp = propOfType(src, "title");
  if (!dateProp || !titleProp) return null;

  const existing = await queryAll(notion, src.id, { filter: { property: dateProp, date: { equals: date } } });
  if (existing.length) return null;

  const properties: Record<string, any> = {
    [titleProp]: { title: [{ type: "text", text: { content: env.MEETING_TITLE || "Weekly meeting" } }] },
    [dateProp]: { date: { start: date } },
  };
  if (src.properties.Day?.type === "rich_text") properties.Day = { rich_text: [{ type: "text", text: { content: LABELS.weekdays[weekday] } }] };
  if (env.MEETING_TIME && src.properties.Time?.type === "rich_text") {
    properties.Time = { rich_text: [{ type: "text", text: { content: env.MEETING_TIME } }] };
  }

  const page = await notion.post("/pages", {
    parent: { type: "data_source_id", data_source_id: src.id },
    properties,
    template: { type: "default" },
    notifications: { mode: "silent" },
  });
  return page.url ?? page.id;
}

export async function runScheduled(env: AutomationEnv, now = new Date()) {
  const result: Record<string, unknown> = {};
  try {
    result.meeting = await ensureNextMeeting(env, now);
  } catch (e) {
    result.meetingError = (e as Error).message;
  }
  if (env.DIGEST_DISCORD_WEBHOOK || (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID)) {
    const text = await buildDigest(env, now);
    result.digest = await sendDigest(env, text);
  }
  return result;
}

// ------------------------------------------------------------------ GitHub → Notion

async function verifySignature(secret: string, body: string, header: string | null): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const expected = "sha256=" + [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

/** Status to set for a pull request event, or null to ignore the event. */
export function statusForPullRequest(action: string, merged: boolean): string | null {
  if (action === "closed") return merged ? "Done" : null;
  if (["opened", "reopened", "ready_for_review"].includes(action)) return "Ready for Review";
  return null;
}

export async function handleGithubWebhook(request: Request, env: AutomationEnv): Promise<Response> {
  if (!env.GITHUB_WEBHOOK_SECRET) return new Response("GitHub sync is not configured", { status: 404 });
  const body = await request.text();
  if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, body, request.headers.get("X-Hub-Signature-256")))) {
    return new Response("bad signature", { status: 401 });
  }
  const event = request.headers.get("X-GitHub-Event");
  if (event === "ping") return new Response("pong");
  if (event !== "pull_request") return new Response("ignored");

  const payload = JSON.parse(body);
  const pr = payload.pull_request;
  if (pr?.draft && payload.action !== "closed") return new Response("draft ignored");
  const status = statusForPullRequest(payload.action, Boolean(pr?.merged));
  const branch: string | undefined = pr?.head?.ref;
  if (!status || !branch) return new Response("ignored");

  const notion = new Notion(env.NOTION_TOKEN);
  const updated: string[] = [];
  for (const id of list(env.TEAM_TASK_DBS)) {
    let src: Source;
    try {
      src = await sourceOf(notion, id);
    } catch {
      continue;
    }
    const branchProp = Object.keys(src.properties).find((n) => /branch/i.test(n) && src.properties[n].type === "rich_text");
    const statusProp = propOfType(src, "status", ["Status"]);
    if (!branchProp || !statusProp) continue;
    const hasOption = (src.properties[statusProp].status?.options ?? []).some((o: any) => o.name === status);
    if (!hasOption) continue;

    const rows = await queryAll(notion, src.id, { filter: { property: branchProp, rich_text: { equals: branch } } });
    for (const row of rows) {
      await notion.patch(`/pages/${row.id}`, { properties: { [statusProp]: { status: { name: status } } } });
      await notion.post("/comments", {
        parent: { page_id: row.id },
        markdown: `${status === "Done" ? "✅ Merged" : "🔀 Pull request"}: [#${pr.number} ${pr.title}](${pr.html_url})`,
        display_name: { type: "custom", custom: { name: "GitHub" } },
      });
      updated.push(row.id);
    }
  }
  return new Response(JSON.stringify({ status, branch, updated }), { headers: { "Content-Type": "application/json" } });
}
