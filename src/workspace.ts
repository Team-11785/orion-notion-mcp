import type { Notion } from "./notion.js";
import { describeSchema, titleOf } from "./properties.js";

/**
 * Team conventions that can't be read from Notion itself. This is the only part
 * of the map written by hand; everything else is read live from the workspace.
 */
export const CONVENTIONS = `
Conventions:
- Use the exact option names listed below; they are case-sensitive and some are misspelled on purpose (e.g. "Cmplete").
- New team-wide work goes to Missions; work a specific mission team owns goes to that team's Tasks database.
- In Missions, an empty Team means unassigned; team leads set it to take a task.
- Meeting summaries go in the body of the meeting's page in Weekly Meetings.
- Claude Log is written automatically by this server. Don't edit it.
`.trim();

const CACHE_MS = 10 * 60 * 1000;
let cache: { at: number; rootId: string; text: string } | null = null;

const shortId = (id: string) => id.replace(/-/g, "");

/** Pulls <page url="...">Title</page> and <database ...>Title</database> tags out of page markdown. */
function childrenOf(markdown: string) {
  const out: { kind: "page" | "database"; url: string; title: string }[] = [];
  const re = /<(page|database)\s+[^>]*url="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) out.push({ kind: m[1] as "page" | "database", url: m[2], title: m[3].trim() || "Untitled" });
  return out;
}

function idFromUrl(url: string): string | null {
  return url.replace(/-/g, "").match(/[0-9a-f]{32}(?![0-9a-f])/i)?.[0] ?? null;
}

function formatSchema(properties: Record<string, any>): string {
  const schema = describeSchema(properties) as Record<string, any>;
  return Object.entries(schema)
    .map(([name, p]) => {
      const label = name === "" ? '"" (unnamed)' : name;
      const opts = p.options?.length ? `: ${p.options.join(" | ")}` : "";
      return `${label} (${p.type}${opts})`;
    })
    .join(" · ");
}

async function walkPages(notion: Notion, rootId: string): Promise<string[]> {
  const lines: string[] = [];
  const seen = new Set<string>();
  const visit = async (id: string, title: string, depth: number) => {
    if (seen.has(id) || depth > 2) return;
    seen.add(id);
    let md: string;
    try {
      md = (await notion.get(`/pages/${id}/markdown`, { markdown_version: "v2" })).markdown ?? "";
    } catch {
      return;
    }
    const kids = childrenOf(md);
    const pages = kids.filter((k) => k.kind === "page");
    const dbs = kids.filter((k) => k.kind === "database");
    const indent = "  ".repeat(depth);
    lines.push(`${indent}- ${title} (page ${id})`);
    for (const d of dbs) lines.push(`${indent}  - 🗂️ ${d.title} (database ${idFromUrl(d.url) ?? d.url})`);
    for (const p of pages.slice(0, 15)) {
      const childId = idFromUrl(p.url);
      if (!childId) continue;
      if (depth >= 1) lines.push(`${indent}  - ${p.title} (page ${childId})`);
      else await visit(childId, p.title, depth + 1);
    }
  };
  await visit(shortId(rootId), "Season root", 0);
  return lines;
}

async function listDataSources(notion: Notion): Promise<string[]> {
  const lines: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 3; i++) {
    const res = await notion.post("/search", {
      filter: { property: "object", value: "data_source" },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    for (const ds of res.results) {
      if (ds.in_trash || ds.archived) continue;
      let props = ds.properties;
      if (!props) {
        try {
          props = (await notion.get(`/data_sources/${ds.id}`)).properties;
        } catch {
          continue;
        }
      }
      const dbId = ds.parent?.database_id ? shortId(ds.parent.database_id) : "?";
      lines.push(`- ${titleOf(ds) || "Untitled"} (database ${dbId}, data source ${ds.id})\n    ${formatSchema(props ?? {})}`);
    }
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  return lines.sort((a, b) => a.localeCompare(b));
}

/**
 * Builds the workspace map from the live workspace, so new or renamed databases,
 * columns and options show up without editing any code. Cached for 10 minutes.
 */
export async function getWorkspaceMap(notion: Notion, rootId: string | undefined, opts: { refresh?: boolean } = {}) {
  const root = rootId?.trim() ?? "";
  if (!opts.refresh && cache && cache.rootId === root && Date.now() - cache.at < CACHE_MS) return cache.text;

  const [pages, sources] = await Promise.all([
    root ? walkPages(notion, root).catch(() => [] as string[]) : Promise.resolve([] as string[]),
    listDataSources(notion).catch(() => [] as string[]),
  ]);

  const text = [
    "# Orion FRC Notion: workspace map (read live from Notion)",
    `Generated ${new Date().toISOString()}.`,
    "",
    "## Page structure",
    pages.length ? pages.join("\n") : "(couldn't read the page tree; use notion_fetch on the root page)",
    "",
    "## Databases and their columns",
    sources.length ? sources.join("\n") : "(no databases shared with the integration)",
    "",
    CONVENTIONS,
  ].join("\n");

  cache = { at: Date.now(), rootId: root, text };
  return text;
}

/** For tests. */
export function clearWorkspaceMapCache() {
  cache = null;
}
