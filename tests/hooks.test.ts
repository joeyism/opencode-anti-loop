import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHooks } from "../src/hooks.js";
import { createState } from "../src/state.js";
import { DEFAULT_OPTIONS } from "../src/config.js";
import * as commandModule from "../src/command.js";

describe("hooks.ts", () => {
  let state: any;
  let hooks: any;
  let ctx: any;

  beforeEach(() => {
    state = createState({ ...DEFAULT_OPTIONS });
    ctx = {
      worktree: "/mock",
      client: {
        session: {
          summarize: vi.fn().mockResolvedValue(undefined),
        },
      },
    };
    hooks = createHooks(ctx, state);
  });

  const runToolBefore = async (tool: string, args: Record<string, any>, sessionID = "test-session") => {
    return hooks["tool.execute.before"]({ tool, sessionID, callID: "call-1" }, { args });
  };

  describe("write and edit tools", () => {
    it("handles write correctly", async () => {
      const input = { tool: "write" };
      await hooks["tool.execute.before"](input, { args: { filePath: "file.c", content: "foo" } });
      await hooks["tool.execute.after"](input, { ok: true });
      expect(state.mutationEpoch).toBe(1);
      expect(state.fileHashes.get("file.c")).toBeDefined();
    });

    it("handles write with error", async () => {
      const input = { tool: "write" };
      await hooks["tool.execute.before"](input, { args: { filePath: "file.c", content: "foo" } });
      await hooks["tool.execute.after"](input, { error: new Error("failed") });
      expect(state.mutationEpoch).toBe(0); // Should not have incremented
    });

    it("handles edit correctly", async () => {
      const input = { tool: "edit" };
      await hooks["tool.execute.before"](input, { args: { path: "file.c", newString: "foo" } });
      await hooks["tool.execute.after"](input, { ok: true });
      expect(state.mutationEpoch).toBe(1);
    });

    it("handles tool.execute.before with empty args for write", async () => {
       const input = { tool: "write" };
       await hooks["tool.execute.before"](input, { args: {} });
       await hooks["tool.execute.after"](input, { ok: true });
       expect(state.mutationEpoch).toBe(0);
    });
  });

  describe("bash tool", () => {
    it("fires exploration sprawl after maxStepsWithoutFirstWrite bash calls without any write", async () => {
      state.options.maxStepsWithoutFirstWrite = 3;

      await runToolBefore("bash", { command: "ls -la", description: "list files" });
      await runToolBefore("bash", { command: "npm search foo", description: "search packages" });
      await runToolBefore("bash", { command: "which python", description: "locate python" });

      await expect(
        runToolBefore("bash", { command: "pwd", description: "check path" })
      ).rejects.toThrow(/EXPLORATION SPRAWL/);
    });

    it("resets sprawl counter when a write mutation occurs", async () => {
      state.options.maxStepsWithoutFirstWrite = 3;

      await runToolBefore("bash", { command: "ls -la", description: "list files" });
      await runToolBefore("bash", { command: "npm search foo", description: "search packages" });
      await runToolBefore("bash", {
        command: "cat << 'EOF' > /app/solution.py\nprint(\"hello\")\nEOF",
        description: "write solution",
      });

      await runToolBefore("bash", { command: "which python", description: "locate python" });
      await runToolBefore("bash", { command: "pwd", description: "check path" });
      expect(state.stepsSinceLastWrite).toBe(2);
    });

    it("does not fire exploration sprawl for npm install (setup) commands", async () => {
      state.options.maxStepsWithoutFirstWrite = 3;

      await runToolBefore("bash", { command: "npm install foo", description: "setup deps" });
      await runToolBefore("bash", { command: "npm install bar", description: "setup deps" });
      await runToolBefore("bash", { command: "apt-get install -y python3", description: "setup deps" });

      await expect(
        runToolBefore("bash", { command: "npm install baz", description: "setup deps" })
      ).resolves.toBeUndefined();
    });

    it("skill tool calls don't increment sprawl counter", async () => {
      state.options.maxStepsWithoutFirstWrite = 3;

      for (let i = 0; i < 5; i++) {
        await runToolBefore("skill", { name: "defensive-execution" });
      }

      await runToolBefore("bash", { command: "ls -la", description: "list files" });
      expect(state.stepsSinceLastWrite).toBe(1);
    });

    it("ignores empty commands", async () => {
      const input = { tool: "bash", sessionID: "session-1" };
      await hooks["tool.execute.before"](input, { args: { command: "" } });
      // Should not throw and should not track anything
      await hooks["tool.execute.after"](input, { ok: true });
      expect(state.mutationEpoch).toBe(0);
    });

    it("detects interleaved write and timeout loop", async () => {
      const cmd = "gcc file.c && ./a.out";
      const heredoc1 = `cat << 'EOF' > file.c\nEOF\n${cmd}`;
      const heredoc2 = `cat << 'EOF' > file.c\nEOF\n${cmd}`;
      const heredoc3 = `cat << 'EOF' > file.c\nEOF\n${cmd}`;
      
      // Attempt 1: write file.c, run gcc, timeout
      const input1 = { tool: "bash" };
      await hooks["tool.execute.before"](input1, { args: { command: heredoc1 } });
      await hooks["tool.execute.after"](input1, { 
        output: "timeout exceeding timeout 120000 ms",
        ok: false
      });

      // Attempt 2: write file.c again (increments epoch), run gcc, timeout
      const input2 = { tool: "bash" };
      await hooks["tool.execute.before"](input2, { args: { command: `cat << 'EOF' > solution.c\nint main() {}\nEOF`, description: "write solution" } });
      await hooks["tool.execute.after"](input2, { output: "ok", ok: true });

      expect(state.stepsSinceLastWrite).toBe(0); // RESET
    });

    it("prevents semantic loops for bash heredocs based on both description AND content", async () => {
      state.options.maxSemanticCycleRepeats = 3;
      state.options.maxStepsWithoutFirstWrite = 100;
      const desc = "Identical description";
      
      // 1. Different content should NOT trigger even if same description
      for (let i = 0; i < 5; i++) {
        const cmd = `cat << 'EOF' > test.py\nprint('version', ${i})\nEOF`;
        const input = { tool: "bash", sessionID: "s1" };
        await hooks["tool.execute.before"](input, { args: { command: cmd, description: desc } });
        await hooks["tool.execute.after"](input, { output: `out ${i}`, ok: true });
      }

      // 2. Identical content in a cycle SHOULD trigger
      state.actionHistory = []; // Reset history to focus on the cycle
      const cmdA = "cat << 'EOF' > test.py\nprint('A')\nEOF";
      const cmdB = "cat << 'EOF' > test.py\nprint('B')\nEOF";
      const cycleDesc = "Cycle test";

      // Step 1: A, B
      await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s1" }, { args: { command: cmdA, description: cycleDesc } });
      await hooks["tool.execute.after"]({ tool: "bash", sessionID: "s1" }, { output: "a1", ok: true });
      await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s1" }, { args: { command: cmdB, description: cycleDesc } });
      await hooks["tool.execute.after"]({ tool: "bash", sessionID: "s1" }, { output: "b1", ok: true });

      // Step 2: A, B
      await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s1" }, { args: { command: cmdA, description: cycleDesc } });
      await hooks["tool.execute.after"]({ tool: "bash", sessionID: "s1" }, { output: "a2", ok: true });
      await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s1" }, { args: { command: cmdB, description: cycleDesc } });
      await hooks["tool.execute.after"]({ tool: "bash", sessionID: "s1" }, { output: "b2", ok: true });

      // Step 3: A, B (B should trigger)
      await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s1" }, { args: { command: cmdA, description: cycleDesc } });
      await hooks["tool.execute.after"]({ tool: "bash", sessionID: "s1" }, { output: "a3", ok: true });

      await expect(
        hooks["tool.execute.before"]({ tool: "bash", sessionID: "s1" }, { args: { command: cmdB, description: cycleDesc } })
      ).rejects.toThrow(/LOOP DETECTED|ANTI-LOOP/);
    });

    it("blocks read-only bash commands targeting the same file via maxSameFileInvestigations", async () => {
      state.options.maxSameFileInvestigations = 3;

      for (let i = 0; i < 3; i++) {
        const input = { tool: "bash", sessionID: "session-1" };
        await hooks["tool.execute.before"](input, { args: { command: `cat /path/to/file.c | grep foo${i}` } });
        await hooks["tool.execute.after"](input, { ok: true });
      }

      const input = { tool: "bash", sessionID: "session-1" };
      await expect(
        hooks["tool.execute.before"](input, { args: { command: `cat /path/to/file.c | grep bar` } })
      ).rejects.toThrow("INVESTIGATION LOOP DETECTED");
    });

    it("blocks bash heredoc commands after maxSameFileInvestigations scripts targeting the same file and topic", async () => {
      state.options.maxSameFileInvestigations = 3;
      const commands = [
        { cmd: `cat << 'EOF' > check_weights1.py\nweights = np.fromfile('gpt2-124M.ckpt', dtype=np.float32)\nEOF\npython3 check_weights1.py`, desc: "Check weights" },
        { cmd: `cat << 'EOF' > test_hf2.py\nweights = np.fromfile('gpt2-124M.ckpt', dtype=np.float32)\nEOF\npython3 test_hf2.py`, desc: "Check weights" },
        { cmd: `cat << 'EOF' > test_forward_hf_layout3.py\nweights = np.fromfile('gpt2-124M.ckpt', dtype=np.float32)\nEOF\npython3 test_forward_hf_layout3.py`, desc: "Check weights" },
        { cmd: `cat << 'EOF' > test_hf_forward_debug4.py\nweights = np.fromfile('gpt2-124M.ckpt', dtype=np.float32)\nEOF\npython3 test_hf_forward_debug4.py`, desc: "Check weights" },
      ];

      for (const [index, entry] of commands.entries()) {
        const input = { tool: "bash", sessionID: "session-1" };
        if (index < 3) {
          await hooks["tool.execute.before"](input, { args: { command: entry.cmd, description: entry.desc } });
          await hooks["tool.execute.after"](input, { output: "ok", ok: true });
        } else {
          await expect(
            hooks["tool.execute.before"](input, { args: { command: entry.cmd, description: entry.desc } })
          ).rejects.toThrow("INVESTIGATION LOOP DETECTED");
        }
      }
    });

    it("does not count file targets from write-intent heredoc scripts toward investigation limits", async () => {
      state.options.maxSameFileInvestigations = 2;

      // These scripts GENERATE re.json (write intent) — they should NOT count as investigations
      for (let i = 0; i < 5; i++) {
        const cmd = `cat << 'EOF' > /app/gen${i}.py\nimport json\ndata = json.load(open('/app/data.json'))\njson.dump(data, open('/app/re.json', 'w'))\nEOF\npython3 /app/gen${i}.py`;
        const input = { tool: "bash", sessionID: "s1" };
        await hooks["tool.execute.before"](input, { args: { command: cmd, description: "Generate regex file" } });
        await hooks["tool.execute.after"](input, { output: `ok-${i}`, ok: true });
      }

      // Should NOT have thrown — write intent scripts don't count as investigations
      // Now verify that an investigate-intent script DOES count
      const checkCmd = `cat << 'EOF' > /app/check_data.py\nimport json\ndata = json.load(open('/app/data.json'))\nprint(len(data))\nEOF\npython3 /app/check_data.py`;
      const input1 = { tool: "bash", sessionID: "s1" };
      await hooks["tool.execute.before"](input1, { args: { command: checkCmd, description: "Check data" } });
      await hooks["tool.execute.after"](input1, { output: "count-1", ok: true });

      const input2 = { tool: "bash", sessionID: "s1" };
      await hooks["tool.execute.before"](input2, { args: { command: checkCmd, description: "Check data" } });
      await hooks["tool.execute.after"](input2, { output: "count-2", ok: true });

      // Third investigate-intent script should trigger the limit
      const input3 = { tool: "bash", sessionID: "s1" };
      await expect(
        hooks["tool.execute.before"](input3, { args: { command: checkCmd, description: "Check data" } })
      ).rejects.toThrow("INVESTIGATION LOOP DETECTED");
    });

    it("does not block heredoc commands targeting different files", async () => {
      state.options.maxSameFileInvestigations = 2;

      const input1 = { tool: "bash" };
      await hooks["tool.execute.before"](input1, { args: { command: `cat << 'EOF' > check_a.py\nopen('a.txt').read()\nEOF`, description: "check a" } });
      await hooks["tool.execute.after"](input1, { output: "ok", ok: true });

      const input2 = { tool: "bash" };
      await hooks["tool.execute.before"](input2, { args: { command: `cat << 'EOF' > check_b.py\nopen('b.txt').read()\nEOF`, description: "check b" } });
      await hooks["tool.execute.after"](input2, { output: "ok", ok: true });
    });

    it("blocks after threshold even when descriptions vary (global cap)", async () => {
      state.options.maxSameFileInvestigations = 2; // global cap = 4
      const commands = [
        { cmd: `cat << 'EOF' > check_weights1.py\nweights = np.fromfile('gpt2-124M.ckpt', dtype=np.float32)\nEOF\npython3 check_weights1.py`, desc: "Variance analysis" },
        { cmd: `cat << 'EOF' > test_hf2.py\nweights = np.fromfile('gpt2-124M.ckpt', dtype=np.float32)\nEOF\npython3 test_hf2.py`, desc: "Mean calculation" },
        { cmd: `cat << 'EOF' > test_forward3.py\nweights = np.fromfile('gpt2-124M.ckpt', dtype=np.float32)\nEOF\npython3 test_forward3.py`, desc: "Forward pass" },
        { cmd: `cat << 'EOF' > test_debug4.py\nweights = np.fromfile('gpt2-124M.ckpt', dtype=np.float32)\nEOF\npython3 test_debug4.py`, desc: "Logit comparison" },
        { cmd: `cat << 'EOF' > final_probe.py\nweights = np.fromfile('gpt2-124M.ckpt', dtype=np.float32)\nEOF\npython3 final_probe.py`, desc: "Final validation" },
      ];

      for (const [index, entry] of commands.entries()) {
        const input = { tool: "bash", sessionID: "session-1" };
        if (index < 4) {
          await hooks["tool.execute.before"](input, { args: { command: entry.cmd, description: entry.desc } });
          await hooks["tool.execute.after"](input, { output: "ok", ok: true });
        } else {
          await expect(
            hooks["tool.execute.before"](input, { args: { command: entry.cmd, description: entry.desc } })
          ).rejects.toThrow("INVESTIGATION LOOP DETECTED");
        }
      }
    });

    it("does not block same file with different topics under global cap", async () => {
      state.options.maxSameFileInvestigations = 3; // global cap = 6
      const commands = [
        { cmd: `cat << 'EOF' > c1.py\nopen('d.bin').read()\nEOF`, desc: "Topic A" },
        { cmd: `cat << 'EOF' > c2.py\nopen('d.bin').read()\nEOF`, desc: "Topic B" },
        { cmd: `cat << 'EOF' > c3.py\nopen('d.bin').read()\nEOF`, desc: "Topic C" },
      ];

      for (const entry of commands) {
        const input = { tool: "bash", sessionID: "s1" };
        await hooks["tool.execute.before"](input, { args: { command: entry.cmd, description: entry.desc } });
        await hooks["tool.execute.after"](input, { output: "ok", ok: true });
      }
      // Should not have thrown
    });

  });

  describe("Action Cycle Detector", () => {
    beforeEach(() => {
      state.options.maxRepeatedCommands = 10;
      state.options.maxCyclicalActionRepeats = 4;
    });
    it("allows a normal TDD cycle without throwing", async () => {
      // Sequence: edit -> bash -> edit -> bash -> edit -> bash (L=2, 3 times)
      // This is UNDER the threshold of maxCyclicalActionRepeats=6
      for (let i = 0; i < 3; i++) {
        const editInput = { tool: "edit" };
        await hooks["tool.execute.before"](editInput, { args: { filePath: "f.c" } });
        await hooks["tool.execute.after"](editInput, { ok: true });

        const bashInput = { tool: "bash" };
        await hooks["tool.execute.before"](bashInput, { args: { command: "gcc f.c" } });
        await hooks["tool.execute.after"](bashInput, { output: "ok", ok: true });
      }
    });

    it("throws when a cycle hits the maximum threshold", async () => {
      state.options.maxCyclicalActionRepeats = 4;
      // Do it 3 times (triggers advisory in after hook, but doesn't block)
      for (let i = 0; i < 3; i++) {
        const editInput = { tool: "edit" };
        await hooks["tool.execute.before"](editInput, { args: { filePath: "f.c", content: "same" } });
        await hooks["tool.execute.after"](editInput, { ok: true, output: "Wrote" });

        const bashInput = { tool: "bash" };
        await hooks["tool.execute.before"](bashInput, { args: { command: "gcc f.c" } });
        await hooks["tool.execute.after"](bashInput, { output: "ok", ok: true });
      }

      // The 4th iteration of the cycle:
      // edit4 is action 7. Cycle L=2, count 4 needs 8 actions to throw.
      // So edit4 will trigger an ADVISORY, not a throw.
      const editInput4 = { tool: "edit" };
      await hooks["tool.execute.before"](editInput4, { args: { filePath: "f.c", content: "same" } });
      await hooks["tool.execute.after"](editInput4, { ok: true, output: "Wrote" });

      // bash4 is action 8. This completes the 4th cycle and should THROW.
      const bashInput4 = { tool: "bash" };
      await expect(
        hooks["tool.execute.before"](bashInput4, { args: { command: "gcc f.c" } })
      ).rejects.toThrow("SYSTEM OVERRIDE: ANTI-LOOP DETECTED");
    });

    it("appends an advisory note to output when approaching the limit", async () => {
      state.options.maxCyclicalActionRepeats = 4;
      
      // Run 2 identical writes
      for (let i = 0; i < 2; i++) {
        const editInput = { tool: "edit" };
        await hooks["tool.execute.before"](editInput, { args: { filePath: "f.c", content: "same" } });
        await hooks["tool.execute.after"](editInput, { ok: true, output: "Wrote" });
      }

      // 3rd write. With threshold 4, advisory triggers at count 3 (max - 1).
      // Since L=1, this is action 3.
      const editInput3 = { tool: "edit" };
      const output = { ok: true, output: "Wrote file" };
      await hooks["tool.execute.before"](editInput3, { args: { filePath: "f.c", content: "same" } });
      await hooks["tool.execute.after"](editInput3, output);

      expect(output.output).toContain("[Anti-Loop Advisory]");
      expect(output.output).toContain("repeated the same action pattern 3 times");
    });

    it("throws when a cycle hits the maximum threshold", async () => {
      // Do it 3 times (fine)
      for (let i = 0; i < 3; i++) {
        const editInput = { tool: "edit" };
        await hooks["tool.execute.before"](editInput, { args: { filePath: "f.c" } });
        await hooks["tool.execute.after"](editInput, { ok: true });

        const bashInput = { tool: "bash" };
        await hooks["tool.execute.before"](bashInput, { args: { command: "gcc f.c" } });
        await hooks["tool.execute.after"](bashInput, { output: "ok", ok: true });
      }

      // 4th time: the edit is the 4th start of the cycle, wait, let's see when it triggers.
      // After edit -> bash -> edit -> bash -> edit -> bash (6 items, length 2 repeating 3 times)
      // Next edit is 7 items. The pattern [edit, bash] doesn't repeat 4 times yet.
      // We need to add `edit` then `bash`. The `bash` will be the 8th item, and the cycle length is 2, repeating 4 times.
      const editInput = { tool: "edit" };
      await hooks["tool.execute.before"](editInput, { args: { filePath: "f.c" } });
      await hooks["tool.execute.after"](editInput, { ok: true });

      const bashInput = { tool: "bash" };
      await expect(
        hooks["tool.execute.before"](bashInput, { args: { command: "gcc f.c" } })
      ).rejects.toThrow("SYSTEM OVERRIDE: ANTI-LOOP DETECTED");
    });

    it("detects complex interleaved cycles", async () => {
      // Cycle: curl -> curl -> edit -> bash (L=4)
      for (let i = 0; i < 3; i++) {
        const curl1 = { tool: "bash" };
        await hooks["tool.execute.before"](curl1, { args: { command: "curl A" } });
        await hooks["tool.execute.after"](curl1, { output: "A", ok: true });

        const curl2 = { tool: "bash" };
        await hooks["tool.execute.before"](curl2, { args: { command: "curl B" } });
        await hooks["tool.execute.after"](curl2, { output: "B", ok: true });

        const editInput = { tool: "edit" };
        await hooks["tool.execute.before"](editInput, { args: { filePath: "f.c" } });
        await hooks["tool.execute.after"](editInput, { ok: true });

        const bashInput = { tool: "bash" };
        await hooks["tool.execute.before"](bashInput, { args: { command: "gcc f.c" } });
        await hooks["tool.execute.after"](bashInput, { output: "ok", ok: true });
      }

      // 4th cycle start
      const curl1 = { tool: "bash" };
      await hooks["tool.execute.before"](curl1, { args: { command: "curl A" } });
      await hooks["tool.execute.after"](curl1, { output: "A", ok: true });

      const curl2 = { tool: "bash" };
      await hooks["tool.execute.before"](curl2, { args: { command: "curl B" } });
      await hooks["tool.execute.after"](curl2, { output: "B", ok: true });

      const editInput = { tool: "edit" };
      await hooks["tool.execute.before"](editInput, { args: { filePath: "f.c" } });
      await hooks["tool.execute.after"](editInput, { ok: true });

      const bashInput = { tool: "bash" };
      await expect(
        hooks["tool.execute.before"](bashInput, { args: { command: "gcc f.c" } })
      ).rejects.toThrow("SYSTEM OVERRIDE: ANTI-LOOP DETECTED");
    });

    it("fuzzily matches incremented file paths when outputs match AND content is identical", async () => {
      // With contentHash differentiation: different write content = different action = no cycle
      // This test verifies that when content IS identical (same hash), the cycle is still caught
      state.options.maxCyclicalActionRepeats = 3;
      const input1 = { tool: "write" };
      await hooks["tool.execute.before"](input1, { args: { filePath: "check_inf3.py", content: "a" } });
      await hooks["tool.execute.after"](input1, { ok: true });

      const input2 = { tool: "bash" };
      await hooks["tool.execute.before"](input2, { args: { command: "python check_inf3.py" } });
      await hooks["tool.execute.after"](input2, { output: "same", ok: true });

      const input3 = { tool: "write" };
      await hooks["tool.execute.before"](input3, { args: { filePath: "check_inf4.py", content: "a" } }); // same content
      await hooks["tool.execute.after"](input3, { ok: true });

      const input4 = { tool: "bash" };
      await hooks["tool.execute.before"](input4, { args: { command: "python check_inf4.py" } });
      await hooks["tool.execute.after"](input4, { output: "same", ok: true });

      const input5 = { tool: "write" };
      await hooks["tool.execute.before"](input5, { args: { filePath: "check_inf5.py", content: "a" } }); // same content
      await hooks["tool.execute.after"](input5, { ok: true });

      const input6 = { tool: "bash" };
      await expect(
        hooks["tool.execute.before"](input6, { args: { command: "python check_inf5.py" } })
      ).rejects.toThrow("SYSTEM OVERRIDE: ANTI-LOOP DETECTED");

      const input7 = { tool: "write" };
      await expect(
        hooks["tool.execute.before"](input7, { args: { filePath: "check_inf6.py", content: "a" } }) // same content
      ).rejects.toThrow("SYSTEM OVERRIDE: ANTI-LOOP DETECTED");
    });

    it("does NOT cycle when different files have DIFFERENT content (even with same output)", async () => {
      // Different write content → different contentHash → different action → no cycle
      // This is the CoreWars scenario: writing 4 different warriors to my_warrior.red
      // Note: use a non-test bash command to avoid triggering checkAndRecordTestRun on global:*
      state.options.maxCyclicalActionRepeats = 3;
      const input1 = { tool: "write" };
      await hooks["tool.execute.before"](input1, { args: { filePath: "my_warrior.red", content: "; Silk" } });
      await hooks["tool.execute.after"](input1, { ok: true });

      const input2 = { tool: "bash" };
      await hooks["tool.execute.before"](input2, { args: { command: "cat my_warrior.red | head -1" } });
      await hooks["tool.execute.after"](input2, { output: "; Silk", ok: true });

      const input3 = { tool: "write" };
      await hooks["tool.execute.before"](input3, { args: { filePath: "my_warrior.red", content: "; Q-Silk" } }); // different content
      await hooks["tool.execute.after"](input3, { ok: true });

      const input4 = { tool: "bash" };
      await hooks["tool.execute.before"](input4, { args: { command: "cat my_warrior.red | head -1" } });
      await hooks["tool.execute.after"](input4, { output: "; Q-Silk", ok: true });

      const input5 = { tool: "write" };
      await hooks["tool.execute.before"](input5, { args: { filePath: "my_warrior.red", content: "; P-Space" } }); // different content
      await hooks["tool.execute.after"](input5, { ok: true });

      const input6 = { tool: "bash" };
      // Should NOT trigger cycle — different content makes each write a different action
      const input6Result = hooks["tool.execute.before"](input6, { args: { command: "cat my_warrior.red | head -1" } });
      await expect(input6Result).resolves.not.toThrow();
    });

    it("does not trigger when normalized actions repeat with different outputs", async () => {
      const input1 = { tool: "write" };
      await hooks["tool.execute.before"](input1, { args: { filePath: "check_inf3.py", content: "a" } });
      await hooks["tool.execute.after"](input1, { ok: true });

      const input2 = { tool: "bash" };
      await hooks["tool.execute.before"](input2, { args: { command: "python check_inf3.py" } });
      await hooks["tool.execute.after"](input2, { output: "out1", ok: true });

      const input3 = { tool: "write" };
      await hooks["tool.execute.before"](input3, { args: { filePath: "check_inf4.py", content: "b" } });
      await hooks["tool.execute.after"](input3, { ok: true });

      const input4 = { tool: "bash" };
      await hooks["tool.execute.before"](input4, { args: { command: "python check_inf4.py" } });
      await hooks["tool.execute.after"](input4, { output: "out2", ok: true });

      expect(state.actionHistory.every((record: any) => record.normalizedSignature)).toBe(true);
    });
  });

  describe("Semantic fingerprinting integration", () => {
    beforeEach(() => {
      state = createState({
        ...DEFAULT_OPTIONS,
        maxCyclicalActionRepeats: 10, // high so exact-match doesn't trigger
        maxSemanticCycleRepeats: 3,
        maxSameFileInvestigations: 2,
      });
      hooks = createHooks(ctx, state);
    });

    it("catches differently-named scripts investigating the same file with same keywords", async () => {
      // Script 1: check_layout.py reads gpt2-124M.ckpt
      const heredoc1 = `cat << 'EOF' > check_layout.py
import numpy as np
data = np.fromfile('gpt2-124M.ckpt', dtype=np.float32)
print(data[:8])
EOF
python check_layout.py`;

      const input1 = { tool: "bash" };
      await hooks["tool.execute.before"](input1, { args: { command: heredoc1, description: "Check weights layout" } });
      await hooks["tool.execute.after"](input1, { output: "0.48 -0.52", ok: true });

      // Script 2: check_hf_layout.py reads gpt2-124M.ckpt
      const heredoc2 = `cat << 'EOF' > check_hf_layout.py
import numpy as np
data = np.fromfile('gpt2-124M.ckpt', dtype=np.float32)
print(data.reshape(50257, 768)[:2])
EOF
python check_hf_layout.py`;

      const input2 = { tool: "bash" };
      await hooks["tool.execute.before"](input2, { args: { command: heredoc2, description: "Check weights layout" } });
      await hooks["tool.execute.after"](input2, { output: "0.48 -0.52", ok: true });

      // Script 3: check_llmc_layout.py reads gpt2-124M.ckpt
      const heredoc3 = `cat << 'EOF' > check_llmc_layout.py
import numpy as np
data = np.fromfile('gpt2-124M.ckpt', dtype=np.float32)
print(data[:256])
EOF
python check_llmc_layout.py`;

      const input3 = { tool: "bash" };
      await expect(
        hooks["tool.execute.before"](input3, { args: { command: heredoc3, description: "Check weights layout" } })
      ).rejects.toThrow(/INVESTIGATION.*LOOP|SEMANTIC.*LOOP|ANTI-LOOP/);
    });

    it("does not catch scripts investigating the same file with different keywords", async () => {
      // Script 1: check_layout.py reads gpt2-124M.ckpt
      const heredoc1 = `cat << 'EOF' > check_layout.py
import numpy as np
data = np.fromfile('gpt2-124M.ckpt', dtype=np.float32)
print(data[:8])
EOF
python check_layout.py`;

      const input1 = { tool: "bash" };
      await hooks["tool.execute.before"](input1, { args: { command: heredoc1, description: "Check weights layout" } });
      await hooks["tool.execute.after"](input1, { output: "0.48 -0.52", ok: true });

      // Script 2: check_hf_layout.py reads gpt2-124M.ckpt
      const heredoc2 = `cat << 'EOF' > check_hf_layout.py
import numpy as np
data = np.fromfile('gpt2-124M.ckpt', dtype=np.float32)
print(data.reshape(50257, 768)[:2])
EOF
python check_hf_layout.py`;

      const input2 = { tool: "bash" };
      await hooks["tool.execute.before"](input2, { args: { command: heredoc2, description: "Find ln weights" } });
      await hooks["tool.execute.after"](input2, { output: "0.48 -0.52", ok: true });

      // Script 3: check_llmc_layout.py reads gpt2-124M.ckpt
      const heredoc3 = `cat << 'EOF' > check_llmc_layout.py
import numpy as np
data = np.fromfile('gpt2-124M.ckpt', dtype=np.float32)
print(data[:256])
EOF
python check_llmc_layout.py`;

      const input3 = { tool: "bash" };
      // Should not throw because the description is different
      await hooks["tool.execute.before"](input3, { args: { command: heredoc3, description: "Verify header magic" } });
      await hooks["tool.execute.after"](input3, { output: "0.48 -0.52", ok: true });
    });
  });

  describe("subagent gating", () => {
    it("blocks after 3 identical subagent spawns", async () => {
      for (let i = 0; i < 3; i++) {
        const input = { tool: "task" };
        await hooks["tool.execute.before"](input, {
          args: { subagent_type: "fixer", description: "Implement GPT-2", prompt: "Write GPT-2 in C" }
        });
      }
      const input = { tool: "task" };
      await expect(
        hooks["tool.execute.before"](input, {
          args: { subagent_type: "fixer", description: "Implement GPT-2", prompt: "Write GPT-2 in C" }
        })
      ).rejects.toThrow(/ANTI-LOOP/);
    });

    it("allows a 4th subagent if the prompt contains novel information", async () => {
      for (let i = 0; i < 3; i++) {
        const input = { tool: "task" };
        await hooks["tool.execute.before"](input, {
          args: { subagent_type: "fixer", description: "Implement GPT-2", prompt: "Write GPT-2 in C. Implement tokenizer." }
        });
      }
      const input = { tool: "task" };
      // This should NOT throw — the prompt has substantial new info
      await hooks["tool.execute.before"](input, {
        args: {
          subagent_type: "fixer",
          description: "Implement GPT-2",
          prompt: "Write GPT-2 in C. CRITICAL FINDING: The .ckpt has NO header. Weights start at byte 0 as raw float32. Use HuggingFace per-layer interleaved order."
        }
      });
    });

    describe("setup command exemptions", () => {
      it("allows retrying pip install if output changes", async () => {
        const cmd = "pip install torch";
        const input = { tool: "bash", sessionID: "s1" };
        
        // Run 3 times (the normal limit) but with different outputs
        for (let i = 1; i <= 3; i++) {
          await hooks["tool.execute.before"](input, { args: { command: cmd } });
          await hooks["tool.execute.after"](input, { output: `Downloading chunk ${i}...`, ok: true });
        }

        // 4th run should still be allowed because it's 'setup' intent and outputs differed
        await expect(
          hooks["tool.execute.before"](input, { args: { command: cmd } })
        ).resolves.not.toThrow();
      });

      it("still blocks pip install if output is identical 3 times", async () => {
        const cmd = "pip install torch";
        const input = { tool: "bash", sessionID: "s1" };
        
        for (let i = 1; i <= 3; i++) {
          await hooks["tool.execute.before"](input, { args: { command: cmd } });
          await hooks["tool.execute.after"](input, { output: "Already satisfied", ok: true });
        }

        // 4th run should be blocked by identical_output logic
        await expect(
          hooks["tool.execute.before"](input, { args: { command: cmd } })
        ).rejects.toThrow("IDENTICAL OUTPUT LOOP DETECTED");
      });

      it("still blocks setup commands that time out twice", async () => {
        const cmd = "pip install torch";
        const input = { tool: "bash", sessionID: "s1" };
        
        for (let i = 1; i <= 2; i++) {
          await hooks["tool.execute.before"](input, { args: { command: cmd } });
          await hooks["tool.execute.after"](input, { 
            metadata: { timedOut: true },
            ok: false 
          });
        }

        // 3rd run should be blocked by timeout loop logic
        await expect(
          hooks["tool.execute.before"](input, { args: { command: cmd } })
        ).rejects.toThrow("TIMEOUT LOOP DETECTED");
      });
    });
  });
});
