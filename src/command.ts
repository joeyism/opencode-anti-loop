import { readFile } from "node:fs/promises";
import path from "node:path";
import { hashContent } from "./hash.js";
import type { PluginState } from "./types.js";

export function normalizeCommand(command: string): string {
  let normalized = command;

  // 1. Normalize incrementing numbers in filenames (e.g., check_forward12.c -> check_forward.c, check_forward12 -> check_forward)
  // This catches cases where the agent creates file1.c, file2.c, or compiles to file1, file2 etc.
  normalized = normalized.replace(/\b([a-zA-Z_]+)(\d+)(\.[a-zA-Z0-9]+)?\b/g, (match, p1, p2, p3) => {
    if (!p3 && (p1 === "python" || p1 === "base" || p1 === "sha")) return match;
    return p1 + (p3 || "");
  });

  // 2. Hash heredoc bodies to prevent content changes from bypassing the filter
  // Matches << EOF or << 'EOF' or << "EOF" and everything up to the closing EOF on a new line
  normalized = normalized.replace(/<<\s*(['"]?)(\w+)\1([\s\S]*?)^[ \t]*\2/gm, (match, q, tag, body) => {
    return `<< ${q}${tag}${q} [HEREDOC:${hashContent(body).slice(0, 8)}]`;
  });

  return normalized.trim().replace(/\s+/g, " ");
}

export function normalizeActionSignature(action: string): string {
  return action
    .replace(/([/\\][^\s:'"`|&;<>]+?)(\d+)(?=(?:\.[^/\\\s:'"`|&;<>]+)?(?:$|[/\\\s:'"`|&;<>]))/g, "$1")
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*?)(\d+)\b/g, "$1")
    .trim();
}

export function extractHeredocTargets(command: string): string[] {
  const targets: string[] = [];
  // Matches both:
  // > file.c << EOF
  // << EOF > file.c
  const heredocTargetRegex = />\s*([^\s;]+)\s*<<\s*(['"]?)(\w+)\2|<<\s*(['"]?)(\w+)\4\s*>\s*([^\s;]+)/gm;
  let match;
  while ((match = heredocTargetRegex.exec(command)) !== null) {
    const target = match[1] || match[6];
    if (target) {
      targets.push(target);
    }
  }
  return targets;
}

export function extractHeredocFileTargets(command: string): string[] {
  const targets = new Set<string>();

  // Extract raw heredoc bodies (before they get stripped by normalizeCommand)
  // Matches << EOF or << 'EOF' or << "EOF" and everything up to the closing EOF on a new line
  const heredocBodyRegex = /<<\s*(['"]?)(\w+)\1[\s\S]*?^[ \t]*\2/gm;
  let match;
  while ((match = heredocBodyRegex.exec(command)) !== null) {
    const body = match[0];

    // Python: open('file.txt', ...), np.fromfile('file.txt', ...)
    // C: fopen("file.txt", ...)
    // Standard patterns for many languages
    const fileOpenRegex = /(?:open|fromfile|read_csv|load|fopen)\s*\(\s*['"]([^'"]+)['"]/g;
    let fileMatch;
    while ((fileMatch = fileOpenRegex.exec(body)) !== null) {
      const target = fileMatch[1];
      // Basic filter to skip argv[1] or other variable-like strings that might match if we're not careful
      // The regex above only matches string literals like 'file.txt' or "file.txt"
      targets.add(target);
    }
  }

  return Array.from(targets).sort();
}

export function extractBashReadTargets(command: string): string[] {
  const targets = new Set<string>();

  // Strip heredoc content (both operator and body) to prevent body content from being captured
  // Multi-line: strip from << delimiter through to closing delimiter on its own line
  let cleanCommand = command.replace(/<<-?\s*['"]?\w+['"]?[\s\S]*?^[ \t]*\w+['"]?\s*$/gm, " ");

  // Strip remaining heredoc operators (handles single-line heredocs or malformed ones)
  cleanCommand = cleanCommand.replace(/<<-?\s*['"]?\w+['"]?/g, " ");

  // Strip shell redirects before matching to prevent them from being caught as files
  // e.g. 2>/dev/null, > output.txt, &> log, 1>> out
  cleanCommand = cleanCommand
    .replace(/\s*(?:&|(?:\d+))?>>?\s*[^\s|;&]+/g, " ")
    .replace(/\s*<\s*[^\s|;&]+/g, " ");

  // Strip standalone heredoc closing delimiters that might remain after stripping body content
  cleanCommand = cleanCommand.replace(/^[ \t]*\w+['"]?\s*$/gm, " ");

  // Match read-only commands targeting a file: cat <file>, cat <file> | ..., head <file>, tail <file>, grep ... <file>, less <file>
  // Ensure we don't capture flags (starting with -)
  const patterns = [
    /\bcat\s+([^\s|;&]+)/g,
    /\bhead\s+(?:-[a-zA-Z]+\s+[^\s|;&]+\s+)*([^\s|;&]+)/g,
    /\btail\s+(?:-[a-zA-Z]+\s+[^\s|;&]+\s+)*([^\s|;&]+)/g,
    /\bgrep\s+.*?\s+([^\s|;&]+)\s*(?:[|;&]|$)/gm,
    /\bless\s+([^\s|;&]+)/g,
  ];

  for (const re of patterns) {
    let match;
    while ((match = re.exec(cleanCommand)) !== null) {
      if (match[1] && !match[1].startsWith('-')) {
        // Skip obvious non-file arguments and common output redirects
        if (match[1] !== ">" && match[1] !== ">>" && match[1] !== "<" && match[1] !== "2>") {
          // Skip /dev/* paths
          if (!/^\/dev\//.test(match[1])) {
            targets.add(match[1]);
          }
        }
      }
    }
  }

  return Array.from(targets).sort();
}

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "shall",
  "should", "may", "might", "must", "can", "could", "to", "of", "in",
  "for", "on", "with", "at", "by", "from", "if", "it", "its", "this",
  "that", "and", "or", "not", "no", "but", "so", "as", "up", "out",
  "just", "also", "than", "then", "into", "about", "again", "actually",
  "all", "follow", "follows"
]);

export function extractDescriptionKeywords(description: string | undefined): string {
  if (!description) return "";
  return description
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w))
    .sort()
    .join(" ");
}

export function computePromptNovelty(previousPrompt: string, newPrompt: string): number {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 2);
  const prevWords = new Set(normalize(previousPrompt));
  const newWords = normalize(newPrompt);
  if (newWords.length === 0) return 0;
  const novel = newWords.filter(w => !prevWords.has(w));
  return novel.length / newWords.length;
}

export function classifyBashIntent(command: string): "write" | "transform" | "build" | "run" | "investigate" | "setup" {
  const trimmed = command.trim();
  
  // Setup/install commands — retrying these is often legitimate due to network/IO flakiness
  if (/^(pip3?|python3?\s+-m\s+pip)\s+install\b/.test(trimmed)) return "setup";
  if (/^(npm|npx|yarn|pnpm)\s+(install|add|i)\b/.test(trimmed)) return "setup";
  if (/^(apt-get|apt|apk|yum|dnf|pacman)\s+(install|update|add)\b/.test(trimmed)) return "setup";
  if (/^(cargo\s+install|rustup|go\s+install|gem\s+install|brew\s+install)\b/.test(trimmed)) return "setup";
  if (/^(curl|wget)\s+/.test(trimmed) && /\b(install|setup|build|bootstrap|configure)\b|\.sh\b/.test(trimmed)) return "setup";

  // Build commands (gcc, make, cargo, etc.)
  if (/^(gcc|g\+\+|cc|clang|make|cargo\s+build|npm\s+run\s+build|tsc)\b/.test(trimmed)) return "build";
  
  // Compound build && run (gcc ... && ./a.out)
  if (/^(gcc|g\+\+|cc|clang)\b.*&&/.test(trimmed)) return "build";
  
  // Run commands: executing a binary directly
  if (/^(\.\/|time\s+\.\/|time\s+\/|timeout\s+\d+s?\s+\.\/|timeout\s+\d+s?\s+\/|\/app\/a\.out)/.test(trimmed)) return "run";
  
  // Write via heredoc: cat << 'EOF' > file
  // But if it's a diagnostic script, it's an investigation
  if (/<<\s*['"]?\w+['"]?/.test(trimmed) && />\s*\S+/.test(trimmed)) {
    // Only classify as "write" if clearly a solution/deliverable file
    if (/\.(c|h|rs|go|java|py|ts|js|sh)\s*$/.test(trimmed)) {
      // Exclude obviously diagnostic names
      if (!/(test|check|debug|tmp|probe|explore|temp)/i.test(trimmed)) {
        return "write";
      }
    }
    if (/\b(solution|main|submit|final|answer|Makefile|output\.txt|result\.txt|recovered_.*\.txt)\b/i.test(trimmed)) return "write";
    // All other heredoc scripts (Python helpers, shell scripts, etc.) are investigation
    return "investigate";
  }
  
  // Write via echo redirection
  if (/^echo\s.*>\s*\S+/.test(trimmed)) return "write";
  
  // Transform scripts: python3 <script>.py where script name suggests transformation
  if (/python3?\s+\S*(minif|compress|shrink|format|strip|uglif|compact|reduce)\S*\.py/.test(trimmed)) return "transform";
  
  return "investigate";
}

export async function buildKnownWorkingSetFingerprint(state: PluginState, worktree: string): Promise<string | null> {
  if (state.knownTrackedFiles.size === 0) return null;
  
  const hashes: string[] = [];
  for (const file of Array.from(state.knownTrackedFiles).sort()) {
    const record = state.fileHashes.get(file);
    if (record) {
      hashes.push(`${file}:${record.hash}`);
    }
  }
  
  if (hashes.length === 0) return null;
  return hashContent(hashes.join("\n"));
}

export function isTestCommand(cmd: string, patterns: string[]): boolean {
  const normalized = normalizeCommand(cmd);
  return patterns.some(p => normalized.toLowerCase().includes(p.toLowerCase()));
}

export async function extractTestTargets(
  cmd: string,
  worktree: string,
  matchesFn: (p: string) => boolean,
  state: PluginState
): Promise<Array<{ pathKey: string; hash: string }>> {
  const parts = cmd.split(/\s+/);
  const targets: Array<{ pathKey: string; hash: string }> = [];

  let foundSpecific = false;
  for (const part of parts) {
    // Clean part from quotes
    const cleanPart = part.replace(/['"]/g, "");
    
    // Check if it's a file that matches our patterns
    if (matchesFn(cleanPart)) {
      foundSpecific = true;
      const absPath = path.isAbsolute(cleanPart) ? cleanPart : path.join(worktree, cleanPart);
      try {
        const content = await readFile(absPath, "utf8");
        targets.push({
          pathKey: cleanPart,
          hash: hashContent(content),
        });
      } catch (e) {
        // Not a file or unreadable
      }
    }
  }

  if (!foundSpecific) {
    const fingerprint = await buildKnownWorkingSetFingerprint(state, worktree);
    if (fingerprint) {
      targets.push({
        pathKey: "global:*",
        hash: fingerprint
      });
    }
  }

  return targets;
}
