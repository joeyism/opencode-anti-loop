import type { PluginState, ResolvedOptions, FileRecord, TestRunRecord, CommandStreak, ActionRecord } from "./types.js";

export function createState(options: ResolvedOptions): PluginState {
  return {
    options,
    fileHashes: new Map(),
    testRuns: new Map(),
    commandFrequencies: new Map(),
    subagentFrequencies: new Map(),
    fileTargetInvestigations: new Map(),
    globalFileInvestigations: new Map(),
    mutationEpoch: 0,
    knownTrackedFiles: new Set(),
    actionHistory: [],
    hardLoopStreak: 0,
    stepsSinceLastWrite: 0,
    consecutiveBlockedCalls: 0,
    hasProducedFirstWrite: false,
    agentWrittenFiles: new Set(),
    recentOutputHashes: [],
    messageHistory: [],
    firstMessageID: null,
    hasRolledBack: false,
  };
}

export function recordAgentWrite(state: PluginState, filePath: string): void {
  state.agentWrittenFiles.add(filePath);
}

export function resetHardLoopStreak(state: PluginState): void {
  state.hardLoopStreak = 0;
}

export function resetStepsSinceLastWrite(state: PluginState): void {
  state.stepsSinceLastWrite = 0;
}

export function incrementStepsSinceLastWrite(state: PluginState): number {
  state.stepsSinceLastWrite += 1;
  return state.stepsSinceLastWrite;
}

export function recordHardLoopViolation(state: PluginState): number {
  state.hardLoopStreak += 1;
  return state.hardLoopStreak;
}

export function recordFileTargetInvestigation(state: PluginState, fileTargetKey: string): number {
  const count = (state.fileTargetInvestigations.get(fileTargetKey) || 0) + 1;
  state.fileTargetInvestigations.set(fileTargetKey, count);
  return count;
}

export function checkFileTargetInvestigation(state: PluginState, fileTargetKey: string): boolean {
  const count = state.fileTargetInvestigations.get(fileTargetKey) || 0;
  return count >= state.options.maxSameFileInvestigations;
}

export function recordGlobalFileInvestigation(state: PluginState, rawFileTargetKey: string): number {
  const count = (state.globalFileInvestigations.get(rawFileTargetKey) || 0) + 1;
  state.globalFileInvestigations.set(rawFileTargetKey, count);
  return count;
}

export function checkGlobalFileInvestigation(state: PluginState, rawFileTargetKey: string): boolean {
  const count = state.globalFileInvestigations.get(rawFileTargetKey) || 0;
  // Global cap is 2x the per-semantic-group cap
  return count >= state.options.maxSameFileInvestigations * 2;
}

export function recordFileHash(
  state: PluginState,
  pathKey: string,
  hash: string,
  source: "write" | "disk"
) {
  const prev = state.fileHashes.get(pathKey);
  if (!prev || prev.hash !== hash) {
    if (source === "write") {
        state.mutationEpoch++;
        state.agentWrittenFiles.add(pathKey);
    }
  }
  
  state.fileHashes.set(pathKey, {
    hash,
    lastUpdatedAt: Date.now(),
    source,
  });
  state.knownTrackedFiles.add(pathKey);
}

export function checkAndRecordTestRun(
  state: PluginState,
  targetKey: string,
  hash: string,
  command: string
) {
  const prev = state.testRuns.get(targetKey);
  
  if (prev && prev.lastHash === hash) {
    if (prev.consecutiveRuns >= state.options.maxIdenticalTests) {
      return {
        target: targetKey,
        hash,
        runs: prev.consecutiveRuns,
        max: state.options.maxIdenticalTests,
        lastCommand: prev.lastCommand,
      };
    }
  }
  
  // Update state will happen in after hook, here we just return violation if any
  return null;
}

export function updateTestRunAfter(state: PluginState, targetKey: string, hash: string, command: string) {
    const prev = state.testRuns.get(targetKey);
    if (prev && prev.lastHash === hash) {
        prev.consecutiveRuns++;
        prev.lastTestedAt = Date.now();
        prev.lastCommand = command;
    } else {
        state.testRuns.set(targetKey, {
            lastHash: hash,
            consecutiveRuns: 1,
            lastCommand: command,
            lastTestedAt: Date.now(),
        });
    }
}

export function checkCommandStreak(state: PluginState, normalizedCmd: string, isWriteMutation: boolean): 'epoch_streak' | 'identical_output' | false {
  const last = state.commandFrequencies.get(normalizedCmd);
  if (!last) return false;

  if ((last.consecutiveIdenticalOutputs || 0) >= state.options.maxRepeatedCommands) {
    return 'identical_output';
  }

  if (
    last.mutationEpoch === state.mutationEpoch &&
    last.consecutiveRuns >= state.options.maxRepeatedCommands
  ) {
    return 'epoch_streak';
  }
  return false;
}

export function checkCommandTimeouts(state: PluginState, normalizedCmd: string): boolean {
  const last = state.commandFrequencies.get(normalizedCmd);
  return (last?.consecutiveTimeouts || 0) >= 2;
}

export function updateCommandStreakAfter(
  state: PluginState,
  normalizedCmd: string,
  isTimeout: boolean,
  outputHash: string
): void {
  const last = state.commandFrequencies.get(normalizedCmd);
  const now = Date.now();

  const consecutiveRuns =
    last && last.mutationEpoch === state.mutationEpoch
      ? last.consecutiveRuns + 1
      : 1;

  const consecutiveTimeouts = isTimeout
    ? (last?.consecutiveTimeouts || 0) + 1
    : 0;

  const consecutiveIdenticalOutputs =
    last && last.lastOutputHash === outputHash
      ? (last.consecutiveIdenticalOutputs || 0) + 1
      : 1;

  state.commandFrequencies.set(normalizedCmd, {
    normalizedCommand: normalizedCmd,
    mutationEpoch: state.mutationEpoch,
    consecutiveRuns,
    lastRunAt: now,
    consecutiveTimeouts,
    lastOutputHash: outputHash,
    consecutiveIdenticalOutputs,
  });

  if (isTimeout) {
    return;
  }
}

export function trackOutputHash(state: PluginState, hash: string): number {
  state.recentOutputHashes.push(hash);
  // Keep only last 20 entries
  if (state.recentOutputHashes.length > 20) {
    state.recentOutputHashes.shift();
  }
  // Count consecutive identical hashes from the end
  let streak = 0;
  for (let i = state.recentOutputHashes.length - 1; i >= 0; i--) {
    if (state.recentOutputHashes[i] === hash) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

export function recordAction(state: PluginState, action: ActionRecord) {
  state.actionHistory.push(action);
  if (state.actionHistory.length > 100) {
    state.actionHistory.shift();
  }
}

export function detectActionCycle(state: PluginState): { cycleLength: number; count: number; pattern: ActionRecord[]; semantic: boolean; severity: 'advisory' | 'warning' } | null {
  const history = state.actionHistory;
  const n = history.length;

  // Try different cycle lengths L
  for (let L = 1; L <= Math.floor(n / 2); L++) {
    const pattern = history.slice(n - L);
    
    // 1. Check for exact normalized signature match
    const maxExactCycles = state.options.maxCyclicalActionRepeats;
    // We check both the warning threshold and the advisory threshold (max - 1)
    const exactThresholds = [
      { count: maxExactCycles, severity: 'warning' as const },
      { count: maxExactCycles - 1, severity: 'advisory' as const }
    ].filter(t => t.count >= 2);

    for (const { count, severity } of exactThresholds) {
      if (n >= L * count) {
        let isExactCycle = true;
        for (let c = 1; c < count; c++) {
          const offset = n - L - c * L;
          for (let i = 0; i < L; i++) {
            const curr = pattern[i];
            const prev = history[offset + i];
            if (
              curr.normalizedSignature !== prev.normalizedSignature ||
              // Different contentHash means different action — not a loop
              (curr.contentHash !== undefined && prev.contentHash !== undefined && curr.contentHash !== prev.contentHash) ||
              // Only block on outputHash if BOTH are defined AND different (not just one undefined)
              (curr.outputHash !== undefined && prev.outputHash !== undefined && curr.outputHash !== prev.outputHash) ||
              (curr.isTimeout !== undefined && prev.isTimeout !== undefined && curr.isTimeout !== prev.isTimeout)
            ) {
              isExactCycle = false;
              break;
            }
          }
          if (!isExactCycle) break;
        }
        if (isExactCycle) {
          return { cycleLength: L, count, pattern, semantic: false, severity };
        }
      }
    }

    // 2. Check for semantic group match (higher threshold)
    const maxSemanticCycles = state.options.maxSemanticCycleRepeats;
    const semanticThresholds = [
      { count: maxSemanticCycles, severity: 'warning' as const },
      { count: maxSemanticCycles - 1, severity: 'advisory' as const }
    ].filter(t => t.count >= 2);

    for (const { count, severity } of semanticThresholds) {
      if (n >= L * count) {
        let isSemanticCycle = true;
        for (let c = 1; c < count; c++) {
          const offset = n - L - c * L;
          for (let i = 0; i < L; i++) {
            const curr = pattern[i];
            const prev = history[offset + i];
            
            // Must have semantic groups to compare
            if (!curr.semanticGroup || !prev.semanticGroup || curr.semanticGroup !== prev.semanticGroup) {
              isSemanticCycle = false;
              break;
            }

            // Different contentHash means different action — not a loop
            if (
              (curr.contentHash !== undefined && prev.contentHash !== undefined && curr.contentHash !== prev.contentHash) ||
              (curr.outputHash !== undefined && prev.outputHash !== undefined && curr.outputHash !== prev.outputHash) ||
              (curr.isTimeout !== undefined && prev.isTimeout !== undefined && curr.isTimeout !== prev.isTimeout)
            ) {
              isSemanticCycle = false;
              break;
            }
          }
          if (!isSemanticCycle) break;
        }
        if (isSemanticCycle) {
          return { cycleLength: L, count, pattern, semantic: true, severity };
        }
      }
    }
  }

  return null;
}
