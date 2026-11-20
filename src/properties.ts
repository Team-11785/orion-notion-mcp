/**
 * Converts Notion's verbose property JSON to plain values (for reading) and plain
 * values back to Notion's JSON (for writing), so Claude can say
 *   { "Status": "In progress", "Due": "2026-11-25" }
 * instead of building nested objects by hand.
 */

export const plainText = (rich: any[] | undefined): string =>
  (rich ?? []).map((t: any) => t?.plain_text ?? t?.text?.content ?? "").join("");

export function titleOf(obj: any): string {
  if (!obj) return "";
  if (Array.isArray(obj.title)) return plainText(obj.title);
  for (const prop of Object.values<any>(obj.properties ?? {})) {
    if (prop?.type === "title") return plainText(prop.title);
  }
  return "";
}

const simpleUser = (u: any) => (u?.name ? { id: u.id, name: u.name } : { id: u?.id });

function formulaValue(f: any): unknown {
  if (!f) return null;
  return f[f.type] ?? null;
}

export function readProperty(prop: any): unknown {
  if (!prop) return null;
  const v = prop[prop.type];
  switch (prop.type) {
    case "title":
    case "rich_text":
      return plainText(v);
    case "number":
    case "checkbox":
    case "url":
    case "email":
    case "phone_number":
    case "created_time":
    case "last_edited_time":
      return v ?? null;
    case "select":
    case "status":
      return v?.name ?? null;
    case "multi_select":
      return (v ?? []).map((o: any) => o.name);
    case "date":
      return v ? (v.end ? { start: v.start, end: v.end } : v.start) : null;
    case "people":
      return (v ?? []).map(simpleUser);
    case "created_by":
    case "last_edited_by":
      return simpleUser(v);
    case "relation":
      return { ids: (v ?? []).map((r: any) => r.id), has_more: Boolean(prop.has_more) };
    case "files":
      return (v ?? []).map((f: any) => ({ name: f.name, url: f.external?.url ?? f.file?.url }));
    case "formula":
      return formulaValue(v);
    case "rollup":
      if (!v) return null;
      if (v.type === "array") return (v.array ?? []).map(readProperty);
      return v[v.type] ?? null;
    case "unique_id":
      return v ? `${v.prefix ? v.prefix + "-" : ""}${v.number}` : null;
    case "verification":
      return v?.state ?? null;
    case "button":
      return null;
    default:
      return v ?? null;
  }
}

export function readProperties(props: Record<string, any> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(props ?? {})) out[name] = readProperty(prop);
  return out;
}

export function simplifyPage(page: any) {
  return {
    object: page.object,
    id: page.id,
    url: page.url,
    title: titleOf(page),
    icon: page.icon?.emoji ?? page.icon?.icon?.name ?? undefined,
    parent: page.parent,
    in_trash: page.in_trash ?? undefined,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
    properties: readProperties(page.properties),
  };
}

/** A compact description of a data source schema that is easy for Claude to read. */
export function describeSchema(properties: Record<string, any> | undefined) {
  const out: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(properties ?? {})) {
    const cfg = p?.[p.type] ?? {};
    const entry: Record<string, unknown> = { type: p.type, id: p.id };
    if (cfg.options) entry.options = cfg.options.map((o: any) => o.name);
    if (p.type === "status" && cfg.groups) {
      entry.groups = cfg.groups.map((g: any) => ({
        name: g.name,
        options: (g.option_ids ?? [])
          .map((id: string) => cfg.options?.find((o: any) => o.id === id)?.name)
          .filter(Boolean),
      }));
    }
    if (p.type === "relation") entry.related_data_source_id = cfg.data_source_id ?? cfg.database_id;
    if (p.type === "number" && cfg.format) entry.format = cfg.format;
    if (p.type === "formula" && cfg.expression) entry.expression = cfg.expression;
    out[name] = entry;
  }
  return out;
}

// ---------------------------------------------------------------- writing

const PROPERTY_TYPES = new Set([
  "title", "rich_text", "number", "select", "status", "multi_select", "date", "people",
  "relation", "checkbox", "url", "email", "phone_number", "files",
]);
const READ_ONLY = new Set([
  "formula", "rollup", "created_time", "created_by", "last_edited_time", "last_edited_by",
  "unique_id", "button", "verification",
]);

export function richText(text: string) {
  const s = String(text ?? "");
  if (!s) return [];
  const chunks: any[] = [];
  for (let i = 0; i < s.length; i += 2000) chunks.push({ type: "text", text: { content: s.slice(i, i + 2000) } });
  return chunks;
}

const toList = (v: unknown): any[] =>
  v === null || v === undefined || v === ""
    ? []
    : Array.isArray(v)
      ? v
      : typeof v === "string"
        ? v.split(",").map((s) => s.trim()).filter(Boolean)
        : [v];

const looksLikeUuid = (s: string) => /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(s);

export type UserResolver = (nameOrEmail: string) => Promise<string>;

export async function writeProperty(
  type: string,
  value: unknown,
  ctx: { resolveUser: UserResolver; normalizeId: (s: string) => string },
): Promise<any> {
  if (READ_ONLY.has(type)) throw new Error(`property type "${type}" is computed by Notion and can't be set`);

  // Already in Notion's own format? Pass it through untouched.
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value as object);
    if (keys.length >= 1 && keys.every((k) => PROPERTY_TYPES.has(k) || k === "type")) return value;
  }

  switch (type) {
    case "title":
      return { title: richText(String(value ?? "")) };
    case "rich_text":
      return { rich_text: richText(String(value ?? "")) };
    case "number": {
      if (value === null || value === "") return { number: null };
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`"${value}" is not a number`);
      return { number: n };
    }
    case "select":
      return { select: value ? { name: String(value) } : null };
    case "status":
      return { status: value ? { name: String(value) } : null };
    case "multi_select":
      return { multi_select: toList(value).map((name) => ({ name: String(name) })) };
    case "date": {
      if (!value) return { date: null };
      if (typeof value === "object") return { date: value };
      return { date: { start: String(value) } };
    }
    case "checkbox": {
      const truthy = value === true || /^(true|yes|1|v|כן)$/i.test(String(value));
      return { checkbox: truthy };
    }
    case "url":
      return { url: value ? String(value) : null };
    case "email":
      return { email: value ? String(value) : null };
    case "phone_number":
      return { phone_number: value ? String(value) : null };
    case "people": {
      const ids: string[] = [];
      for (const v of toList(value)) {
        const s = typeof v === "object" ? String((v as any).id ?? (v as any).name ?? "") : String(v);
        ids.push(looksLikeUuid(s) ? s : await ctx.resolveUser(s));
      }
      return { people: ids.map((id) => ({ id })) };
    }
    case "relation":
      return {
        relation: toList(value).map((v) => ({
          id: ctx.normalizeId(typeof v === "object" ? String((v as any).id) : String(v)),
        })),
      };
    case "files":
      return {
        files: toList(value).map((v) => {
          const url = typeof v === "object" ? String((v as any).url) : String(v);
          const name = typeof v === "object" && (v as any).name ? String((v as any).name) : url.split("/").pop() || "file";
          return { name: name.slice(0, 100), type: "external", external: { url } };
        }),
      };
    default:
      throw new Error(`don't know how to set property type "${type}"; pass it in Notion's raw format`);
  }
}

/**
 * Converts {name: plainValue} to Notion's property payload using the data source schema.
 * Unknown names are reported clearly instead of being silently dropped.
 */
export async function buildProperties(
  input: Record<string, unknown> | undefined,
  schema: Record<string, any> | null,
  ctx: { resolveUser: UserResolver; normalizeId: (s: string) => string },
): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  if (!input) return out;

  if (!schema) {
    // Page parent: only the title can be set.
    for (const [name, value] of Object.entries(input)) {
      if (name.toLowerCase() !== "title") {
        throw new Error(`pages under a regular page only have a title; got property "${name}"`);
      }
      out.title = await writeProperty("title", value, ctx);
    }
    return out;
  }

  const titleName = Object.entries(schema).find(([, p]) => p?.type === "title")?.[0];
  for (const [rawName, value] of Object.entries(input)) {
    let name = rawName;
    if (!(name in schema)) {
      const ci = Object.keys(schema).find((k) => k.toLowerCase() === rawName.toLowerCase());
      if (ci) name = ci;
      else if (rawName.toLowerCase() === "title" && titleName) name = titleName;
      else {
        throw new Error(`no property named "${rawName}". Available: ${Object.keys(schema).join(", ")}`);
      }
    }
    out[name] = await writeProperty(schema[name].type, value, ctx);
  }
  return out;
}
