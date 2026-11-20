import { normalizeId } from "./notion.js";
import { plainText, readProperty, simplifyPage, titleOf } from "./properties.js";
import {
  compact,
  getDataSource,
  logAction,
  obj,
  resolveContainer,
  str,
  type Tool,
  type ToolContext,
} from "./tools.js";
import { WORKSPACE_MAP } from "./workspace.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const READ_ONLY_TYPES = new Set([
  "formula", "rollup", "created_time", "created_by", "last_edited_time", "last_edited_by",
  "unique_id", "button", "verification",
]);

/**
 * Child pages and databases appear in Notion-flavored Markdown as <page url=...> / <database url=...>.
 * Writing those tags into a new page would MOVE the originals, so a copy turns them into plain links.
 */
export function detachChildren(markdown: string): { markdown: string; detached: number } {
  let detached = 0;
  const out = markdown.replace(
    /<(page|database)\s+[^>]*url="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g,
    (_m, kind: string, url: string, title: string) => {
      detached++;
      const label = title.trim() || (kind === "page" ? "Untitled page" : "Untitled database");
      return `[${kind === "page" ? "📄" : "🗂️"} ${label}](${url})`;
    },
  );
  return { markdown: out, detached };
}

/** Copies the writable properties of a page in the raw format Notion accepts back. */
function writableProperties(props: Record<string, any>, keepOnly?: Set<string>) {
  const out: Record<string, any> = {};
  for (const [name, p] of Object.entries(props ?? {})) {
    if (!p || READ_ONLY_TYPES.has(p.type)) continue;
    if (keepOnly && !keepOnly.has(name)) continue;
    const v = p[p.type];
    switch (p.type) {
      case "title":
      case "rich_text":
        out[name] = { [p.type]: (v ?? []).map((t: any) => ({ type: "text", text: { content: t.plain_text ?? "" }, annotations: t.annotations })) };
        break;
      case "select":
      case "status":
        out[name] = { [p.type]: v ? { name: v.name } : null };
        break;
      case "multi_select":
        out[name] = { multi_select: (v ?? []).map((o: any) => ({ name: o.name })) };
        break;
      case "people":
        out[name] = { people: (v ?? []).map((u: any) => ({ id: u.id })) };
        break;
      case "relation":
        out[name] = { relation: (v ?? []).map((r: any) => ({ id: r.id })) };
        break;
      case "files":
        // Notion-hosted file links expire, so only external files can be copied.
        out[name] = { files: (v ?? []).filter((f: any) => f.type === "external").map((f: any) => ({ name: f.name, type: "external", external: f.external })) };
        break;
      default:
        out[name] = { [p.type]: v ?? null };
    }
  }
  return out;
}

function blockTypeFor(contentType: string | undefined, filename: string): string {
  const ct = (contentType ?? "").toLowerCase();
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ct.startsWith("image/") || ["png", "jpg", "jpeg", "gif", "webp", "svg", "heic"].includes(ext)) return "image";
  if (ct.startsWith("video/") || ["mp4", "mov", "webm"].includes(ext)) return "video";
  if (ct.startsWith("audio/") || ["mp3", "wav", "m4a", "ogg"].includes(ext)) return "audio";
  if (ct === "application/pdf" || ext === "pdf") return "pdf";
  return "file";
}

function simplifyBlock(b: any) {
  const v = b[b.type] ?? {};
  return compact({
    id: b.id,
    type: b.type,
    has_children: b.has_children || undefined,
    text: v.rich_text ? plainText(v.rich_text) : undefined,
    checked: b.type === "to_do" ? v.checked : undefined,
    title: v.title,
    url: v.url ?? v.external?.url ?? v.file?.url,
    language: v.language,
  });
}

export const EXTRA_TOOLS: Tool[] = [
  {
    name: "notion_workspace_guide",
    title: "Orion workspace map",
    description:
      "Returns a map of the Orion workspace: where each database lives, its columns and the exact option names. Read this before adding or filtering tasks, meetings, ideas or team members.",
    role: "viewer",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
    run: async () => WORKSPACE_MAP,
  },

  {
    name: "notion_duplicate_page",
    title: "Duplicate a page",
    description:
      "Copies a page or database row (properties, icon, cover and content) to the same place or a new parent. " +
      "Sub-pages and databases inside it are not copied; they become links to the originals.",
    role: "editor",
    annotations: {},
    inputSchema: {
      type: "object",
      properties: {
        page_id: str("Page to copy (ID or URL)"),
        new_parent_id: str("Where to put the copy (page or database). Default: same parent"),
        title: str('Title for the copy. Default: "<original> (copy)"'),
      },
      required: ["page_id"],
    },
    run: async (args, ctx) => {
      const id = normalizeId(args.page_id);
      const [page, md] = await Promise.all([
        ctx.notion.get(`/pages/${id}`),
        ctx.notion.get(`/pages/${id}/markdown`, { markdown_version: "v2" }),
      ]);

      let parent: any;
      let keepOnly: Set<string> | undefined;
      if (args.new_parent_id) {
        const dest = await resolveContainer(ctx, args.new_parent_id);
        parent = dest.kind === "data_source"
          ? { type: "data_source_id", data_source_id: dest.id }
          : { type: "page_id", page_id: dest.id };
        // Only carry over columns the destination also has.
        keepOnly = new Set(dest.kind === "data_source" ? Object.keys(dest.schema) : []);
      } else if (page.parent?.type === "data_source_id") {
        parent = { type: "data_source_id", data_source_id: page.parent.data_source_id };
      } else if (page.parent?.type === "page_id") {
        parent = { type: "page_id", page_id: page.parent.page_id };
      } else {
        throw new Error("this page sits at the top of the workspace; pass new_parent_id");
      }

      const toPage = parent.type === "page_id";
      const properties = toPage ? {} : writableProperties(page.properties, keepOnly);
      const titleProp = Object.entries<any>(page.properties ?? {}).find(([, p]) => p.type === "title");
      const newTitle = args.title ?? `${titleOf(page)} (copy)`;
      if (toPage) {
        properties.title = { title: [{ type: "text", text: { content: newTitle } }] };
      } else {
        const destTitle = keepOnly
          ? Object.entries<any>((await getDataSource(ctx, parent.data_source_id)).properties).find(([, p]) => p.type === "title")?.[0]
          : titleProp?.[0];
        if (destTitle) properties[destTitle] = { title: [{ type: "text", text: { content: newTitle } }] };
        if (titleProp && destTitle !== titleProp[0]) delete properties[titleProp[0]];
      }

      const { markdown, detached } = detachChildren(md.markdown ?? "");
      const copy = await ctx.notion.post("/pages", compact({
        parent,
        properties,
        icon: page.icon ?? undefined,
        cover: page.cover?.type === "external" ? page.cover : undefined,
        markdown: markdown || undefined,
        markdown_version: markdown ? "v2" : undefined,
      }));
      logAction(ctx, "duplicate page", copy.url, `${titleOf(page)} -> ${newTitle}`);
      return compact({
        ok: true,
        id: copy.id,
        url: copy.url,
        title: newTitle,
        note: detached ? `${detached} sub-page(s)/database(s) were linked, not copied.` : undefined,
        truncated_original: md.truncated || undefined,
      });
    },
  },

  {
    name: "notion_upload_file_from_url",
    title: "Add a file or image from a URL",
    description:
      "Imports a file from a public URL into Notion and attaches it: as a block at the end of a page (image/PDF/video/file), " +
      "as the page icon or cover, or into a Files property.",
    role: "editor",
    annotations: {},
    inputSchema: {
      type: "object",
      properties: {
        url: str("Public https URL of the file"),
        filename: str("File name with extension, e.g. robot.png"),
        page_id: str("Page to attach it to"),
        attach_as: { type: "string", enum: ["block", "icon", "cover", "property"], description: "Default: block" },
        property_name: str("Files property name when attach_as is 'property'"),
        caption: str("Caption for the block"),
      },
      required: ["url", "filename", "page_id"],
    },
    run: async (args, ctx) => {
      if (!/^https:\/\//i.test(args.url)) throw new Error("url must be a public https:// link");
      const pageId = normalizeId(args.page_id);
      let upload = await ctx.notion.post("/file_uploads", {
        mode: "external_url",
        external_url: args.url,
        filename: args.filename,
      });
      for (let i = 0; i < 10 && upload.status === "pending"; i++) {
        await sleep(1000);
        upload = await ctx.notion.get(`/file_uploads/${upload.id}`);
      }
      if (upload.status !== "uploaded") {
        const err = upload.file_import_result?.error?.message ?? upload.status;
        throw new Error(`Notion couldn't import the file: ${err}`);
      }
      const ref = { type: "file_upload", file_upload: { id: upload.id } };
      const mode = args.attach_as ?? "block";

      if (mode === "icon" || mode === "cover") {
        await ctx.notion.patch(`/pages/${pageId}`, { [mode]: ref });
      } else if (mode === "property") {
        if (!args.property_name) throw new Error("property_name is required when attach_as is 'property'");
        await ctx.notion.patch(`/pages/${pageId}`, {
          properties: { [args.property_name]: { files: [{ name: args.filename, ...ref }] } },
        });
      } else {
        const type = blockTypeFor(upload.content_type, args.filename);
        await ctx.notion.patch(`/blocks/${pageId}/children`, {
          children: [{
            type,
            [type]: { ...ref, caption: args.caption ? [{ type: "text", text: { content: args.caption } }] : [] },
          }],
        });
      }
      logAction(ctx, "upload file", undefined, `${args.filename} -> ${pageId} (${mode})`);
      return { ok: true, file_upload_id: upload.id, attached_as: mode };
    },
  },

  {
    name: "notion_get_block_children",
    title: "List blocks in a page",
    description:
      "Lists the blocks inside a page or block with their IDs, for precise edits with notion_update_block or comments on a specific block.",
    role: "viewer",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { id: str("Page or block ID or URL"), start_cursor: str("next_cursor from a previous call") },
      required: ["id"],
    },
    run: async (args, ctx) => {
      const res = await ctx.notion.get(`/blocks/${normalizeId(args.id)}/children`, { page_size: 100, start_cursor: args.start_cursor });
      return { blocks: res.results.map(simplifyBlock), next_cursor: res.has_more ? res.next_cursor : null };
    },
  },

  {
    name: "notion_update_block",
    title: "Update or check off a block",
    description:
      'Edits a single block in Notion\'s raw block format, e.g. tick a to-do: {"to_do":{"checked":true}}, or change text: ' +
      '{"paragraph":{"rich_text":[{"text":{"content":"new text"}}]}}.',
    role: "editor",
    annotations: { idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: { block_id: str("Block ID"), block: obj("Raw Notion block fields to change") },
      required: ["block_id", "block"],
    },
    run: async (args, ctx) => {
      const b = await ctx.notion.patch(`/blocks/${normalizeId(args.block_id)}`, args.block);
      logAction(ctx, "update block", undefined, `${b.type} ${b.id}`);
      return { ok: true, block: simplifyBlock(b) };
    },
  },

  {
    name: "notion_delete_block",
    title: "Delete a block",
    description: "Deletes a single block (moves it to trash).",
    role: "admin",
    annotations: { destructiveHint: true },
    inputSchema: { type: "object", properties: { block_id: str("Block ID") }, required: ["block_id"] },
    run: async (args, ctx) => {
      await ctx.notion.delete(`/blocks/${normalizeId(args.block_id)}`);
      logAction(ctx, "delete block", undefined, args.block_id);
      return { ok: true };
    },
  },

  {
    name: "notion_get_page_property",
    title: "Read a long property",
    description:
      "Reads every value of one property of a page. Use it when a relation or people property has more than 25 entries (notion_fetch shows has_more).",
    role: "viewer",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { page_id: str("Page ID or URL"), property: str("Property name") },
      required: ["page_id", "property"],
    },
    run: async (args, ctx) => {
      const id = normalizeId(args.page_id);
      const page = await ctx.notion.get(`/pages/${id}`);
      const entry = Object.entries<any>(page.properties ?? {}).find(
        ([name]) => name.toLowerCase() === String(args.property).toLowerCase(),
      );
      if (!entry) throw new Error(`no property named "${args.property}"`);
      const propId = entry[1].id;
      const values: unknown[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 20; i++) {
        const res = await ctx.notion.get(`/pages/${id}/properties/${encodeURIComponent(propId)}`, { page_size: 100, start_cursor: cursor });
        if (res.object !== "list") return { property: entry[0], value: readProperty(res) };
        for (const item of res.results) {
          values.push(item.type === "relation" ? item.relation?.id : readProperty(item));
        }
        if (!res.has_more) break;
        cursor = res.next_cursor;
      }
      return { property: entry[0], values };
    },
  },

  {
    name: "notion_list_templates",
    title: "List database templates",
    description: "Lists the page templates of a database, for use with notion_create_pages (template).",
    role: "viewer",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: { id: str("Database or data source ID or URL") }, required: ["id"] },
    run: async (args, ctx) => {
      const target = await resolveContainer(ctx, args.id);
      if (target.kind !== "data_source") throw new Error("that ID is a page, not a database");
      const res = await ctx.notion.get(`/data_sources/${target.id}/templates`, { page_size: 100 });
      return { templates: res.templates ?? [] };
    },
  },

  {
    name: "notion_query_meeting_notes",
    title: "Find AI meeting notes",
    description:
      "Lists Notion AI meeting-note blocks (newest first). Read one with notion_fetch on its ID (include_transcript for the transcript). " +
      "Only works if the workspace uses Notion AI meeting notes.",
    role: "viewer",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        filter: obj("Optional Notion meeting-notes filter"),
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 20" },
      },
    },
    run: async (args, ctx) => {
      const res = await ctx.notion.post("/blocks/meeting_notes/query", compact({
        filter: args.filter,
        sort: [{ property: "created_time", direction: "descending" }],
        limit: args.limit ?? 20,
      }));
      return {
        meeting_notes: res.results.map((b: any) => compact({
          id: b.id,
          title: plainText(b.meeting_notes?.title),
          status: b.meeting_notes?.status,
          created_time: b.created_time,
          start_time: b.meeting_notes?.calendar_event?.start_time ?? b.meeting_notes?.recording?.start_time,
        })),
        has_more: res.has_more,
      };
    },
  },

  {
    name: "notion_update_comment",
    title: "Edit a comment",
    description: "Edits a comment that was written through this server (Notion only allows editing the integration's own comments).",
    role: "editor",
    annotations: { idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: { comment_id: str("Comment ID"), text: str("New text") },
      required: ["comment_id", "text"],
    },
    run: async (args, ctx) => {
      await ctx.notion.patch(`/comments/${normalizeId(args.comment_id)}`, { markdown: args.text });
      logAction(ctx, "edit comment", undefined, String(args.text).slice(0, 200));
      return { ok: true };
    },
  },

  {
    name: "notion_delete_comment",
    title: "Delete a comment",
    description: "Deletes a comment that was written through this server.",
    role: "editor",
    annotations: { destructiveHint: true },
    inputSchema: { type: "object", properties: { comment_id: str("Comment ID") }, required: ["comment_id"] },
    run: async (args, ctx) => {
      await ctx.notion.delete(`/comments/${normalizeId(args.comment_id)}`);
      logAction(ctx, "delete comment", undefined, args.comment_id);
      return { ok: true };
    },
  },

  {
    name: "notion_get_recent_changes",
    title: "What changed recently",
    description:
      "Lists pages and database rows edited recently across the workspace, newest first. Good for 'what happened this week?'.",
    role: "viewer",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        since: str("ISO date, e.g. 2026-11-15. Default: 7 days ago"),
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 30" },
      },
    },
    run: async (args, ctx) => {
      const since = args.since ? new Date(args.since) : new Date(Date.now() - 7 * 864e5);
      if (Number.isNaN(since.getTime())) throw new Error(`"${args.since}" is not a date`);
      const limit = args.limit ?? 30;
      const out: any[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 5 && out.length < limit; i++) {
        const res = await ctx.notion.post("/search", compact({
          filter: { property: "object", value: "page" },
          sort: { direction: "descending", timestamp: "last_edited_time" },
          page_size: 100,
          start_cursor: cursor,
        }));
        let reachedOld = false;
        for (const p of res.results) {
          if (new Date(p.last_edited_time) < since) { reachedOld = true; break; }
          const s = simplifyPage(p);
          out.push({ id: s.id, title: s.title, url: s.url, last_edited_time: s.last_edited_time, last_edited_by: p.last_edited_by?.id, parent: s.parent });
          if (out.length >= limit) break;
        }
        if (reachedOld || !res.has_more) break;
        cursor = res.next_cursor;
      }
      return { since: since.toISOString(), changes: out };
    },
  },
];

