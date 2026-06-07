import type { AntiLoopOptions, ResolvedOptions } from "./types.js";

export const DEFAULT_OPTIONS: ResolvedOptions = {
  maxIdenticalTests: 2,
  maxRepeatedCommands: 3,
  maxConsecutiveIdenticalOutputs: 5,
  maxCyclicalActionRepeats: 6,
  maxSemanticCycleRepeats: 8,
  maxZombieSteps: 3,
  maxHardLoops: 3,
  maxSameFileInvestigations: 12,
  maxStepsWithoutWrite: 20,
  maxStepsWithoutFirstWrite: 8,
  trackedFilePatterns: ["*"],
  testCommandPatterns: ["pmars", "pytest", "npm test", "cargo test", "go test", "make test", "./test.sh"],
  matchesTrackedFile: () => true,
  allowRollback: false,
};

export function resolveOptions(options?: AntiLoopOptions): ResolvedOptions {
  const trackedFilePatterns = options?.trackedFilePatterns ?? DEFAULT_OPTIONS.trackedFilePatterns;
  
  // Simple glob matcher for *, **, ?
  const matchesTrackedFile = (pathKey: string): boolean => {
    if (trackedFilePatterns.includes("*")) return true;
    
    for (const pattern of trackedFilePatterns) {
      // Very basic glob to regex conversion
      const regexStr = "^" + pattern
        .replace(/\./g, "\\.")
        .replace(/\*\*/g, ".*")
        .replace(/(?<!\.)\*/g, "[^/]*")
        .replace(/\?/g, ".") + "$";
      
      if (new RegExp(regexStr).test(pathKey)) {
        return true;
      }
    }
    return false;
  };

  return {
    maxIdenticalTests: options?.maxIdenticalTests ?? DEFAULT_OPTIONS.maxIdenticalTests,
    maxRepeatedCommands: options?.maxRepeatedCommands ?? DEFAULT_OPTIONS.maxRepeatedCommands,
    maxConsecutiveIdenticalOutputs: options?.maxConsecutiveIdenticalOutputs ?? DEFAULT_OPTIONS.maxConsecutiveIdenticalOutputs,
    maxCyclicalActionRepeats: options?.maxCyclicalActionRepeats ?? DEFAULT_OPTIONS.maxCyclicalActionRepeats,
    maxSemanticCycleRepeats: options?.maxSemanticCycleRepeats ?? DEFAULT_OPTIONS.maxSemanticCycleRepeats,
    maxZombieSteps: options?.maxZombieSteps ?? DEFAULT_OPTIONS.maxZombieSteps,
    maxHardLoops: options?.maxHardLoops ?? DEFAULT_OPTIONS.maxHardLoops,
    maxSameFileInvestigations: options?.maxSameFileInvestigations ?? DEFAULT_OPTIONS.maxSameFileInvestigations,
    maxStepsWithoutWrite: options?.maxStepsWithoutWrite ?? DEFAULT_OPTIONS.maxStepsWithoutWrite,
    maxStepsWithoutFirstWrite: options?.maxStepsWithoutFirstWrite ?? DEFAULT_OPTIONS.maxStepsWithoutFirstWrite,
    trackedFilePatterns,
    testCommandPatterns: options?.testCommandPatterns ?? DEFAULT_OPTIONS.testCommandPatterns,
    matchesTrackedFile,
    allowRollback: options?.allowRollback ?? DEFAULT_OPTIONS.allowRollback,
  };
}
