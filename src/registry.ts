import { hasRole, type Member } from "./auth.js";
import { BASE_TOOLS, type Tool } from "./tools.js";
import { EXTRA_TOOLS } from "./tools-extra.js";

export const TOOLS: Tool[] = [...BASE_TOOLS, ...EXTRA_TOOLS];

export function toolsFor(member: Member) {
  return TOOLS.filter((t) => hasRole(member, t.role));
}
