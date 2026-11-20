#!/usr/bin/env node
// Creates the shared team link secret. Run again any time to rotate it
// (the old link stops working as soon as you upload the new one).
import { randomBytes } from "node:crypto";

const key = randomBytes(24).toString("base64url");
console.log(`\nNew team key: ${key}\n`);
console.log("1. Upload it to the server:");
console.log("     npx wrangler secret put TEAM_KEY");
console.log("   and paste the key when asked.\n");
console.log("2. The link everyone adds to Claude:");
console.log(`     https://orion-notion-mcp.<account>.workers.dev/mcp/${key}\n`);
