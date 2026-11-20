import type { Member } from "./auth.js";
import { Notion, NotionError, normalizeId } from "./notion.js";
import {
  buildProperties,
  describeSchema,
  plainText,
  readProperties,
  richText,
  simplifyPage,
  titleOf,
} from "./properties.js";

export interface Env {
  NOTION_TOKEN: string;
  TEAM_KEY?: string;
  ROOT_PAGE_ID?: string;
  LOG_DATA_SOURCE_ID?: string;
}

export interface ToolContext {
  notion: Notion;
  member: Member;
  env: Env;
  /** Runs work after the response is sent (Cloudflare's ctx.waitUntil). */
  background: (p: Promise<unknown>) => void;
  cache: Map<string, unknown>;
}

export interface Tool {
  name: string;
  title: string;
  description: string;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  inputSchema: Record<string, unknown>;
  run: (args: any, ctx: ToolContext) => Promise<unknown>;
}

// ------------------------------------------------------------------ helpers

export const str = (description: string) => ({ type: "string", description });
export const obj = (description: string) => ({ type: "object", description, additionalProperties: true });

export const isNotFoundish = (e: unknown) =>
  e instanceof NotionError && (e.status === 404 || e.status === 400) && e.code !== "rate_limited";

export async function cached<T>(ctx: ToolContext, key: string, load: () => Promise<T>): Promise<T> {
  if (ctx.cache.has(key)) return ctx.cache.get(key) as T;
  const value = await load();
  ctx.cache.set(key, value);
  return value;
}

export const getDataSource = (ctx: ToolContext, id: string) =>
  cached(ctx, "ds:" + id, () => ctx.notion.get(`/data_sources/${id}`));

export type Container =
  | { kind: "page"; id: string }
  | { kind: "data_source"; id: string; schema: Record<string, any>; database_id?: string };

/** Figures out whether an ID is a regular page, a database, or a data source. */
export async function resolveContainer(ctx: ToolContext, rawId: string): Promise<Container> {
  const id = normalizeId(rawId);
  try {
    const ds = await getDataSource(ctx, id);
    return { kind: "data_source", id: ds.id, schema: ds.properties, database_id: ds.parent?.database_id };
  } catch (e) {
    if (!isNotFoundish(e)) throw e;
  }
  try {
    const db = await ctx.notion.get(`/databases/${id}`);
    const first = db.data_sources?.[0];
    if (first) {
      const ds = await getDataSource(ctx, first.id);
      return { kind: "data_source", id: ds.id, schema: ds.properties, database_id: db.id };
    }
  } catch (e) {
    if (!isNotFoundish(e)) throw e;
  }
  return { kind: "page", id };
}

export async function resolveUser(ctx: ToolContext, query: string): Promise<string> {
  const users = await listAllUsers(ctx);
  const q = query.trim().toLowerCase();
  const exact = users.filter(
    (u: any) => u.name?.toLowerCase() === q || u.person?.email?.toLowerCase() === q,
  );
  if (exact.length === 1) return exact[0].id;
  const partial = users.filter(
    (u: any) => u.name?.toLowerCase().includes(q) || u.person?.email?.toLowerCase().includes(q),
  );
  if (partial.length === 1) return partial[0].id;
  if (partial.length > 1) {
    throw new Error(`"${query}" matches several people: ${partial.map((u: any) => u.name).join(", ")}`);
  }
  throw new Error(`no person named "${query}" in the workspace`);
}

export function listAllUsers(ctx: ToolContext): Promise<any[]> {
  return cached(ctx, "users", async () => {
    const all: any[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const res = await ctx.notion.get("/users", { page_size: 100, start_cursor: cursor });
      all.push(...res.results);
      if (!res.has_more) break;
      cursor = res.next_cursor;
    }
    return all;
  });
}

export const propCtx = (ctx: ToolContext) => ({ resolveUser: (q: string) => resolveUser(ctx, q), normalizeId });

export function logAction(ctx: ToolContext, action: string, target: string | undefined, details: string) {
  const ds = ctx.env.LOG_DATA_SOURCE_ID?.trim();
  if (!ds) return;
  ctx.background(
    ctx.notion
      .post("/pages", {
        parent: { type: "data_source_id", data_source_id: ds },
        properties: {
          Action: { title: richText(action) },
          Member: { rich_text: richText(ctx.member.name) },
          Page: { url: target || null },
          Details: { rich_text: richText(details.slice(0, 1900)) },
        },
        notifications: { mode: "silent" },
      })
      .catch(() => undefined), // logging must never break the real action
  );
}

export function iconFrom(icon: unknown) {
  if (!icon) return undefined;
  if (typeof icon === "object") return icon;
  const s = String(icon);
  if (/^https?:\/\//.test(s)) return { type: "external", external: { url: s } };
  return { type: "emoji", emoji: s };
}

export const compact = (x: unknown) => JSON.parse(JSON.stringify(x));

/** Shorthand schema: {"Status":"status","Tags":{"multi_select":["A","B"]}} -> Notion config. */
export function normalizeSchema(input: Record<string, unknown>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [name, spec] of Object.entries(input ?? {})) {
    if (spec === null) {
      out[name] = null;
    } else if (typeof spec === "string") {
      out[name] = { [spec]: {} };
    } else if (spec && typeof spec === "object") {
      const entries = Object.entries(spec as Record<string, any>);
      const fixed: Record<string, any> = {};
      for (const [k, v] of entries) {
        if ((k === "select" || k === "multi_select" || k === "status") && Array.isArray(v)) {
          fixed[k] = { options: v.map((o) => (typeof o === "string" ? { name: o } : o)) };
        } else {
          fixed[k] = v;
        }
      }
      out[name] = fixed;
    }
  }
  return out;
}

// ------------------------------------------------------------------ tools

export const BASE_TOOLS: Tool[] = [
  {
    name: "notion_whoami",
    title: "Who am I",
    description:
      "Shows the workspace name, the name this connection logs under, and the season's root page.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
    run: async (_args, ctx) => {
      const bot = await ctx.notion.get("/users/me");
      return {
        member: ctx.member.name,
        root_page_id: ctx.env.ROOT_PAGE_ID || null,
        workspace: bot?.bot?.workspace_name ?? null,
      };
    },
  },

  {
    name: "notion_search",
    title: "Search Notion",
    description:
      "Searches page and database titles the team's integration can see. Leave query empty to list recently edited items. Use type='data_source' to find databases.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: str("Text to look for in titles (optional)"),
        type: { type: "string", enum: ["page", "data_source"], description: "Limit to pages or databases" },
        page_size: { type: "integer", minimum: 1, maximum: 100, description: "Default 20" },
        start_cursor: str("next_cursor from a previous call"),
      },
    },
    run: async (args, ctx) => {
      const res = await ctx.notion.post("/search", compact({
        query: args.query || undefined,
        filter: args.type ? { property: "object", value: args.type } : undefined,
        sort: { direction: "descending", timestamp: "last_edited_time" },
        page_size: args.page_size ?? 20,
        start_cursor: args.start_cursor,
      }));
      return {
        results: res.results.map((r: any) => ({
          object: r.object,
          id: r.id,
          title: titleOf(r),
          url: r.url,
          parent: r.parent,
          last_edited_time: r.last_edited_time,
        })),
        next_cursor: res.has_more ? res.next_cursor : null,
      };
    },
  },

  {
    name: "notion_fetch",
    title: "Read a page or database",
    description:
      "Reads a page (properties + full content as Notion-flavored Markdown), a database (its data sources and their schemas), or a data source schema. Accepts an ID or any Notion URL.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        id: str("Page, database, data source or block ID, or a Notion URL"),
        include_transcript: { type: "boolean", description: "Include meeting-note transcripts" },
      },
      required: ["id"],
    },
    run: async (args, ctx) => {
      const id = normalizeId(args.id);

      // 1. Page
      try {
        const page = await ctx.notion.get(`/pages/${id}`);
        const md = await ctx.notion.get(`/pages/${id}/markdown`, {
          markdown_version: "v2",
          include_transcript: args.include_transcript ? true : undefined,
        });
        const meta: any = simplifyPage(page);
        if (page.parent?.type === "data_source_id") meta.data_source_id = page.parent.data_source_id;
        if (md.truncated) meta.truncated = true;
        if (md.unknown_block_ids?.length) meta.unknown_block_ids = md.unknown_block_ids;
        return `${JSON.stringify(meta, null, 1)}\n\n--- page content (Notion-flavored Markdown) ---\n${md.markdown}`;
      } catch (e) {
        if (!isNotFoundish(e)) throw e;
      }

      // 2. Database
      try {
        const db = await ctx.notion.get(`/databases/${id}`);
        const sources = await Promise.all(
          (db.data_sources ?? []).slice(0, 5).map(async (s: any) => {
            const ds = await getDataSource(ctx, s.id);
            return { data_source_id: ds.id, title: titleOf(ds), schema: describeSchema(ds.properties) };
          }),
        );
        return {
          object: "database",
          id: db.id,
          url: db.url,
          title: titleOf(db),
          description: plainText(db.description),
          parent: db.parent,
          is_inline: db.is_inline,
          data_sources: sources,
          hint: "Use notion_query_data_source with a data_source_id to read the rows.",
        };
      } catch (e) {
        if (!isNotFoundish(e)) throw e;
      }

      // 3. Data source
      try {
        const ds = await getDataSource(ctx, id);
        return {
          object: "data_source",
          id: ds.id,
          title: titleOf(ds),
          database_id: ds.parent?.database_id,
          schema: describeSchema(ds.properties),
        };
      } catch (e) {
        if (!isNotFoundish(e)) throw e;
      }

      // 4. A block inside a page
      const md = await ctx.notion.get(`/pages/${id}/markdown`, { markdown_version: "v2" });
      return `--- block content (Notion-flavored Markdown) ---\n${md.markdown}`;
    },
  },

  {
    name: "notion_query_data_source",
    title: "Query database rows",
    description:
      "Lists rows of a database, with optional Notion filter and sorts (raw Notion API format). Accepts a data source ID, a database ID, or a database URL. Returns simplified property values.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        id: str("Data source ID, database ID, or database URL"),
        filter: obj('Notion filter, e.g. {"property":"Status","status":{"equals":"In progress"}}'),
        sorts: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          description: 'e.g. [{"property":"Due","direction":"ascending"}]',
        },
        page_size: { type: "integer", minimum: 1, maximum: 100, description: "Default 50" },
        start_cursor: str("next_cursor from a previous call"),
      },
      required: ["id"],
    },
    run: async (args, ctx) => {
      const target = await resolveContainer(ctx, args.id);
      if (target.kind !== "data_source") throw new Error("that ID is a page, not a database");
      const res = await ctx.notion.post(`/data_sources/${target.id}/query`, compact({
        filter: args.filter,
        sorts: args.sorts,
        page_size: args.page_size ?? 50,
        start_cursor: args.start_cursor,
      }));
      return {
        data_source_id: target.id,
        rows: res.results.map((p: any) => ({
          id: p.id,
          url: p.url,
          title: titleOf(p),
          properties: readProperties(p.properties),
        })),
        next_cursor: res.has_more ? res.next_cursor : null,
      };
    },
  },

  {
    name: "notion_create_pages",
    title: "Create pages or database rows",
    description:
      "Creates up to 20 pages under a page, or rows in a database. Properties can be plain values " +
      '(e.g. {"Name":"Print motor mount","Status":"In progress","Due":"2026-11-26","Owner":"Itay"}); ' +
      "people can be given by name or email. Content is Notion-flavored Markdown.",
    annotations: {},
    inputSchema: {
      type: "object",
      properties: {
        parent_id: str("ID or URL of the parent page or database"),
        pages: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            properties: {
              title: str("Page title (shortcut for the title property)"),
              properties: obj("Property values by name"),
              markdown: str("Page content in Notion-flavored Markdown"),
              icon: str("An emoji or an image URL"),
              template: str("'default' to apply the database's default template, or a template ID"),
            },
          },
        },
      },
      required: ["parent_id", "pages"],
    },
    run: async (args, ctx) => {
      const parent = await resolveContainer(ctx, args.parent_id);
      const schema = parent.kind === "data_source" ? parent.schema : null;
      const results: any[] = [];
      for (const [i, spec] of (args.pages ?? []).slice(0, 20).entries()) {
        try {
          const input: Record<string, unknown> = { ...(spec.properties ?? {}) };
          if (spec.title !== undefined) input.title = spec.title;
          const properties = await buildProperties(input, schema, propCtx(ctx));
          const template =
            spec.template === "default"
              ? { type: "default" }
              : spec.template
                ? { type: "template_id", template_id: normalizeId(spec.template) }
                : undefined;
          const page = await ctx.notion.post("/pages", compact({
            parent:
              parent.kind === "data_source"
                ? { type: "data_source_id", data_source_id: parent.id }
                : { type: "page_id", page_id: parent.id },
            properties,
            icon: iconFrom(spec.icon),
            template,
            markdown: spec.markdown && !template ? spec.markdown : undefined,
            markdown_version: spec.markdown && !template ? "v2" : undefined,
          }));
          // A template can't be combined with markdown in one call, so add the content afterwards.
          if (spec.markdown && template) {
            await ctx.notion.patch(`/pages/${page.id}/markdown`, {
              markdown_version: "v2",
              type: "insert_content",
              insert_content: { content: spec.markdown, position: { type: "end" } },
            });
          }
          results.push({ ok: true, id: page.id, url: page.url, title: titleOf(page) });
          logAction(ctx, "create page", page.url, titleOf(page));
        } catch (e) {
          results.push({ ok: false, index: i, error: (e as Error).message });
        }
      }
      return { created: results.filter((r) => r.ok).length, results };
    },
  },

  {
    name: "notion_update_page",
    title: "Update a page",
    description:
      "Updates a page's properties, icon, cover, and/or content. Content modes: " +
      "'search_replace' (preferred: exact old text -> new text), 'append', 'prepend', or 'replace_all' (rewrites the whole page). " +
      "Read the page with notion_fetch first so old text matches exactly.",
    annotations: { idempotentHint: false },
    inputSchema: {
      type: "object",
      properties: {
        page_id: str("Page ID or URL"),
        properties: obj("Property values by name (plain values are fine)"),
        icon: str("An emoji or image URL; empty string removes it"),
        cover_url: str("Image URL for the cover; empty string removes it"),
        content: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["search_replace", "append", "prepend", "replace_all"] },
            edits: {
              type: "array",
              description: "For search_replace",
              items: {
                type: "object",
                properties: {
                  old_text: { type: "string" },
                  new_text: { type: "string" },
                  replace_all_matches: { type: "boolean" },
                },
                required: ["old_text", "new_text"],
              },
            },
            markdown: str("For append, prepend and replace_all"),
          },
          required: ["mode"],
        },
        allow_deleting_content: {
          type: "boolean",
          description: "Allow the edit to remove child pages or databases. Ask the user first.",
        },
      },
      required: ["page_id"],
    },
    run: async (args, ctx) => {
      const id = normalizeId(args.page_id);
      const allowDelete = Boolean(args.allow_deleting_content);
      const done: string[] = [];

      const patch: Record<string, unknown> = {};
      if (args.properties && Object.keys(args.properties).length) {
        const page = await ctx.notion.get(`/pages/${id}`);
        const dsId = page.parent?.type === "data_source_id" ? page.parent.data_source_id : null;
        const schema = dsId ? (await getDataSource(ctx, dsId)).properties : null;
        patch.properties = await buildProperties(args.properties, schema, propCtx(ctx));
      }
      if (args.icon !== undefined) patch.icon = args.icon === "" ? null : iconFrom(args.icon);
      if (args.cover_url !== undefined) {
        patch.cover = args.cover_url === "" ? null : { type: "external", external: { url: args.cover_url } };
      }
      let page: any = null;
      if (Object.keys(patch).length) {
        page = await ctx.notion.patch(`/pages/${id}`, patch);
        done.push("properties");
      }

      let warnings: unknown;
      if (args.content) {
        const c = args.content;
        let body: Record<string, unknown>;
        switch (c.mode) {
          case "search_replace":
            if (!c.edits?.length) throw new Error("search_replace needs at least one edit");
            body = {
              type: "update_content",
              update_content: {
                content_updates: c.edits.map((e: any) => ({
                  old_str: e.old_text,
                  new_str: e.new_text,
                  replace_all_matches: Boolean(e.replace_all_matches),
                })),
                allow_deleting_content: allowDelete,
              },
            };
            break;
          case "append":
          case "prepend":
            body = {
              type: "insert_content",
              insert_content: { content: c.markdown ?? "", position: { type: c.mode === "append" ? "end" : "start" } },
            };
            break;
          case "replace_all":
            body = {
              type: "replace_content",
              replace_content: { new_str: c.markdown ?? "", allow_deleting_content: allowDelete },
            };
            break;
          default:
            throw new Error(`unknown content mode "${c.mode}"`);
        }
        const res = await ctx.notion.patch(`/pages/${id}/markdown`, { markdown_version: "v2", ...body });
        warnings = res.warnings;
        done.push("content");
      }

      if (!done.length) throw new Error("nothing to update: pass properties, icon, cover_url or content");
      page ??= await ctx.notion.get(`/pages/${id}`);
      logAction(ctx, "update page", page.url, `${titleOf(page)} (${done.join(" + ")})`);
      return compact({ ok: true, updated: done, page: simplifyPage(page), warnings });
    },
  },

  {
    name: "notion_move_page",
    title: "Move a page",
    description: "Moves a page under another page, or into a database.",
    annotations: { idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        page_id: str("Page to move (ID or URL)"),
        new_parent_id: str("Destination page or database (ID or URL)"),
      },
      required: ["page_id", "new_parent_id"],
    },
    run: async (args, ctx) => {
      const id = normalizeId(args.page_id);
      const dest = await resolveContainer(ctx, args.new_parent_id);
      const page = await ctx.notion.post(`/pages/${id}/move`, {
        parent:
          dest.kind === "data_source"
            ? { type: "data_source_id", data_source_id: dest.id }
            : { type: "page_id", page_id: dest.id },
      });
      logAction(ctx, "move page", page.url, `${titleOf(page)} -> ${dest.id}`);
      return { ok: true, id: page.id, url: page.url, parent: page.parent };
    },
  },

  {
    name: "notion_trash_page",
    title: "Move a page to trash",
    description: "Moves a page or database row to Notion's trash. It can be restored with notion_restore_page.",
    annotations: { destructiveHint: true, idempotentHint: true },
    inputSchema: { type: "object", properties: { page_id: str("Page ID or URL") }, required: ["page_id"] },
    run: async (args, ctx) => {
      const page = await ctx.notion.patch(`/pages/${normalizeId(args.page_id)}`, { in_trash: true });
      logAction(ctx, "trash page", page.url, titleOf(page));
      return { ok: true, id: page.id, title: titleOf(page), in_trash: true };
    },
  },

  {
    name: "notion_restore_page",
    title: "Restore a page from trash",
    description: "Restores a page that was moved to trash.",
    annotations: { idempotentHint: true },
    inputSchema: { type: "object", properties: { page_id: str("Page ID or URL") }, required: ["page_id"] },
    run: async (args, ctx) => {
      const page = await ctx.notion.patch(`/pages/${normalizeId(args.page_id)}`, { in_trash: false });
      logAction(ctx, "restore page", page.url, titleOf(page));
      return { ok: true, id: page.id, url: page.url, title: titleOf(page) };
    },
  },

  {
    name: "notion_create_database",
    title: "Create a database",
    description:
      "Creates a new database inside a page. Schema shorthand: " +
      '{"Name":"title","Status":"status","Owner":"people","Due":"date","Priority":{"select":["High","Medium","Low"]}}. ' +
      "Raw Notion property configs also work.",
    annotations: {},
    inputSchema: {
      type: "object",
      properties: {
        parent_page_id: str("Page ID or URL that will contain the database"),
        title: str("Database title"),
        properties: obj("Column definitions; must include exactly one title column"),
        is_inline: { type: "boolean", description: "Show it inside the page instead of as a full page" },
        icon: str("An emoji or image URL"),
      },
      required: ["parent_page_id", "title", "properties"],
    },
    run: async (args, ctx) => {
      const db = await ctx.notion.post("/databases", compact({
        parent: { type: "page_id", page_id: normalizeId(args.parent_page_id) },
        title: richText(args.title),
        is_inline: Boolean(args.is_inline),
        icon: iconFrom(args.icon),
        initial_data_source: { properties: normalizeSchema(args.properties) },
      }));
      logAction(ctx, "create database", db.url, args.title);
      return {
        ok: true,
        database_id: db.id,
        url: db.url,
        data_sources: (db.data_sources ?? []).map((s: any) => ({ id: s.id, name: s.name })),
      };
    },
  },

  {
    name: "notion_update_data_source",
    title: "Change a database's columns",
    description:
      "Renames a database or adds/changes/renames/removes columns. " +
      'Add: {"Priority":{"select":["High","Low"]}}. Rename: {"Old name":{"name":"New name"}}. Remove (deletes that column\'s data from every row; ask the user first): {"Column":null}.',
    annotations: {},
    inputSchema: {
      type: "object",
      properties: {
        id: str("Data source ID, database ID, or database URL"),
        title: str("New database title"),
        properties: obj("Column changes"),
      },
      required: ["id"],
    },
    run: async (args, ctx) => {
      const target = await resolveContainer(ctx, args.id);
      if (target.kind !== "data_source") throw new Error("that ID is a page, not a database");
      const props = args.properties ? normalizeSchema(args.properties) : undefined;
      const ds = await ctx.notion.patch(`/data_sources/${target.id}`, compact({
        title: args.title ? richText(args.title) : undefined,
        properties: props,
      }));
      ctx.cache.delete("ds:" + target.id);
      logAction(ctx, "update database", undefined, `${titleOf(ds)}: ${JSON.stringify(args.properties ?? {})}`);
      return { ok: true, data_source_id: ds.id, title: titleOf(ds), schema: describeSchema(ds.properties) };
    },
  },

  {
    name: "notion_list_views",
    title: "List database views",
    description: "Lists the views (table, board, calendar, ...) of a database.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { id: str("Database ID or URL") }, required: ["id"] },
    run: async (args, ctx) => {
      const target = await resolveContainer(ctx, args.id);
      const query =
        target.kind === "data_source" && target.database_id
          ? { database_id: target.database_id }
          : { database_id: normalizeId(args.id) };
      const res = await ctx.notion.get("/views", { ...query, page_size: 100 });
      const views = await Promise.all(
        res.results.slice(0, 25).map(async (v: any) => {
          try {
            const full = await ctx.notion.get(`/views/${v.id}`);
            return { id: full.id, name: full.name, type: full.type, filter: full.filter, sorts: full.sorts };
          } catch {
            return { id: v.id };
          }
        }),
      );
      return { views };
    },
  },

  {
    name: "notion_create_view",
    title: "Create a database view",
    description:
      "Adds a view to a database. type: table, board, list, calendar, timeline, gallery, form, chart, map. " +
      "board needs configuration.group_by; calendar/timeline need configuration.date_property_id. Filters and sorts use Notion's API format.",
    annotations: {},
    inputSchema: {
      type: "object",
      properties: {
        database_id: str("Database ID or URL"),
        name: str("View name"),
        type: { type: "string", enum: ["table", "board", "list", "calendar", "timeline", "gallery", "form", "chart", "map"] },
        filter: obj("Notion filter"),
        sorts: { type: "array", items: { type: "object", additionalProperties: true } },
        configuration: obj("Type-specific settings; 'type' is filled in for you"),
      },
      required: ["database_id", "name", "type"],
    },
    run: async (args, ctx) => {
      const target = await resolveContainer(ctx, args.database_id);
      if (target.kind !== "data_source" || !target.database_id) throw new Error("that ID is not a database");
      const view = await ctx.notion.post("/views", compact({
        database_id: target.database_id,
        data_source_id: target.id,
        name: args.name,
        type: args.type,
        filter: args.filter,
        sorts: args.sorts,
        configuration: args.configuration ? { ...args.configuration, type: args.type } : undefined,
      }));
      logAction(ctx, "create view", undefined, `${args.name} (${args.type})`);
      return { ok: true, view_id: view.id, name: view.name, type: view.type };
    },
  },

  {
    name: "notion_update_view",
    title: "Update a database view",
    description: "Changes a view's name, filter, sorts or configuration.",
    annotations: { idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        view_id: str("View ID"),
        name: str("New name"),
        filter: obj("Notion filter (null clears it)"),
        sorts: { type: "array", items: { type: "object", additionalProperties: true } },
        configuration: obj("Type-specific settings"),
      },
      required: ["view_id"],
    },
    run: async (args, ctx) => {
      const { view_id, ...rest } = args;
      const view = await ctx.notion.patch(`/views/${normalizeId(view_id)}`, rest);
      logAction(ctx, "update view", undefined, view.name ?? view_id);
      return { ok: true, view_id: view.id, name: view.name };
    },
  },

  {
    name: "notion_delete_view",
    title: "Delete a database view",
    description: "Deletes a view (the data stays; only the view is removed).",
    annotations: { destructiveHint: true },
    inputSchema: { type: "object", properties: { view_id: str("View ID") }, required: ["view_id"] },
    run: async (args, ctx) => {
      await ctx.notion.delete(`/views/${normalizeId(args.view_id)}`);
      logAction(ctx, "delete view", undefined, args.view_id);
      return { ok: true };
    },
  },

  {
    name: "notion_get_comments",
    title: "Read comments",
    description: "Lists the comments on a page or block, grouped by discussion thread.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { id: str("Page or block ID or URL") }, required: ["id"] },
    run: async (args, ctx) => {
      const id = normalizeId(args.id);
      const all: any[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 5; i++) {
        const res = await ctx.notion.get("/comments", { block_id: id, page_size: 100, start_cursor: cursor });
        all.push(...res.results);
        if (!res.has_more) break;
        cursor = res.next_cursor;
      }
      const threads: Record<string, any[]> = {};
      for (const c of all) {
        (threads[c.discussion_id] ??= []).push({
          id: c.id,
          author: c.display_name?.resolved_name ?? c.created_by?.id,
          created_time: c.created_time,
          text: plainText(c.rich_text),
        });
      }
      return { discussions: Object.entries(threads).map(([discussion_id, comments]) => ({ discussion_id, comments })) };
    },
  },

  {
    name: "notion_create_comment",
    title: "Add a comment",
    description:
      "Comments on a page or block, or replies in an existing discussion. The comment shows the team member's name.",
    annotations: {},
    inputSchema: {
      type: "object",
      properties: {
        page_id: str("Comment on this page"),
        block_id: str("Or comment on this block"),
        discussion_id: str("Or reply in this discussion"),
        text: str("Comment text (bold, italic, links and mentions are supported)"),
      },
      required: ["text"],
    },
    run: async (args, ctx) => {
      const target = args.discussion_id
        ? { discussion_id: args.discussion_id }
        : args.block_id
          ? { parent: { block_id: normalizeId(args.block_id) } }
          : args.page_id
            ? { parent: { page_id: normalizeId(args.page_id) } }
            : null;
      if (!target) throw new Error("pass page_id, block_id or discussion_id");
      const c = await ctx.notion.post("/comments", {
        ...target,
        markdown: args.text,
        display_name: { type: "custom", custom: { name: `${ctx.member.name} (Claude)` } },
      });
      logAction(ctx, "comment", undefined, String(args.text).slice(0, 200));
      return { ok: true, comment_id: c.id, discussion_id: c.discussion_id };
    },
  },

  {
    name: "notion_get_users",
    title: "List people",
    description: "Lists people in the workspace (members and guests) with their IDs, optionally filtered by name or email.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { query: str("Part of a name or email") } },
    run: async (args, ctx) => {
      const q = String(args.query ?? "").toLowerCase();
      const users = (await listAllUsers(ctx))
        .filter((u: any) => u.type === "person")
        .filter((u: any) => !q || u.name?.toLowerCase().includes(q) || u.person?.email?.toLowerCase().includes(q))
        .map((u: any) => ({ id: u.id, name: u.name, email: u.person?.email }));
      return { users };
    },
  },

  {
    name: "notion_api_request",
    title: "Raw Notion API call",
    description:
      "Escape hatch for anything the other tools don't cover: calls any Notion API endpoint (version 2026-03-11) directly. " +
      "Example: method GET, path /blocks/{id}/children.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST", "PATCH", "DELETE"] },
        path: str("Path after /v1, e.g. /blocks/<id>/children"),
        body: obj("JSON body for POST/PATCH"),
        query: obj("Query-string parameters"),
      },
      required: ["method", "path"],
    },
    run: async (args, ctx) => {
      const path = String(args.path);
      if (!path.startsWith("/") || path.includes("://") || path.includes("..")) throw new Error("path must look like /pages/<id>");
      const res = await ctx.notion.request(args.method, path.replace(/^\/v1(?=\/)/, ""), args.body, args.query);
      if (args.method !== "GET") logAction(ctx, `api ${args.method}`, undefined, path);
      return res;
    },
  },
];

