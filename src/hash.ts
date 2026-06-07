import crypto from "node:crypto";

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function normalizeOutputForHashing(output: string): string {
  return output
    // Normalize file/line/column locations: file.c:170:3:
    .replace(/:\d+:\d+:/g, ":LINE:COL:")
    // Normalize single line locations: string.h:548: or string.h:548,
    .replace(/:\d+([:,])/g, ":LINE$1")
    // Normalize compiler source gutters: "  172 |"
    .replace(/^(\s*)\d+(\s+\|)/gm, "  LINE$2")
    // Normalize incrementing filenames: file1.c -> file.c
    .replace(/\b([a-zA-Z_][a-zA-Z0-9_-]*?)\d+(\.[a-zA-Z0-9]+)\b/g, "$1$2")
    // Strip common time formats: 1.23s, 45ms, 1m 23s
    .replace(/\b\d+(\.\d+)?(ms|s|m)\b/g, "")
    // Strip absolute file paths that might contain temp dirs
    .replace(/\/tmp\/[a-zA-Z0-9_-]+/g, "/tmp/xxx")
    // Strip memory addresses
    .replace(/0x[a-fA-F0-9]+/g, "0xXXX")
    .trim();
}
