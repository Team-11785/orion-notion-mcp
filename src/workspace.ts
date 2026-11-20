/**
 * A map of the Orion workspace so Claude doesn't have to rediscover it every time.
 * If you add or rename databases, update this file and redeploy.
 * (IDs are database IDs unless marked as data sources; the server accepts either.)
 */
export const WORKSPACE_MAP = `
# Orion FRC Notion: workspace map (season 2026-2027)

Root page "2026-2027": 5c401eef9edb83a3bd9381079ff45d75
└─ "Home" page: 41701eef9edb818580e5e93bac1ce281
   ├─ Pages: Team Stuff (41701eef9edb81e88b5be334ea43997c), Knowledge Hub (41701eef9edb813589e2e2c0fa8470bd),
   │         Training (41701eef9edb8120a37cfb5ef1c098a6), Goals (41701eef9edb81debad0c3873d444cfd),
   │         Personal Spaces (41701eef9edb81db85e8ca30482d1344)
   │
   ├─ 💼 Missions (database 41c01eef9edb819f8d41fadc787679e3): the team-wide task board.
   │    Mission (title) · Status: Backlog | To Do | In Progress | Stuck | Complete (default Backlog)
   │    Priority: High | Medium | Low · Due Date (date)
   │    Team: Team 1 | Team 2 | Team 3 | Team 4. Empty = unassigned; team leads set it to take a task.
   │    category: פרויקט קהילתי | פרויקט | הכשרה | לוגיסטיקה | אחר · an unnamed checkbox column ("")
   │
   ├─ 🚀 Mission Teams (database 82bf82a6883844fdb7998f3b5fa8a14c): one page per mission team.
   │    Name · Status: Active | Paused | Archived · Area: Technical | יק״ם | בקרה · Team Lead (people) · Members (people)
   │    Each team page has its own tasks database:
   │      Mission Team 1 Tasks 89519dcef4044c508374a50e60138c9d
   │      Mission Team 2 Tasks 510869e53de54557b0fe5fa9b1ef4749
   │      Mission Team 3 Tasks 420291311be849928eaebd505069986c
   │    Team task columns: Task (title) · Status: Not Started | In Progress | Ready for Testing | Ready for Review |
   │      Changes Requested | Ready for Merge | On Hold | Skip | Done · Assign (people) · Reviewer (people)
   │      Priority: High | Medium | Low · Timeline: Current Sprint | Current Version | Next Sprint | Next Version | Backlog
   │      Responsibility / Tags (multi-select: Mechanical, CAD, Electrical, Programming, Strategy / Bugs, Training, Research…)
   │      Date · Requested by (text) · Waiting for (text) · Main Branch Name (text) · Highlight Needed: Yes | No
   │
   ├─ 🕝 Weekly Meetings (database 41b01eef9edb810aa577fd495a0747b6)
   │    Meeting (title) · Date · Day (text) · Time (text) · Agenda (text)
   │    Attendees (multi-select): תכן | בקרה | קבוצה | בעלי תפקידים
   │    Status: To be confirmed | Scheduled | Cmplete (sic) | Cancelled (default Scheduled)
   │
   ├─ Team Members (database 41b01eef9edb8143b798fa53233d691f): roster.
   │    Name · Person (people) · Role: Captain | Mentor | Programming | Mechanical | Electrical | Design | Business & Outreach · Notes
   │
   └─ 💡 Ideas for the team (database 41e01eef9edb81b18fc2cfc55419b292)
        Idea (title) · Description · Category: Design | Control | Fundraising | Outreach | Other
        Status: New | Under review | Approved | Rejected · Suggested by (people)

Claude Log (database 41e01eef9edb8141b03be8e598c2af0b): automatic log of actions done through this server. Don't edit by hand.

Conventions:
- Use the exact option names above (they are case-sensitive; "Cmplete" really is spelled that way).
- New team-wide work goes to Missions; work a specific mission team owns goes to that team's Tasks database.
- Meeting summaries go in the body of the meeting's page in Weekly Meetings.
`.trim();
