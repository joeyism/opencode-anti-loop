import { describe, it, expect, beforeEach } from "vitest";
import { 
  createState, 
  checkCommandTimeouts, 
  checkCommandStreak, 
  updateCommandStreakAfter,
  recordFileHash,
  checkAndRecordTestRun,
  updateTestRunAfter,
  recordAction,
  detectActionCycle,
  recordFileTargetInvestigation,
  checkFileTargetInvestigation,
  checkGlobalFileInvestigation,
  recordGlobalFileInvestigation,
  resetStepsSinceLastWrite,
  incrementStepsSinceLastWrite
} from "../src/state.js";
import { DEFAULT_OPTIONS } from "../src/config.js";

describe("state.ts", () => {
  let state: any;

  beforeEach(() => {
    state = createState({ ...DEFAULT_OPTIONS });
  });

  describe("stepsSinceLastWrite", () => {
    it("increments correctly", () => {
      expect(incrementStepsSinceLastWrite(state)).toBe(1);
      expect(incrementStepsSinceLastWrite(state)).toBe(2);
      expect(state.stepsSinceLastWrite).toBe(2);
    });

    it("resets to 0", () => {
      incrementStepsSinceLastWrite(state);
      incrementStepsSinceLastWrite(state);
      resetStepsSinceLastWrite(state);
      expect(state.stepsSinceLastWrite).toBe(0);
    });
  });

  describe("updateCommandStreakAfter & checkCommandTimeouts", () => {
    it("increments consecutiveTimeouts and survives mutation epoch changes", () => {
      const cmd = "gcc foo.c";
      
      updateCommandStreakAfter(state, cmd, true, "hash1");
      expect(state.commandFrequencies.get(cmd).consecutiveTimeouts).toBe(1);

      state.mutationEpoch++;
      
      updateCommandStreakAfter(state, cmd, true, "hash2");
      expect(state.commandFrequencies.get(cmd).consecutiveTimeouts).toBe(2);

      expect(checkCommandTimeouts(state, cmd)).toBe(true);
    });

    it("resets consecutiveTimeouts if a command succeeds", () => {
      const cmd = "gcc foo.c";
      
      updateCommandStreakAfter(state, cmd, true, "hash1");
      updateCommandStreakAfter(state, cmd, true, "hash2");
      expect(state.commandFrequencies.get(cmd).consecutiveTimeouts).toBe(2);

      state.mutationEpoch++;
      
      updateCommandStreakAfter(state, cmd, false, "hash3");
      expect(state.commandFrequencies.get(cmd).consecutiveTimeouts).toBe(0);
      expect(checkCommandTimeouts(state, cmd)).toBe(false);
    });

    it("handles checking missing commands gracefully", () => {
      expect(checkCommandTimeouts(state, "missing_cmd")).toBe(false);
    });
  });

  describe("checkCommandStreak (identical outputs)", () => {
    it("increments consecutiveIdenticalOutputs and survives mutation epoch changes", () => {
      const cmd = "gcc foo.c";
      const hash = "same_hash";

      updateCommandStreakAfter(state, cmd, false, hash);
      expect(state.commandFrequencies.get(cmd).consecutiveIdenticalOutputs).toBe(1);

      state.mutationEpoch++;

      updateCommandStreakAfter(state, cmd, false, hash);
      expect(state.commandFrequencies.get(cmd).consecutiveIdenticalOutputs).toBe(2);

      state.mutationEpoch++;

      updateCommandStreakAfter(state, cmd, false, hash);
      expect(state.commandFrequencies.get(cmd).consecutiveIdenticalOutputs).toBe(3);

      expect(checkCommandStreak(state, cmd, true)).toBe("identical_output");
      expect(checkCommandStreak(state, cmd, false)).toBe("identical_output");
    });

    it("resets consecutiveIdenticalOutputs if the hash changes", () => {
      const cmd = "gcc foo.c";

      updateCommandStreakAfter(state, cmd, false, "hash1");
      updateCommandStreakAfter(state, cmd, false, "hash1");
      expect(state.commandFrequencies.get(cmd).consecutiveIdenticalOutputs).toBe(2);

      updateCommandStreakAfter(state, cmd, false, "hash2");
      expect(state.commandFrequencies.get(cmd).consecutiveIdenticalOutputs).toBe(1);
    });

    it("handles checkCommandStreak for non-existent commands", () => {
      expect(checkCommandStreak(state, "missing_cmd", false)).toBe(false);
    });
  });

  describe("checkCommandStreak (epoch streak)", () => {
    it("resets consecutiveRuns when the mutation epoch changes", () => {
      const cmd = "ls";
      
      updateCommandStreakAfter(state, cmd, false, "hash1");
      updateCommandStreakAfter(state, cmd, false, "hash2");
      updateCommandStreakAfter(state, cmd, false, "hash3");
      
      expect(state.commandFrequencies.get(cmd).consecutiveRuns).toBe(3);
      expect(checkCommandStreak(state, cmd, false)).toBe("epoch_streak");

      state.mutationEpoch++;
      
      expect(checkCommandStreak(state, cmd, false)).toBe(false);

      updateCommandStreakAfter(state, cmd, false, "hash4");
      expect(state.commandFrequencies.get(cmd).consecutiveRuns).toBe(1);
    });
  });

  describe("recordFileHash", () => {
    it("updates the file hash and increments mutationEpoch if source is 'write'", () => {
      const initialEpoch = state.mutationEpoch;
      
      recordFileHash(state, "file.txt", "hash1", "write");
      
      expect(state.fileHashes.get("file.txt").hash).toBe("hash1");
      expect(state.mutationEpoch).toBe(initialEpoch + 1);
      expect(state.knownTrackedFiles.has("file.txt")).toBe(true);
    });

    it("does not increment mutationEpoch if source is 'disk'", () => {
      const initialEpoch = state.mutationEpoch;
      
      recordFileHash(state, "file.txt", "hash1", "disk");
      
      expect(state.fileHashes.get("file.txt").hash).toBe("hash1");
      expect(state.mutationEpoch).toBe(initialEpoch);
    });

    it("does not increment mutationEpoch if hash is unchanged on 'write'", () => {
      recordFileHash(state, "file.txt", "hash1", "write");
      const epochAfterFirstWrite = state.mutationEpoch;
      
      recordFileHash(state, "file.txt", "hash1", "write");
      
      expect(state.mutationEpoch).toBe(epochAfterFirstWrite);
    });
  });

  describe("testRun tracking", () => {
    it("checkAndRecordTestRun detects duplicate tests", () => {
      updateTestRunAfter(state, "test.py", "hash1", "pytest test.py");
      expect(checkAndRecordTestRun(state, "test.py", "hash1", "pytest test.py")).toBeNull();
      
      updateTestRunAfter(state, "test.py", "hash1", "pytest test.py");
      
      const violation = checkAndRecordTestRun(state, "test.py", "hash1", "pytest test.py");
      expect(violation).toEqual({
        target: "test.py",
        hash: "hash1",
        runs: 2, // DEFAULT_OPTIONS.maxIdenticalTests is 2
        max: 2,
        lastCommand: "pytest test.py",
      });
    });

    it("checkAndRecordTestRun resets if hash changes", () => {
      updateTestRunAfter(state, "test.py", "hash1", "pytest test.py");
      updateTestRunAfter(state, "test.py", "hash2", "pytest test.py");
      
      expect(checkAndRecordTestRun(state, "test.py", "hash2", "pytest test.py")).toBeNull();
    });

    it("returns null when no previous test run exists", () => {
       expect(checkAndRecordTestRun(state, "nonexistent.py", "hash1", "pytest")).toBeNull();
    });
  });

  describe("detectActionCycle - semantic matching", () => {
    it("detects semantic cycles when file targets match but signatures differ", () => {
      const state = createState({
        ...DEFAULT_OPTIONS,
        maxCyclicalActionRepeats: 10,
        maxSemanticCycleRepeats: 3,
      });

      // Three iterations of: write a differently-named Python script that reads the same file, then run it
      const scripts = [
        { sig: "write:/app/check_layout.py", norm: "write:/app/check_layout.py", sem: "bash-investigation:gpt2-124M.ckpt" },
        { sig: "bash:python check_layout.py", norm: "bash:python check_layout.py", sem: "bash-investigation:gpt2-124M.ckpt" },
        { sig: "write:/app/check_weights_hf.py", norm: "write:/app/check_weights_hf.py", sem: "bash-investigation:gpt2-124M.ckpt" },
        { sig: "bash:python check_weights_hf.py", norm: "bash:python check_weights_hf.py", sem: "bash-investigation:gpt2-124M.ckpt" },
        { sig: "write:/app/check_llmc.py", norm: "write:/app/check_llmc.py", sem: "bash-investigation:gpt2-124M.ckpt" },
        { sig: "bash:python check_llmc.py", norm: "bash:python check_llmc.py", sem: "bash-investigation:gpt2-124M.ckpt" },
      ];

      for (const s of scripts) {
        recordAction(state, {
          signature: s.sig,
          normalizedSignature: s.norm,
          semanticGroup: s.sem,
        });
      }

      const cycle = detectActionCycle(state);
      expect(cycle).not.toBeNull();
      expect(cycle!.cycleLength).toBe(1);
      expect(cycle!.semantic).toBe(true);
      expect(cycle!.severity).toBe('warning');
    });

    it("does not trigger semantic cycle when file targets differ", () => {
      const state = createState({
        ...DEFAULT_OPTIONS,
        maxCyclicalActionRepeats: 4,
        maxSemanticCycleRepeats: 3,
      });

      const scripts = [
        { sig: "bash:python a.py", norm: "bash:python a.py", sem: "bash-investigation:file_a.bin" },
        { sig: "bash:python b.py", norm: "bash:python b.py", sem: "bash-investigation:file_b.bin" },
        { sig: "bash:python c.py", norm: "bash:python c.py", sem: "bash-investigation:file_c.bin" },
      ];

      for (const s of scripts) {
        recordAction(state, { signature: s.sig, normalizedSignature: s.norm, semanticGroup: s.sem });
      }

      expect(detectActionCycle(state)).toBeNull();
    });
  });

  describe("fileTargetInvestigations", () => {
    it("tracks investigation count per file target key", () => {
      const state = createState({ ...DEFAULT_OPTIONS, maxSameFileInvestigations: 3 });

      expect(recordFileTargetInvestigation(state, "gpt2-124M.ckpt")).toBe(1);
      expect(recordFileTargetInvestigation(state, "gpt2-124M.ckpt")).toBe(2);
      expect(recordFileTargetInvestigation(state, "gpt2-124M.ckpt")).toBe(3);
      expect(checkFileTargetInvestigation(state, "gpt2-124M.ckpt")).toBe(true);
    });

    it("does not trigger below threshold", () => {
      const state = createState({ ...DEFAULT_OPTIONS, maxSameFileInvestigations: 3 });

      recordFileTargetInvestigation(state, "gpt2-124M.ckpt");
      recordFileTargetInvestigation(state, "gpt2-124M.ckpt");
      expect(checkFileTargetInvestigation(state, "gpt2-124M.ckpt")).toBe(false);
    });

    it("tracks different file targets independently", () => {
      const state = createState({ ...DEFAULT_OPTIONS, maxSameFileInvestigations: 2 });

      recordFileTargetInvestigation(state, "file_a.bin");
      recordFileTargetInvestigation(state, "file_b.bin");
      expect(checkFileTargetInvestigation(state, "file_a.bin")).toBe(false);
      expect(checkFileTargetInvestigation(state, "file_b.bin")).toBe(false);

      recordFileTargetInvestigation(state, "file_a.bin");
      expect(checkFileTargetInvestigation(state, "file_a.bin")).toBe(true);
      expect(checkFileTargetInvestigation(state, "file_b.bin")).toBe(false);
    });

    it("normalizes multi-file target keys by sorting", () => {
      const state = createState({ ...DEFAULT_OPTIONS, maxSameFileInvestigations: 2 });

      recordFileTargetInvestigation(state, "a.bin,b.bin");
      recordFileTargetInvestigation(state, "a.bin,b.bin");
      expect(checkFileTargetInvestigation(state, "a.bin,b.bin")).toBe(true);
    });
  });

  describe("detectActionCycle - contentHash differentiation", () => {
    it("does NOT trigger exact cycle when write actions to same path have different contentHash", () => {
      const state = createState({
        ...DEFAULT_OPTIONS,
        maxCyclicalActionRepeats: 4,
        maxSemanticCycleRepeats: 3,
      });

      // CoreWars scenario: write 4 different warriors to my_warrior.red, test each
      // The write tool signature is always "write:/app/my_warrior.red"
      // But the contentHash should be different each time
      const warriorContent = [
        "; Silk warrior code A",
        "; Q-Silk warrior code B",
        "; P-Space warrior code C",
        "; Improved Silk warrior code D",
      ];

      const bashSig = "bash:pmars -b -r 100";

      for (let i = 0; i < 4; i++) {
        recordAction(state, {
          signature: "write:/app/my_warrior.red",
          normalizedSignature: "write:/app/my_warrior.red",
          contentHash: `hash_content_${i}`,
        });
        recordAction(state, {
          signature: bashSig,
          normalizedSignature: bashSig,
        });
      }

      // Should NOT detect a cycle because content hashes differ
      const cycle = detectActionCycle(state);
      expect(cycle).toBeNull();
    });

    it("DOES trigger exact cycle when write actions to same path have identical contentHash", () => {
      const state = createState({
        ...DEFAULT_OPTIONS,
        maxCyclicalActionRepeats: 4,
        maxSemanticCycleRepeats: 3,
      });

      const sameHash = "same_warrior_content_hash";
      const bashSig = "bash:pmars -b -r 100";

      for (let i = 0; i < 4; i++) {
        recordAction(state, {
          signature: "write:/app/my_warrior.red",
          normalizedSignature: "write:/app/my_warrior.red",
          contentHash: sameHash,
        });
        recordAction(state, {
          signature: bashSig,
          normalizedSignature: bashSig,
        });
      }

      // SHOULD detect a cycle because content hashes are identical
      const cycle = detectActionCycle(state);
      expect(cycle).not.toBeNull();
      expect(cycle!.cycleLength).toBe(2);
      expect(cycle!.semantic).toBe(false);
      expect(cycle!.severity).toBe('warning');
    });

    it("triggers semantic cycle when write actions have same contentHash and semanticGroup", () => {
      const state = createState({
        ...DEFAULT_OPTIONS,
        maxCyclicalActionRepeats: 10,
        maxSemanticCycleRepeats: 3,
      });

      // Same semantic group and same content hash — true loop
      for (let i = 0; i < 3; i++) {
        recordAction(state, {
          signature: "write:/app/my_warrior.red",
          normalizedSignature: "write:/app/my_warrior.red",
          semanticGroup: "bash-build:warrior",
          contentHash: "same_content_hash",
        });
      }

      const cycle = detectActionCycle(state);
      expect(cycle).not.toBeNull();
      expect(cycle!.semantic).toBe(true);
      expect(cycle!.severity).toBe('warning');
    });

    it("triggers advisory severity before reaching the limit", () => {
      const state = createState({
        ...DEFAULT_OPTIONS,
        maxCyclicalActionRepeats: 4,
      });

      // Threshold is 4. Advisory triggers at 4-1 = 3.
      for (let i = 0; i < 3; i++) {
        recordAction(state, {
          signature: "write:f.c",
          normalizedSignature: "write:f.c",
        });
      }

      const cycle = detectActionCycle(state);
      expect(cycle).not.toBeNull();
      expect(cycle!.count).toBe(3);
      expect(cycle!.severity).toBe('advisory');
    });
  });

  describe("globalFileInvestigations", () => {
    it("tracks total investigations of a file across different topics", () => {
      const state = createState({ ...DEFAULT_OPTIONS, maxSameFileInvestigations: 2 });
      // global cap should be 4

      recordGlobalFileInvestigation(state, "data.bin");
      recordGlobalFileInvestigation(state, "data.bin");
      recordGlobalFileInvestigation(state, "data.bin");
      expect(checkGlobalFileInvestigation(state, "data.bin")).toBe(false);

      recordGlobalFileInvestigation(state, "data.bin");
      expect(checkGlobalFileInvestigation(state, "data.bin")).toBe(true);
    });

    it("tracks global investigations independently from per-topic investigations", () => {
      const state = createState({ ...DEFAULT_OPTIONS, maxSameFileInvestigations: 2 });
      
      // Topic A
      recordFileTargetInvestigation(state, "data.bin::topicA");
      recordGlobalFileInvestigation(state, "data.bin");
      expect(checkFileTargetInvestigation(state, "data.bin::topicA")).toBe(false);
      expect(checkGlobalFileInvestigation(state, "data.bin")).toBe(false);

      recordFileTargetInvestigation(state, "data.bin::topicA");
      recordGlobalFileInvestigation(state, "data.bin");
      expect(checkFileTargetInvestigation(state, "data.bin::topicA")).toBe(true); // Hit per-topic cap
      expect(checkGlobalFileInvestigation(state, "data.bin")).toBe(false); // Below global cap
    });
  });
});
