# Orion Notion MCP 🚀

שרת קטן שמאפשר לכל חברי הקבוצה, גם אם הם **אורחים** ב-Notion, לעבוד עם Claude על ה-Notion של הקבוצה: לחפש, לקרוא, ליצור משימות, לעדכן סטטוסים, לסכם פגישות ועוד.

```
חבר קבוצה ← Claude שלו ← השרת הזה (Cloudflare) ← Notion API ← ה-workspace של אוריון
```

- **בחינם:** Cloudflare Workers ו-Notion API חינמיים, וכל אחד משתמש ב-Claude שלו.
- **מפתח אישי לכל חבר**, עם שלוש רמות הרשאה: `viewer` (קריאה בלבד), `editor` (קריאה וכתיבה), `admin` (גם מחיקה).
- **רואים מי עשה מה:** תגובות מופיעות עם שם החבר, ואפשר לנהל לוג פעולות במאגר ב-Notion.

---

## התקנה (פעם אחת, כ-20 דקות)

צריך: מחשב עם [Node.js](https://nodejs.org) גרסה 20 ומעלה, וחשבון חינמי ב-[Cloudflare](https://dash.cloudflare.com/sign-up).

### 1. ליצור חיבור פנימי ב-Notion
רק **בעלים של ה-workspace** יכולים לעשות את זה.

1. נכנסים ל-[Developer portal](https://app.notion.com/developers/connections) ← **Internal connections** ← **Create a new connection**.
2. שם: `Orion Claude`. בוחרים את ה-workspace של הקבוצה.
3. ב-**Capabilities** מסמנים: Read content, Update content, Insert content, Read comments, Insert comments, Read user information including email addresses.
4. מעתיקים את ה-**API token** (מתחיל ב-`ntn_`). זו סיסמה, לא משתפים אותה.

### 2. לשתף את דף העונה עם החיבור
פותחים את דף **2026-2027** ← `•••` למעלה מימין ← **Connections** ← **Add connection** ← `Orion Claude`.
כל תתי-הדפים מקבלים גישה אוטומטית. דף שלא משותף עם החיבור, השרת לא יראה.

### 3. להתקין ולהתחבר ל-Cloudflare
בטרמינל, מתוך התיקייה הזו:
```bash
npm install
npx wrangler login
```

### 4. להגדיר את הסודות
```bash
npx wrangler secret put NOTION_TOKEN
# מדביקים את ה-token מהשלב הראשון
```

יוצרים מפתחות לחברים. כל חבר בפורמט `"שם:תפקיד"`:
```bash
npm run gen-key -- "Carmel:admin" "Itay:editor" "Noa:editor" "Guy:viewer"
npx wrangler secret put MEMBERS < members.json
```
הסקריפט מדפיס **מפתח אישי** לכל אחד. שולחים לכל חבר רק את המפתח שלו, בהודעה פרטית. המפתחות עצמם לא נשמרים בשום מקום: בקובץ `members.json` יש רק גרסה מוצפנת (hash) שלהם.

### 5. להעלות לאוויר
```bash
npm run deploy
```
בסוף מופיעה כתובת כמו `https://orion-notion-mcp.<שם-החשבון>.workers.dev`. אם נכנסים אליה בדפדפן, צריכה להופיע ההודעה *"Orion Notion MCP server is running"*.

---

## חיבור ל-Claude (כל חבר בנפרד)

1. ב-Claude: **Settings** ← **Connectors** ← **Add custom connector**.
2. שם: `Orion Notion`.
3. כתובת:
   ```
   https://orion-notion-mcp.<שם-החשבון>.workers.dev/mcp/<המפתח-האישי>
   ```
4. **Add**, וזהו. אפשר לכתוב ל-Claude למשל: *"מה המשימות הפתוחות של צוות 2?"*

> במשתמשי Claude Free אפשר להוסיף **custom connector אחד** בלבד, וזה מספיק לשרת הזה.
> מי שמעדיף לא לשים את המפתח בכתובת: אפשר להשתמש בכתובת `.../mcp`, ותחת **Advanced settings** ← **Request headers** להוסיף `Authorization: Bearer <המפתח>`.

---

## מה Claude יכול לעשות דרך השרת

| כלי | מה הוא עושה | הרשאה |
|---|---|---|
| `notion_whoami` | מי אני ומה מותר לי | viewer |
| `notion_search` | חיפוש דפים ומאגרים | viewer |
| `notion_fetch` | קריאת דף (כולל כל התוכן), מאגר או סכמה | viewer |
| `notion_query_data_source` | שורות ממאגר, עם סינון ומיון | viewer |
| `notion_list_views` | תצוגות של מאגר | viewer |
| `notion_get_comments` | קריאת תגובות | viewer |
| `notion_get_users` | רשימת אנשים | viewer |
| `notion_create_pages` | יצירת דפים ושורות (עד 20 בפעם) | editor |
| `notion_update_page` | עדכון מאפיינים, אייקון ותוכן | editor |
| `notion_move_page` | העברת דף | editor |
| `notion_create_database` | יצירת מאגר חדש | editor |
| `notion_update_data_source` | הוספה ושינוי של עמודות | editor |
| `notion_create_view` / `notion_update_view` | תצוגות (טבלה, לוח, לוח שנה...) | editor |
| `notion_create_comment` | תגובה, עם שם החבר | editor |
| `notion_trash_page` / `notion_restore_page` | העברה לפח ושחזור | admin |
| `notion_delete_view` | מחיקת תצוגה | admin |
| `notion_api_request` | גישה ישירה לכל ה-Notion API | admin |
| `notion_workspace_guide` | מפה של ה-workspace: מאגרים, עמודות ואפשרויות | viewer |
| `notion_get_recent_changes` | מה השתנה לאחרונה | viewer |
| `notion_get_block_children` | רשימת הבלוקים בדף | viewer |
| `notion_get_page_property` | ערכים מלאים של relation או people ארוכים | viewer |
| `notion_list_templates` | התבניות של מאגר | viewer |
| `notion_query_meeting_notes` | סיכומי פגישות של Notion AI | viewer |
| `notion_duplicate_page` | שכפול דף או שורה | editor |
| `notion_upload_file_from_url` | הוספת תמונה או קובץ מקישור | editor |
| `notion_update_block` | עריכת בלוק בודד (למשל סימון V) | editor |
| `notion_update_comment` / `notion_delete_comment` | עריכה ומחיקה של תגובות שנכתבו דרך השרת | editor |
| `notion_delete_block` | מחיקת בלוק | admin |

**עריכה מוגנת:** editor לא יכול למחוק תתי-דפים או מאגרים מתוך דף, ולא יכול למחוק עמודות. את אלה רק admin יכול לעשות.

**מה לא אפשרי דרך ה-API של Notion:** לוח השנה של Notion, Notion Agents ו-AI, היסטוריית גרסאות ושחזור גרסה, ומועדפים וסרגל צד. שכפול דף עובד, אבל תתי-דפים ומאגרים שבתוכו הופכים לקישורים ולא משוכפלים.

---

## מפת ה-workspace

ב-`src/workspace.ts` יש מפה של ה-workspace: המאגרים, העמודות ושמות האפשרויות המדויקים. Claude מקבל אותה בכל חיבור, כדי שלא יצטרך לחפש כל פעם מחדש. **אם מוסיפים או משנים מאגר, צריך לעדכן את הקובץ ולהריץ `npm run deploy`.**

---

## לוג פעולות (אופציונלי, מומלץ)

ב-Notion כל שינוי שהשרת עושה מופיע כאילו "Orion Claude" ביצע אותו. כדי לדעת מי ביקש מה:

המאגר **Claude Log** כבר קיים בתוך דף העונה, והמזהה שלו כבר מוגדר ב-`wrangler.toml`. אם יוצרים אותו מחדש, צריך עמודות `Action` (Title), `Member` (Text), `Page` (URL) ו-`Details` (Text), ולעדכן את `LOG_DATA_SOURCE_ID`.

---

## ניהול חברים

- **להוסיף חבר** בלי לשנות את המפתחות של כולם:
  ```bash
  npm run gen-key -- --existing members.json "NewName:editor"
  npx wrangler secret put MEMBERS < members.json
  ```
- **להסיר חבר:** מוחקים את השורה שלו ב-`members.json` (לפי השם) ומעלים שוב עם `wrangler secret put`.
- **מפתח שדלף:** מסירים את החבר ומוסיפים אותו שוב, כדי שיקבל מפתח חדש.

שומרים את `members.json` אצל מנהל המערכת. הוא לא סודי כמו ה-token, אבל בלעדיו קשה לנהל את החברים.

---

## פיתוח ובדיקות
```bash
npm run typecheck   # בדיקת טיפוסים
npm test            # 25 בדיקות: Notion API מדומה + חיבור עם ה-MCP client הרשמי
npm run dev         # הרצה מקומית (צריך קובץ .dev.vars עם NOTION_TOKEN ו-MEMBERS)
```

**מגבלת קצב:** Notion מאפשר כ-3 בקשות בשנייה לחיבור, משותף לכל הקבוצה. השרת מחכה ומנסה שוב אוטומטית כשמגיעים למגבלה.
