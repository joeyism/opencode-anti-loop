export interface ResolvedOptions {
  maxIdenticalTests: number;
  maxRepeatedCommands: number;
  maxConsecutiveIdenticalOutputs: number;
  maxCyclicalActionRepeats: number;
  maxSemanticCycleRepeats: number;
  maxZombieSteps: number;
  maxHardLoops: number;
  maxSameFileInvestigations: number;
  maxStepsWithoutWrite: number;
  maxStepsWithoutFirstWrite: number;
  trackedFilePatterns: string[];
  testCommandPatterns: string[];
  matchesTrackedFile: (pathKey: string) => boolean;
  allowRollback: boolean;
}

export interface AntiLoopOptions {
  maxIdenticalTests?: number;
  maxRepeatedCommands?: number;
  maxConsecutiveIdenticalOutputs?: number;
  maxCyclicalActionRepeats?: number;
  maxSemanticCycleRepeats?: number;
  maxZombieSteps?: number;
  maxHardLoops?: number;
  maxSameFileInvestigations?: number;
  maxStepsWithoutWrite?: number;
  maxStepsWithoutFirstWrite?: number;
  trackedFilePatterns?: string[];
  testCommandPatterns?: string[];
  allowRollback?: boolean;
}

export interface FileRecord {
  hash: string;
  lastUpdatedAt: number;
  source: "write" | "disk";
}

export interface CommandStreak {
  normalizedCommand: string;
  mutationEpoch: number;
  consecutiveRuns: number;
  lastRunAt: number;
  consecutiveTimeouts?: number;
  lastOutputHash?: string;
  consecutiveIdenticalOutputs?: number;
}

export interface TestRunRecord {
  lastHash: string;
  consecutiveRuns: number;
  lastCommand: string;
  lastTestedAt: number;
}

export interface PluginState {
  options: ResolvedOptions;
  fileHashes: Map<string, FileRecord>;
  testRuns: Map<string, TestRunRecord>;
  commandFrequencies: Map<string, CommandStreak>;
  subagentFrequencies: Map<string, { count: number, epoch: number, lastPrompt?: string }>;
  fileTargetInvestigations: Map<string, number>;
  globalFileInvestigations: Map<string, number>;
  mutationEpoch: number;
  knownTrackedFiles: Set<string>;
  actionHistory: ActionRecord[];
  zombieStepStreak: number;
  lastZombieReasoning: number | null;
  hardLoopStreak: number;
  stepsSinceLastWrite: number;
  consecutiveBlockedCalls: number;
  hasProducedFirstWrite: boolean;
  agentWrittenFiles: Set<string>;
  recentOutputHashes: string[];
  /** Tracks message IDs at each step for rollback targeting */
  messageHistory: Array<{ messageID: string; sessionID: string; stepIndex: number; timestamp: number }>;
  /** The first user message ID (the original prompt) — never revert past this */
  firstMessageID: string | null;
  /** Whether a rollback has already been performed this session (max 1 rollback) */
  hasRolledBack: boolean;
}

export type ActionRecord = {
  signature: string;
  normalizedSignature: string;
  semanticGroup?: string;
  intent?: "write" | "transform" | "build" | "run" | "investigate" | "setup";
  outputHash?: string;
  isTimeout?: boolean;
  /** Hash of content for write/edit actions — different content = different action */
  contentHash?: string;
};

export interface PendingWrite {
  pathKey: string;
  nextHash: string;
  advisory?: string;
}

export interface PendingBash {
  normalizedCommand: string;
  mutationEpoch: number;
  testTargets: Array<{ pathKey: string; hash: string }>;
  isWriteMutation?: boolean;
  isAntiLoopWarning?: boolean;
  advisory?: string;
}

export interface PluginContext {
  worktree: string;
  client: any;
}
