import { describe, it, expect, vi, beforeEach } from "vitest";
import { 
  normalizeCommand, 
  normalizeActionSignature,
  extractHeredocTargets, 
  isTestCommand, 
  extractTestTargets,
  buildKnownWorkingSetFingerprint,
  extractHeredocFileTargets,
  extractBashReadTargets,
  extractDescriptionKeywords,
  computePromptNovelty,
  classifyBashIntent
} from "../src/command.js";
import { createState } from "../src/state.js";
import { DEFAULT_OPTIONS } from "../src/config.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

vi.mock("node:fs/promises");
vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal() as typeof import("node:path");
  return {
    ...actual,
    default: {
      ...actual.default,
      isAbsolute: (p: string) => p.startsWith("/"),
      join: (...args: string[]) => args.join("/").replace(/\/+/g, "/"),
    }
  };
});

describe("command.ts", () => {
  describe("normalizeCommand", () => {
    it("hashes heredoc bodies with << EOF", () => {
      const cmd = "cat << EOF > file.c\nsome content\nEOF\ngcc file.c";
      // The current regex strips `> file.c` because it's on the same line as `<< EOF`, matching `cat << EOF > file.c` then everything to `EOF`
      // The old behavior is verified here:
      expect(normalizeCommand(cmd)).toMatch(/cat << EOF \[HEREDOC:[a-f0-9]{8}\] gcc file\.c/);
    });

    it("hashes heredoc bodies with << 'EOF'", () => {
      const cmd = "cat << 'EOF' > file.c\nsome content\nEOF\ngcc file.c";
      expect(normalizeCommand(cmd)).toMatch(/cat << 'EOF' \[HEREDOC:[a-f0-9]{8}\] gcc file\.c/);
    });

    it("hashes heredoc bodies with << \"EOF\"", () => {
      const cmd = "cat << \"EOF\" > file.c\nsome content\nEOF\ngcc file.c";
      expect(normalizeCommand(cmd)).toMatch(/cat << "EOF" \[HEREDOC:[a-f0-9]{8}\] gcc file\.c/);
    });

    it("normalizes incrementing numbers in filenames", () => {
      const cmd = "gcc file123.c && ./a.out";
      expect(normalizeCommand(cmd)).toBe("gcc file.c && ./a.out");
    });

    it("does not strip numbers from common binaries", () => {
      const cmd = "python3 script2.py && base64 file.txt";
      expect(normalizeCommand(cmd)).toBe("python3 script.py && base64 file.txt");
    });

    it("trims and collapses whitespace", () => {
      const cmd = "  gcc    file.c   &&   ./a.out  ";
      expect(normalizeCommand(cmd)).toBe("gcc file.c && ./a.out");
    });
  });

  describe("normalizeActionSignature", () => {
    it("normalizes incrementing numbers in file paths and agent names", () => {
      expect(normalizeActionSignature("write:/app/check_inf3.py")).toBe("write:/app/check_inf.py");
      expect(normalizeActionSignature("task:agent12")).toBe("task:agent");
    });
  });

  describe("extractHeredocTargets", () => {
    it("extracts targets from > target << EOF", () => {
      const cmd = "cat > file.c << EOF\ncontent\nEOF";
      expect(extractHeredocTargets(cmd)).toEqual(["file.c"]);
    });

    it("extracts targets from << EOF > target", () => {
      const cmd = "cat << EOF > file.c\ncontent\nEOF";
      expect(extractHeredocTargets(cmd)).toEqual(["file.c"]);
    });

    it("extracts multiple targets", () => {
      const cmd = "cat << EOF > file1.c\nEOF\ncat > file2.c << EOF\nEOF";
      expect(extractHeredocTargets(cmd)).toEqual(["file1.c", "file2.c"]);
    });

    it("returns empty array when no targets found", () => {
      expect(extractHeredocTargets("ls -la")).toEqual([]);
    });
  });

  describe("extractBashReadTargets", () => {
    it("extracts from simple cat", () => {
      expect(extractBashReadTargets("cat /path/to/file.c")).toEqual(["/path/to/file.c"]);
    });

    it("extracts from piped cat", () => {
      expect(extractBashReadTargets("cat /path/to/file.c | grep foo")).toEqual(["/path/to/file.c"]);
    });

    it("extracts from head", () => {
      expect(extractBashReadTargets("head -n 20 /path/to/file.c")).toEqual(["/path/to/file.c"]);
    });

    it("extracts from tail", () => {
      expect(extractBashReadTargets("tail -c 2000 /path/to/file.c")).toEqual(["/path/to/file.c"]);
    });

    it("extracts from grep", () => {
      expect(extractBashReadTargets("grep -rn \"pattern\" /path/to/file.c")).toEqual(["/path/to/file.c"]);
    });

    it("returns empty for no file", () => {
      expect(extractBashReadTargets("ls -la")).toEqual([]);
    });

    it("skips flags", () => {
      expect(extractBashReadTargets("grep -rn pattern -C 5 /path/to/file.c")).toEqual(["/path/to/file.c"]);
    });

    it("handles multiple files across different read commands", () => {
      expect(extractBashReadTargets("cat file1.c | grep foo; head -n 5 file2.c")).toEqual(["file1.c", "file2.c"]);
    });

    it("filters out /dev/null and numeric redirects like 2>/dev/null", () => {
      expect(extractBashReadTargets("grep -rn pattern /path/to/file.c 2>/dev/null")).toEqual(["/path/to/file.c"]);
      expect(extractBashReadTargets("grep \"foo\" /dev/null")).toEqual([]);
      expect(extractBashReadTargets("cat /path/to/file.c 1>/dev/stdout 2>/dev/stderr")).toEqual(["/path/to/file.c"]);
      expect(extractBashReadTargets("grep pattern file.txt > output.log")).toEqual(["file.txt"]);
    });

    it("does not capture heredoc delimiters as file targets", () => {
      expect(extractBashReadTargets("cat << 'EOF' > test_castling.py")).toEqual([]);
      expect(extractBashReadTargets("cat << EOF > solution.py\ncontent\nEOF")).toEqual([]);
      expect(extractBashReadTargets("cat << \"EOF\" > output.txt\ndata\nEOF")).toEqual([]);
    });

    it("does not capture heredoc delimiter-only commands", () => {
      expect(extractBashReadTargets("cat << 'EOF'\nbody\nEOF")).toEqual([]);
    });

    it("extracts real file targets after heredoc in compound commands", () => {
      expect(extractBashReadTargets("cat << 'EOF' > test.py\ncontent\nEOF\ncat test.py")).toEqual(["test.py"]);
    });
  });

  describe("isTestCommand", () => {
    it("returns true if command matches any pattern", () => {
      expect(isTestCommand("npm test", ["npm test", "pytest"])).toBe(true);
      expect(isTestCommand("pytest test.py", ["npm test", "pytest"])).toBe(true);
    });

    it("returns false if command doesn't match any pattern", () => {
      expect(isTestCommand("ls -la", ["npm test", "pytest"])).toBe(false);
    });

    it("is case-insensitive", () => {
      expect(isTestCommand("NPM TEST", ["npm test"])).toBe(true);
    });

    it("normalizes command before checking", () => {
      // "npm test" -> "npm test"
      expect(isTestCommand("npm   test", ["npm test"])).toBe(true);
    });
  });

  describe("buildKnownWorkingSetFingerprint", () => {
    it("returns null if no known tracked files", async () => {
      const state = createState({ ...DEFAULT_OPTIONS });
      expect(await buildKnownWorkingSetFingerprint(state, "/worktree")).toBeNull();
    });

    it("builds a fingerprint from tracked files", async () => {
      const state = createState({ ...DEFAULT_OPTIONS });
      state.knownTrackedFiles.add("file1.c");
      state.knownTrackedFiles.add("file2.c");
      state.fileHashes.set("file1.c", { hash: "hash1", lastUpdatedAt: 0, source: "write" });
      state.fileHashes.set("file2.c", { hash: "hash2", lastUpdatedAt: 0, source: "write" });

      const fp = await buildKnownWorkingSetFingerprint(state, "/worktree");
      expect(fp).toBeTypeOf("string");
      expect(fp?.length).toBeGreaterThan(0);
    });

    it("ignores tracked files without a hash record", async () => {
      const state = createState({ ...DEFAULT_OPTIONS });
      state.knownTrackedFiles.add("file1.c");
      state.fileHashes.set("file1.c", { hash: "hash1", lastUpdatedAt: 0, source: "write" });
      
      state.knownTrackedFiles.add("file2.c");
      // No hash record for file2.c

      const fp1 = await buildKnownWorkingSetFingerprint(state, "/worktree");

      const state2 = createState({ ...DEFAULT_OPTIONS });
      state2.knownTrackedFiles.add("file1.c");
      state2.fileHashes.set("file1.c", { hash: "hash1", lastUpdatedAt: 0, source: "write" });
      
      const fp2 = await buildKnownWorkingSetFingerprint(state2, "/worktree");
      
      expect(fp1).toBe(fp2);
    });
  });

  describe("extractTestTargets", () => {
    const matchesAll = () => true;
    
    beforeEach(() => {
      vi.resetAllMocks();
    });

    it("extracts specific file targets", async () => {
      const state = createState({ ...DEFAULT_OPTIONS });
      vi.mocked(fs.readFile).mockResolvedValue("file content");
      
      const targets = await extractTestTargets("pytest test.py", "/worktree", matchesAll, state);
      
      expect(targets.length).toBeGreaterThan(0);
      expect(targets.some(t => t.pathKey === "test.py" || t.pathKey === "pytest")).toBe(true);
    });

    it("ignores files that throw on read", async () => {
      const state = createState({ ...DEFAULT_OPTIONS });
      vi.mocked(fs.readFile).mockRejectedValue(new Error("File not found"));
      
      const targets = await extractTestTargets("pytest", "/worktree", matchesAll, state);
      
      // If we can't read any specific files, it should fallback to global fingerprint
      expect(targets).toEqual([]);
    });

    it("falls back to global fingerprint if no specific targets found", async () => {
      const state = createState({ ...DEFAULT_OPTIONS });
      state.knownTrackedFiles.add("file1.c");
      state.fileHashes.set("file1.c", { hash: "hash1", lastUpdatedAt: 0, source: "write" });
      
      const matchesNone = () => false;
      
      const targets = await extractTestTargets("pytest", "/worktree", matchesNone, state);
      
      expect(targets.length).toBe(1);
      expect(targets[0].pathKey).toBe("global:*");
      expect(targets[0].hash).toBeTypeOf("string");
    });
  });

  describe("extractHeredocFileTargets", () => {
    it("extracts Python open() targets from heredoc body", () => {
      const cmd = `cat << 'EOF' > check_layout.py
import numpy as np
weights = np.fromfile('gpt2-124M.ckpt', dtype=np.float32)
with open('vocab.bpe', 'r') as f:
    lines = f.read()
EOF
python check_layout.py`;
      expect(extractHeredocFileTargets(cmd)).toEqual(["gpt2-124M.ckpt", "vocab.bpe"]);
    });

    it("extracts C fopen() targets from heredoc body", () => {
      const cmd = `cat << 'EOF' > gpt2.c
FILE* f = fopen(argv[1], "rb");
FILE* bpe = fopen("vocab.bpe", "r");
EOF
gcc gpt2.c`;
      expect(extractHeredocFileTargets(cmd)).toEqual(["vocab.bpe"]);
    });

    it("extracts np.fromfile targets", () => {
      const cmd = `cat << 'EOF' > check.py
data = np.fromfile("model.ckpt", dtype=np.float32)
EOF`;
      expect(extractHeredocFileTargets(cmd)).toEqual(["model.ckpt"]);
    });

    it("returns empty array when no file targets found", () => {
      expect(extractHeredocFileTargets("ls -la")).toEqual([]);
    });

    it("deduplicates and sorts targets", () => {
      const cmd = `cat << 'EOF' > check.py
f = open('data.bin', 'rb')
g = open('data.bin', 'rb')
h = open('other.txt', 'r')
EOF`;
      expect(extractHeredocFileTargets(cmd)).toEqual(["data.bin", "other.txt"]);
    });

    it("extracts from np.fromfile in a complex command", () => {
      const cmd = "cat << 'EOF' > check_weights1.py\nweights = np.fromfile('gpt2-124M.ckpt', dtype=np.float32)\nEOF\npython3 check_weights1.py";
      expect(extractHeredocFileTargets(cmd)).toEqual(["gpt2-124M.ckpt"]);
    });

    it("ignores argv references (dynamic paths)", () => {
      const cmd = `cat << 'EOF' > gpt2.c
FILE* f = fopen(argv[1], "rb");
EOF`;
      expect(extractHeredocFileTargets(cmd)).toEqual([]);
    });
  });

  describe("extractDescriptionKeywords", () => {
    it("extracts and normalizes keywords from description", () => {
      expect(extractDescriptionKeywords("Check the layout of the weights")).toEqual(
        "check layout weights"
      );
    });

    it("produces similar output for semantically similar descriptions", () => {
      const a = extractDescriptionKeywords("Check the layout of the weights");
      const b = extractDescriptionKeywords("Check if weights follow HuggingFace layout");
      // Both contain "check", "layout", "weights"
      const aWords = a.split(" ");
      const bWords = b.split(" ");
      expect(aWords.filter(w => bWords.includes(w)).length).toBeGreaterThanOrEqual(3);
    });

    it("strips common filler words", () => {
      expect(extractDescriptionKeywords("Check if the header is actually floats")).toEqual(
        "check floats header"
      );
    });

    it("lowercases everything", () => {
      expect(extractDescriptionKeywords("COMPILE AND RUN")).toEqual("compile run");
    });

    it("returns empty string for undefined/empty input", () => {
      expect(extractDescriptionKeywords("")).toEqual("");
      expect(extractDescriptionKeywords(undefined as any)).toEqual("");
    });

    it("sorts keywords for stable comparison", () => {
      const a = extractDescriptionKeywords("weights layout check");
      const b = extractDescriptionKeywords("check layout weights");
      expect(a).toEqual(b);
    });
  });

  describe("classifyBashIntent", () => {
    it("identifies pip install as setup", () => {
      expect(classifyBashIntent("pip install torch")).toBe("setup");
      expect(classifyBashIntent("python3 -m pip install transformers")).toBe("setup");
    });

    it("identifies npm/yarn install as setup", () => {
      expect(classifyBashIntent("npm install")).toBe("setup");
      expect(classifyBashIntent("yarn add express")).toBe("setup");
      expect(classifyBashIntent("pnpm i")).toBe("setup");
    });

    it("identifies apt install as setup", () => {
      expect(classifyBashIntent("apt-get install -y git")).toBe("setup");
      expect(classifyBashIntent("apk add curl")).toBe("setup");
    });

    it("identifies cargo install as setup", () => {
      expect(classifyBashIntent("cargo install ripgrep")).toBe("setup");
    });

    it("identifies install scripts via curl/wget as setup", () => {
      expect(classifyBashIntent("curl -fsSL https://example.com/install.sh | bash")).toBe("setup");
      expect(classifyBashIntent("wget https://example.com/setup.sh")).toBe("setup");
    });

    it("identifies non-install pip commands as investigate", () => {
      expect(classifyBashIntent("pip list")).toBe("investigate");
      expect(classifyBashIntent("pip show torch")).toBe("investigate");
    });

    it("identifies builds as build", () => {
      expect(classifyBashIntent("gcc main.c")).toBe("build");
      expect(classifyBashIntent("make")).toBe("build");
    });
  });

  describe("computePromptNovelty", () => {
    it("returns 0.0 for identical prompts", () => {
      expect(computePromptNovelty("Write GPT-2 in C", "Write GPT-2 in C")).toBe(0);
    });

    it("returns high novelty for substantially different prompts", () => {
      const prev = "Write GPT-2 in C. Implement tokenizer and forward pass.";
      const next = "Write GPT-2 in C. The checkpoint has NO header. Weights are float32 in HuggingFace per-layer order. Use x @ W with shape (in, out).";
      expect(computePromptNovelty(prev, next)).toBeGreaterThan(0.3);
    });

    it("returns low novelty for minor rephrasing", () => {
      const prev = "Write GPT-2 in C. Implement the tokenizer.";
      const next = "Write GPT-2 in C. Implement the BPE tokenizer.";
      expect(computePromptNovelty(prev, next)).toBeLessThan(0.3);
    });
  });
});
