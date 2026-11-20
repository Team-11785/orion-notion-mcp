# Orion Notion MCP

A small remote [MCP](https://modelcontextprotocol.io) server that lets every team member use Claude with the team's Notion workspace, including people who are only **guests** in Notion.

```
team member → their Claude → this server (Cloudflare Workers) → Notion API → Orion workspace
```

- **Free:** Cloudflare Workers and the Notion API cost nothing, and everyone uses their own Claude account.
- **One link for the whole team:** paste it into Claude (or any MCP client) and start working. No accounts, no personal keys, no roles: everyone with the link can do everything.
- **Always up to date:** the workspace map (pages, databases, columns, option names) is read live from Notion.
- **Accountability:** every write is logged to a Notion database.
- **Automations:** daily digest to Discord/Telegram, automatic weekly meeting pages, GitHub pull requests → task status, and a nightly backup to a private repo.

---

## Setup (once, about 20 minutes)

Deployment runs from GitHub Actions: every push to `main` runs the tests and deploys to Cloudflare. You only need to set secrets.

### 1. Notion: create an internal connection
Only a **workspace owner** can do this.

1. Open the [Developer portal](https://app.notion.com/developers/connections) → **Internal connections** → **Create a new connection**.
2. Name it `Orion Claude` and pick the team workspace.
3. Under **Capabilities**, enable: Read content, Update content, Insert content, Read comments, Insert comments, Read user information including email addresses.
4. Copy the **API token** (starts with `ntn_`). Treat it like a password.
5. Open **2026-2027** → `•••` → **Connections** → **Add connection** → `Orion Claude`. Sub-pages inherit access; anything not shared is invisible to the server.

### 2. Cloudflare: account and API token
1. Create a free account at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up).
2. Open **Workers & Pages** once and pick a `workers.dev` subdomain (e.g. `orion-11785`). The server will live at `https://orion-notion-mcp.<subdomain>.workers.dev`.
3. Copy your **Account ID** (Workers & Pages overview, right side).
4. **My Profile → API Tokens → Create Token → "Edit Cloudflare Workers"** template → create, and copy the token.

### 3. GitHub: add the secrets
In this repo: **Settings → Secrets and variables → Actions → New repository secret**.

| Secret | Value | Required |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | token from step 2 | yes |
| `CLOUDFLARE_ACCOUNT_ID` | account ID from step 2 | yes |
| `NOTION_TOKEN` | Notion token from step 1 | yes |
| `TEAM_KEY` | a long random string, e.g. from `npm run team-key` | yes |
| `DIGEST_DISCORD_WEBHOOK` | Discord channel webhook URL | for the daily digest |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Telegram bot + group | for the daily digest |
| `GITHUB_WEBHOOK_SECRET` | any random string | for GitHub → Notion sync |
| `BACKUP_REPO_TOKEN` | see [Nightly backup](#nightly-backup) | for backups |

### 4. Deploy
**Actions → Deploy → Run workflow**. When it's green, open `https://orion-notion-mcp.<subdomain>.workers.dev`; it should say *"Orion Notion MCP server is running"*.
From then on every push to `main` redeploys, and changing a secret takes effect on the next run.

<details>
<summary>Deploying from your own computer instead</summary>

```bash
npm install
npx wrangler login
npx wrangler secret put NOTION_TOKEN
npx wrangler secret put TEAM_KEY
npm run deploy
```
</details>

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

## Automations

These run on their own and cover things guests can't set up in Notion. Each one stays off until its settings exist.

### Daily digest
Every morning at 07:00 (Israel) the team gets a message with today's meeting, overdue tasks, tasks due within two days, stuck tasks and Missions nobody took. It reads `MISSIONS_DB`, `TEAM_TASK_DBS` and `MEETINGS_DB` from `wrangler.toml`; "done" is whatever is in each status column's **Complete** group, so renamed options keep working.

- **Discord:** channel → Edit Channel → Integrations → Webhooks → New Webhook → copy URL → secret `DIGEST_DISCORD_WEBHOOK`.
- **Telegram:** create a bot with [@BotFather](https://t.me/BotFather), add it to the group, then set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.
- **WhatsApp** isn't supported: there's no free, official way for a bot to post in a WhatsApp group.

The wording lives in `LABELS` in `src/automation.ts`.

### Weekly meeting page
Set `MEETING_WEEKDAY` (0 = Sunday … 6 = Saturday) and optionally `MEETING_TIME` in `wrangler.toml`. Every day the server makes sure the next meeting has a page in Weekly Meetings, using the database's default template. It never creates duplicates.

### GitHub → Notion task sync
When a pull request opens, the team task whose **Main Branch Name** matches the PR branch moves to **Ready for Review**; when it's merged, to **Done**. A comment with the PR link is added to the task.

1. Set the `GITHUB_WEBHOOK_SECRET` secret and redeploy.
2. **Team-11785 → Settings → Webhooks → Add webhook**:
   - Payload URL: `https://orion-notion-mcp.<subdomain>.workers.dev/github/webhook`
   - Content type: `application/json`
   - Secret: the same `GITHUB_WEBHOOK_SECRET`
   - Events: **Pull requests** only

Draft PRs are ignored until they're marked ready.

### Nightly backup
Every night `.github/workflows/backup.yml` exports every page (as Markdown, with its properties) and every database schema into a **private** repository, with full history in git. This protects the team if the Notion account that owns the workspace is ever lost.

1. Create a **private** repo `Team-11785/orion-notion-backup` (empty).
2. GitHub → Settings → Developer settings → **Fine-grained tokens** → generate a token with access to that repo only, permission **Contents: Read and write**.
3. Add it as the `BACKUP_REPO_TOKEN` secret here. `NOTION_TOKEN` is shared with the deploy.
4. **Actions → Notion backup → Run workflow** to run it right away.

The backup never prints page content, because this repository's Actions logs are public.

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
npm test            # 34 tests: mocked Notion API, automations, and the official MCP client
npm run dev         # run locally (needs .dev.vars with NOTION_TOKEN and TEAM_KEY)
```

**Rate limit:** Notion allows about 3 requests per second per connection, shared by the whole team. The server backs off and retries automatically.
