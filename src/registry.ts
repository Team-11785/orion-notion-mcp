import { BASE_TOOLS, type Tool } from "./tools.js";
import { EXTRA_TOOLS } from "./tools-extra.js";

export const TOOLS: Tool[] = [...BASE_TOOLS, ...EXTRA_TOOLS];
