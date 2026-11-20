#!/usr/bin/env node
// Generates personal keys for team members and the MEMBERS secret for the server.
//
//   node scripts/gen-key.mjs "Itay:editor" "Carmel:admin" "Noa:viewer"
//
// To add people later without changing existing keys, pass the current MEMBERS JSON:
//   node scripts/gen-key.mjs --existing members.json "NewPerson:editor"
//
// Roles: viewer (read only), editor (read + write), admin (also trash/delete).

import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
let members = {};
const existingIdx = args.indexOf("--existing");
if (existingIdx !== -1) {
  members = JSON.parse(readFileSync(args[existingIdx + 1], "utf8"));
  args.splice(existingIdx, 2);
}
if (!args.length) {
  console.error('Usage: node scripts/gen-key.mjs "Name:role" ["Name:role" ...]');
  process.exit(1);
}

const issued = [];
for (const spec of args) {
  const [name, role = "editor"] = spec.split(":");
  if (!["viewer", "editor", "admin"].includes(role)) {
    console.error(`Bad role "${role}" for ${name}. Use viewer, editor or admin.`);
    process.exit(1);
  }
  const key = randomBytes(24).toString("base64url");
  const hash = createHash("sha256").update(key).digest("hex");
  members[hash] = { name, role };
  issued.push({ name, role, key });
}

writeFileSync("members.json", JSON.stringify(members, null, 2));

console.log("\nPersonal keys (send each person ONLY their own line; they are not saved anywhere):\n");
for (const { name, role, key } of issued) console.log(`  ${name} (${role}):  ${key}`);
console.log("\nSaved the hashed list to members.json. Upload it to the server with:");
console.log("  npx wrangler secret put MEMBERS < members.json\n");
