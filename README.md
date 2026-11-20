# Orion Notion MCP

A small remote [MCP](https://modelcontextprotocol.io) server that lets every team member use Claude with the team's Notion workspace, including people who are only **guests** in Notion.

```
team member → their Claude → this server (Cloudflare Workers) → Notion API → Orion workspace
```

- **Free:** Cloudflare Workers and the Notion API cost nothing, and everyone uses their own Claude account.
- **One link for the whole team:** paste it into Claude (or any MCP client) and start working. No accounts, no personal keys, no roles: everyone with the link can do everything.
- **Always up to date:** the workspace map (pages, databases, columns, option names) is read live from Notion.
- **Accountability:** every write is logged to a Notion database.

---

## Setup (once, about 20 minutes)

You need [Node.js](https://nodejs.org) 20+ and a free [Cloudflare](https://dash.cloudflare.com/sign-up) account.

### 1. Create an internal connection in Notion
Only a **workspace owner** can do this.

1. Open the [Developer portal](https://app.notion.com/developers/connections) → **Internal connections** → **Create a new connection**.
2. Name it `Orion Claude` and pick the team workspace.
3. Under **Capabilities**, enable: Read content, Update content, Insert content, Read comments, Insert comments, Read user information including email addresses.
4. Copy the **API token** (starts with `ntn_`). Treat it like a password.

### 2. Share the season page with the connection
Open **2026-2027** → `•••` → **Connections** → **Add connection** → `Orion Claude`.
All sub-pages inherit access. Anything not shared with the connection is invisible to the server.

### 3. Install and log in to Cloudflare
```bash
npm install
npx wrangler login
```

### 4. Set the secrets
```bash
npx wrangler secret put NOTION_TOKEN
# paste the token from step 1
```

Create the team link secret:
```bash
npm run team-key
npx wrangler secret put TEAM_KEY
# paste the key it printed
```

### 5. Deploy
```bash
npm run deploy
```
You'll get a URL like `https://orion-notion-mcp.<account>.workers.dev`. Opening it in a browser should show *"Orion Notion MCP server is running"*.

---

## Connecting (each member)

The team link looks like `https://orion-notion-mcp.<account>.workers.dev/mcp/<team-key>`.
Add `?name=YourName` at the end if you want your name in the action log (optional, not verified).

**Claude** (any plan, including Free): **Settings** → **Connectors** → **Add custom connector** → name `Orion Notion`, paste the link → **Add**.
Claude Free allows one custom connector, which is enough.

**Codex:**
```bash
codex mcp add orion-notion --url "https://orion-notion-mcp.<account>.workers.dev/mcp/<team-key>"
```

**Cursor / VS Code / any MCP client** that supports remote (Streamable HTTP) servers: add the link as a remote MCP server.

Then try: *"What are Team 2's open tasks?"*

**Rotating the link** (if it leaks or someone leaves): run `npm run team-key`, upload the new key with `npx wrangler secret put TEAM_KEY`, and share the new link. The old one stops working immediately.

---

## Tools

| Tool | What it does |
|---|---|
| `notion_whoami` | Workspace name and the season root page |
| `notion_workspace_guide` | Map of the workspace: databases, columns, option names |
| `notion_search` | Search pages and databases |
| `notion_fetch` | Read a page (full content), a database or a schema |
| `notion_query_data_source` | Database rows with filters and sorts |
| `notion_get_recent_changes` | What changed recently |
| `notion_list_views` | Views of a database |
| `notion_get_comments` | Read comments |
| `notion_get_users` | List people |
| `notion_get_block_children` | List the blocks in a page |
| `notion_get_page_property` | Full values of long relation/people properties |
| `notion_list_templates` | Templates of a database |
| `notion_query_meeting_notes` | Notion AI meeting notes |
| `notion_create_pages` | Create pages and rows (up to 20 at once) |
| `notion_update_page` | Update properties, icon and content |
| `notion_duplicate_page` | Copy a page or row |
| `notion_move_page` | Move a page |
| `notion_upload_file_from_url` | Add an image or file from a link |
| `notion_update_block` | Edit a single block (e.g. tick a to-do) |
| `notion_create_database` | Create a database |
| `notion_update_data_source` | Add or change columns |
| `notion_create_view` / `notion_update_view` | Table, board, calendar… views |
| `notion_create_comment` | Comment, signed with the member's name |
| `notion_update_comment` / `notion_delete_comment` | Edit/delete comments written through the server |
| `notion_trash_page` / `notion_restore_page` | Trash and restore |
| `notion_delete_view` / `notion_delete_block` | Delete a view or block |
| `notion_api_request` | Direct access to any Notion API endpoint |

**Deleting:** trashing pages, removing columns and edits that remove sub-pages all work, but Claude is instructed to confirm with you first. Trashed pages can be restored for 30 days.

**Not possible through the Notion API:** Notion Calendar, Notion Agents/AI, version history, favorites and the sidebar. Duplicating works, but sub-pages and databases inside the copied page become links instead of copies.

---

## Workspace map

`notion_workspace_guide` builds the map live from Notion: the page tree under the season page, and every database with its columns and exact option names. New or renamed databases, columns and options show up automatically (cached for 10 minutes; ask Claude to refresh it right after a change).
Only the team conventions in `src/workspace.ts` (e.g. "new team-wide work goes to Missions") are written by hand.

## Action log

Every change made through the server shows up in Notion as "Orion Claude". To see who asked for what, the server writes a row to the **Claude Log** database (already created under the season page; its ID is set in `wrangler.toml`). If you recreate it, it needs the columns `Action` (Title), `Member` (Text), `Page` (URL) and `Details` (Text); then update `LOG_DATA_SOURCE_ID`.

---

## Development

```bash
npm run typecheck   # type check
npm test            # 26 tests: mocked Notion API + the official MCP client
npm run dev         # run locally (needs .dev.vars with NOTION_TOKEN and TEAM_KEY)
```

**Rate limit:** Notion allows about 3 requests per second per connection, shared by the whole team. The server backs off and retries automatically.
