#!/usr/bin/env node
// Exports everything the Notion connection can see into a folder:
//   pages/<title>-<id>.md       every page and database row, as Markdown with its properties on top
//   databases/<title>-<id>.json every database schema
//   index.md                    a table of contents
//
//   NOTION_TOKEN=ntn_... node scripts/backup.mjs <output-folder>
//
// Used by .github/workflows/backup.yml every night. It never prints page content,
// because the workflow logs of a public repository are public.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const token = process.env.NOTION_TOKEN;
const out = process.argv[2];
if (!token || !out) {
  console.error("Usage: NOTION_TOKEN=... node scripts/backup.mjs <output-folder>");
  process.exit(1);
}

const VERSION = "2026-03-11";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body, query = {}) {
  const url = new URL("https://api.notion.com/v1" + path);
  for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": VERSION, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await sleep((Number(res.headers.get("Retry-After")) || 2 ** attempt) * 1000);
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${data.code ?? ""}`);
    await sleep(350); // stay under ~3 requests per second
    return data;
  }
}

async function searchAll(value) {
  const results = [];
  let cursor;
  do {
    const res = await api("POST", "/search", {
      filter: { property: "object", value },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    results.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return results.filter((r) => !r.in_trash && !r.archived);
}

const plain = (rich) => (rich ?? []).map((t) => t.plain_text ?? "").join("");
const titleOf = (obj) => {
  if (Array.isArray(obj.title)) return plain(obj.title);
  const t = Object.values(obj.properties ?? {}).find((p) => p.type === "title");
  return t ? plain(t.title) : "";
};
const slug = (s) =>
  (s || "untitled")
    .replace(/[\\/:*?"<>|#\n\r\t]+/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60) || "untitled";
const fileName = (title, id) => `${slug(title)}-${id.replace(/-/g, "")}`;

function propValue(p) {
  const v = p?.[p.type];
  switch (p?.type) {
    case "title":
    case "rich_text":
      return plain(v);
    case "select":
    case "status":
      return v?.name ?? null;
    case "multi_select":
      return (v ?? []).map((o) => o.name);
    case "people":
      return (v ?? []).map((u) => u.name ?? u.id);
    case "relation":
      return (v ?? []).map((r) => r.id);
    case "date":
      return v ? (v.end ? `${v.start} → ${v.end}` : v.start) : null;
    case "formula":
      return v?.[v.type] ?? null;
    case "rollup":
      return v?.type === "array" ? (v.array ?? []).map(propValue) : (v?.[v?.type] ?? null);
    case "files":
      return (v ?? []).map((f) => f.name);
    case "created_by":
    case "last_edited_by":
      return v?.name ?? v?.id ?? null;
    case "unique_id":
      return v ? `${v.prefix ? v.prefix + "-" : ""}${v.number}` : null;
    default:
      return v ?? null;
  }
}

const yamlString = (s) => JSON.stringify(String(s ?? ""));

async function main() {
  const started = Date.now();
  await rm(join(out, "pages"), { recursive: true, force: true });
  await rm(join(out, "databases"), { recursive: true, force: true });
  await mkdir(join(out, "pages"), { recursive: true });
  await mkdir(join(out, "databases"), { recursive: true });

  const sources = await searchAll("data_source");
  for (const ds of sources) {
    const full = ds.properties ? ds : await api("GET", `/data_sources/${ds.id}`);
    const schema = Object.fromEntries(
      Object.entries(full.properties ?? {}).map(([name, p]) => [
        name,
        { type: p.type, options: p[p.type]?.options?.map((o) => o.name) },
      ]),
    );
    await writeFile(
      join(out, "databases", fileName(titleOf(full), full.id) + ".json"),
      JSON.stringify({ id: full.id, title: titleOf(full), database_id: full.parent?.database_id, schema }, null, 2) + "\n",
    );
  }

  const pages = await searchAll("page");
  const index = [];
  let failed = 0;
  for (const page of pages) {
    const title = titleOf(page) || "Untitled";
    const name = fileName(title, page.id);
    let markdown = "";
    try {
      markdown = (await api("GET", `/pages/${page.id}/markdown`, undefined, { markdown_version: "v2" })).markdown ?? "";
    } catch {
      failed++;
      markdown = "> (content could not be exported)";
    }
    const props = Object.entries(page.properties ?? {})
      .filter(([, p]) => p.type !== "title")
      .map(([n, p]) => `  ${yamlString(n)}: ${JSON.stringify(propValue(p))}`);
    const front = [
      "---",
      `title: ${yamlString(title)}`,
      `id: ${page.id}`,
      `url: ${page.url}`,
      `parent: ${JSON.stringify(page.parent ?? null)}`,
      `last_edited: ${page.last_edited_time}`,
      ...(props.length ? ["properties:", ...props] : []),
      "---",
      "",
    ].join("\n");
    await writeFile(join(out, "pages", name + ".md"), front + markdown + "\n");
    index.push({ title, name, edited: page.last_edited_time });
  }

  index.sort((a, b) => a.title.localeCompare(b.title));
  await writeFile(
    join(out, "index.md"),
    [
      "# Orion Notion backup",
      "",
      `${index.length} pages · ${sources.length} databases`,
      "",
      ...index.map((p) => `- [${p.title.replace(/[[\]]/g, "")}](pages/${encodeURIComponent(p.name)}.md) · ${p.edited.slice(0, 10)}`),
      "",
    ].join("\n"),
  );

  console.log(`Backed up ${index.length} pages and ${sources.length} databases in ${Math.round((Date.now() - started) / 1000)}s (${failed} failed).`);
}

main().catch((e) => {
  console.error("Backup failed:", e.message);
  process.exit(1);
});
