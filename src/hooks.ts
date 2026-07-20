import type { PluginState, PendingWrite, PendingBash, PluginContext } from "./types.js";
import { hashContent, normalizeOutputForHashing } from "./hash.js";
import { 
  recordFileHash, 
  checkAndRecordTestRun, 
  updateTestRunAfter,
  checkCommandStreak, 
  checkCommandTimeouts,
  updateCommandStreakAfter,
  recordAction,
  detectActionCycle,
  recordHardLoopViolation,
  resetHardLoopStreak,
  checkFileTargetInvestigation,
  recordFileTargetInvestigation,
  checkGlobalFileInvestigation,
  recordGlobalFileInvestigation,
  incrementStepsSinceLastWrite,
  resetStepsSinceLastWrite,
  trackOutputHash,
} from "./state.js";
import { 
  normalizeCommand, 
  normalizeActionSignature,
  classifyBashIntent,
  isTestCommand, 
  extractTestTargets,
  extractHeredocTargets,
  extractHeredocFileTargets,
  extractBashReadTargets,
  extractDescriptionKeywords,
  computePromptNovelty
} from "./command.js";
import { 
  buildDuplicateTestError, 
  buildRepeatedCommandError,
  buildTimeoutLoopError,
  buildIdenticalOutputError,
  buildActionCycleError,
  buildActionCycleAdvisory,
  buildFileTargetInvestigationError,
  buildExplorationSprawlError,
  buildConsecutiveIdenticalOutputError
} from "./errors.js";

const pendingWrites = new Map<string, PendingWrite>();
const pendingBash = new Map<string, PendingBash>();

function isTimeoutResult(output: any): boolean {
  const metadata = output?.metadata ?? {};
  const reason = typeof metadata.reason === "string" ? metadata.reason.toLowerCase() : "";

  const textFields = [
    output?.output,
    output?.stderr,
    metadata?.output,
    metadata?.stderr,
    metadata?.message,
    typeof output?.error === "string" ? output.error : output?.error?.message,
  ];

  if (
    textFields.some(
      (value) => typeof value === "string" && /exceeding timeout|timed out/i.test(value)
    )
  ) {
    return true;
  }

  // Fallback heuristic: exit null and execution time >= 119s
  if (metadata.exit === null && output?.time) {
    const elapsed = output.time.end - output.time.start;
    if (elapsed >= 119000) return true;
  }

  return (
    metadata.timedOut === true ||
    metadata.timeout === true ||
    metadata.didTimeout === true ||
    reason === "timeout" ||
    output?.error?.code === "ETIMEDOUT"
  );
}

function getOutputText(output: any): string {
  return [
    output?.output,
    output?.stderr,
    output?.metadata?.output,
    output?.metadata?.stderr,
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

function updateLatestActionRecord(state: PluginState, updates: { outputHash?: string; isTimeout?: boolean }) {
  const last = state.actionHistory[state.actionHistory.length - 1];
  if (last) Object.assign(last, updates);
}

export function createHooks(ctx: PluginContext, state: PluginState) {
  const compactSession = async (sessionID: string) => {
    if (!sessionID) return;
    try {
      await (ctx.client as any).session.summarize({ path: { id: sessionID } });
    } catch (e) {
      console.warn("[Anti-Loop] Failed to compact session:", e);
    }
  };

  const throwAfterCompact = async (message: string, sessionID: string) => {
    state.consecutiveBlockedCalls++;
    if (state.consecutiveBlockedCalls >= 5) {
      await compactSession(sessionID);
      const isRollback = state.consecutiveBlockedCalls >= 10;
      
      if (isRollback && state.options.allowRollback) {
        await performRollback(state, message, sessionID);
        state.consecutiveBlockedCalls = 0;
        return; 
      }

      // Hard redirect
      await (ctx.client as any).session.prompt({
        path: { id: sessionID },
        body: {
          parts: [{
            type: "text",
            text: `SYSTEM OVERRIDE: Your last ${state.consecutiveBlockedCalls} tool calls were all blocked because you are stuck in an exploration loop. Your current approach has failed.\n\n` +
                  `YOU MUST:\n` +
                  `1. STOP running diagnostic scripts or read-only commands.\n` +
                  `2. WRITE your implementation/solution file NOW using whatever information you already have.\n` +
                  `3. Use the \`write\` tool for your very next action.\n\n` +
                  `Investigation counters have been reset to give you one final chance to produce the deliverable.`,
          }],
        },
      });
      
      // Reset investigation counters to give them a fresh start
      state.fileTargetInvestigations.clear();
      state.globalFileInvestigations.clear();
      state.stepsSinceLastWrite = 0;
      
      if (!isRollback) {
         throw new Error(message);
      }
      return;
    }

    await compactSession(sessionID);
    throw new Error(message);
  };

  const handleManualThrow = (message: string) => {
    state.consecutiveBlockedCalls++;
    throw new Error(message);
  };

  const performRollback = async (state: PluginState, reason: string, sessionID: string): Promise<boolean> => {
    if (!state.options.allowRollback) return false;
    if (state.hasRolledBack) return false;

    if (state.messageHistory.length === 0 && sessionID) {
      try {
        const res = await (ctx.client as any).session.message({ path: { id: sessionID } });
        const messages = res.data || res;
        if (Array.isArray(messages)) {
          state.messageHistory = messages.map((m: any, i: number) => ({
            messageID: m.info?.id || m.id,
            sessionID,
            stepIndex: i,
            timestamp: Date.now(),
          }));
          if (state.messageHistory.length > 0) {
            state.firstMessageID = state.messageHistory[0].messageID;
          }
        }
      } catch (e) {
        // ignore
      }
    }

    if (state.messageHistory.length < 2) return false;
    if (!state.firstMessageID) return false;

    const targetIndex = Math.max(0, state.messageHistory.length - 2);
    const target = state.messageHistory[targetIndex];

    try {
      await (ctx.client as any).session.revert({
        path: { id: sessionID },
        body: { messageID: target.messageID },
      });

      await (ctx.client as any).session.prompt({
        path: { id: sessionID },
        body: {
          parts: [{
            type: "text",
            text: `SYSTEM NOTE: Your previous approach failed. Here is what went wrong:\n\n` +
                  `${reason}\n\n` +
                  `You have been rolled back to an earlier clean state. ` +
                  `The files have been restored. Your failed attempt has been erased from history.\n\n` +
                  `You MUST try a fundamentally different approach. ` +
                  `Do NOT repeat the same strategy that just failed.`,
          }],
        },
      });

      state.hasRolledBack = true;
      return true;
    } catch (e: any) {
      console.error("[Anti-Loop] Rollback failed:", e);
      return false;
    }
  };

  return {
    event: async (input: any) => {
      const event = input?.event;
      if (event?.type !== "message.part.updated") return;
      const part = event.part ?? event.properties?.part;
      if (part?.type !== "step-finish") return;

      const TRUNCATION_THRESHOLD = 16000;
      const outputTokens = typeof part?.tokens?.output === "number" ? part.tokens.output : 0;
      const finishReason = part?.reason;
      const sessionID = event.sessionID ?? part?.sessionID;

      if (finishReason === "length" || outputTokens > TRUNCATION_THRESHOLD) {
        try {
          await (ctx.client as any).session.prompt({
            path: { id: sessionID },
            body: {
              parts: [{
                type: "text",
                text: `⚠️ OUTPUT TRUNCATION DETECTED: Your previous response produced ${outputTokens} tokens and was cut off. ` +
                      `You MUST make a tool call (write, bash, or edit) in your next response. ` +
                      `Limit reasoning to 3-5 lines. Act immediately.`,
              }],
            },
          });
        } catch (e) {
          // Log but don't fail — the step is already done
        }
      }

      if (state.options.allowRollback && part?.messageID && part?.sessionID) {
        if (!state.firstMessageID) {
          state.firstMessageID = part.messageID;
        }
        state.messageHistory.push({
          messageID: part.messageID,
          sessionID: part.sessionID,
          stepIndex: state.messageHistory.length,
          timestamp: Date.now(),
        });
      }
    },
    "tool.execute.before": async (input: any, output: any) => {
      const { tool } = input;
      if (tool === "skill") return;
      const args = output.args;
      const phase = (process.env.AGENT_PHASE || "").toLowerCase();
      const isVerifyPhase = phase.startsWith("verify");

      // Increment sprawl counter on every non-skill tool call.
      // This is the primary increment — the event hook increment is a backup
      // in case tool.execute.before doesn't fire for some tool types.
      incrementStepsSinceLastWrite(state);

      let actionSignature = tool;
      if (tool === "write" || tool === "edit" || tool === "read") {
        actionSignature = `${tool}:${args.filePath || args.path}`;
      } else if (tool === "bash") {
        actionSignature = `bash:${normalizeCommand(args.command || "")}`;
      }

      let semanticGroup: string | undefined;
      const intent = tool === "bash" && args.command ? classifyBashIntent(args.command) : "investigate";

      if (tool === "bash" && args.command) {
        const fileTargets = Array.from(new Set([...extractHeredocFileTargets(args.command), ...extractBashReadTargets(args.command)])).sort();

        if (intent === "investigate") {
          const descKeywords = extractDescriptionKeywords(args.description);
          if (fileTargets.length > 0 && descKeywords) {
            semanticGroup = `bash-investigation:${descKeywords}`;
          } else if (fileTargets.length > 0) {
            semanticGroup = `bash-investigation:files`;
          } else if (descKeywords) {
            semanticGroup = `bash-desc:${descKeywords}`;
          }
        } else {
          semanticGroup = `bash-${intent}:${normalizeCommand(args.command).slice(0, 50)}`;
        }

        if (intent === "investigate" && fileTargets.length > 0) {
          const investigatedFiles = fileTargets.filter(f => !state.agentWrittenFiles.has(f));
          if (investigatedFiles.length > 0 && !isVerifyPhase) {
            const rawFileTargetKey = investigatedFiles.join(",");
            
            if (checkGlobalFileInvestigation(state, rawFileTargetKey)) {
              const count = state.globalFileInvestigations.get(rawFileTargetKey) || 0;
              await throwAfterCompact(buildFileTargetInvestigationError(
                rawFileTargetKey, count, state.options.maxSameFileInvestigations * 2, true
              ), input.sessionID);
            }
            
            const investigationKey = semanticGroup
              ? `${rawFileTargetKey}::${semanticGroup}`
              : rawFileTargetKey;

            if (checkFileTargetInvestigation(state, investigationKey)) {
              const count = state.fileTargetInvestigations.get(investigationKey) || 0;
              await throwAfterCompact(buildFileTargetInvestigationError(
                rawFileTargetKey, count, state.options.maxSameFileInvestigations, false, semanticGroup
              ), input.sessionID);
            }
            
            recordFileTargetInvestigation(state, investigationKey);
            recordGlobalFileInvestigation(state, rawFileTargetKey);
          }
        }

        if (state.hardLoopStreak >= state.options.maxHardLoops) {
          await throwAfterCompact("HARD LOOP DETECTED", input.sessionID);
        }
        const normalized = normalizeCommand(args.command);
        if (checkCommandTimeouts(state, normalized)) {
          handleManualThrow(buildTimeoutLoopError(args.command));
        }
        const heredocTargets = extractHeredocTargets(args.command);
        const isWriteMutation = intent === "write" || intent === "transform";
        if (isWriteMutation) {
          for (const target of heredocTargets) state.agentWrittenFiles.add(target);
          resetStepsSinceLastWrite(state);
          state.hasProducedFirstWrite = true;
        } else if (intent === "setup") {
          state.stepsSinceLastWrite = Math.max(0, state.stepsSinceLastWrite - 1);
        } else {
          const limit = state.hasProducedFirstWrite ? state.options.maxStepsWithoutWrite : state.options.maxStepsWithoutFirstWrite;
          if (state.stepsSinceLastWrite > limit && !isVerifyPhase) {
            await throwAfterCompact(buildExplorationSprawlError(state.stepsSinceLastWrite, limit), input.sessionID);
          }
        }
        const streakReason = checkCommandStreak(state, normalized, isWriteMutation);
        if (streakReason === 'identical_output') {
          const streak = state.commandFrequencies.get(normalized);
          handleManualThrow(buildIdenticalOutputError(args.command, streak!.consecutiveIdenticalOutputs!, state.options.maxRepeatedCommands));
        } else if (streakReason === 'epoch_streak') {
          if (intent !== "setup") {
            const streak = state.commandFrequencies.get(normalized);
            handleManualThrow(buildRepeatedCommandError(args.command, streak!.consecutiveRuns, state.options.maxRepeatedCommands));
          }
        }
        if (isTestCommand(args.command, state.options.testCommandPatterns)) {
          const targets = await extractTestTargets(args.command, ctx.worktree, state.options.matchesTrackedFile, state);
          for (const target of targets) {
            const violation = checkAndRecordTestRun(state, target.pathKey, target.hash, args.command);
            if (violation) handleManualThrow(buildDuplicateTestError(violation.target, violation.hash, violation.runs, violation.max));
          }
          pendingBash.set(input.callID, { normalizedCommand: normalized, mutationEpoch: state.mutationEpoch, testTargets: targets, isWriteMutation });
        } else {
          pendingBash.set(input.callID, { normalizedCommand: normalized, mutationEpoch: state.mutationEpoch, testTargets: [], isWriteMutation });
        }
      } else if (tool === "write" || tool === "edit") {
        resetStepsSinceLastWrite(state);
        const filePath = args.filePath || args.path;
        const content = args.content || args.new_string || args.newString; 
        if (filePath) state.agentWrittenFiles.add(filePath);
        if (filePath && content && state.options.matchesTrackedFile(filePath)) {
          pendingWrites.set(input.callID, { pathKey: filePath, nextHash: hashContent(content) });
        }
      } else if (tool === "task") {
        const subagentType = args.subagent_type || "";
        const description = args.description || "";
        const prompt = args.prompt || "";
        output.args.prompt = "<EXTREMELY_IMPORTANT>\nYou must use the `skill` tool to load superpowers (like 'systematic-debugging') before starting. Always use TDD and test miniaturized scale first.\n</EXTREMELY_IMPORTANT>\n\n" + (output.args.prompt || "");
        const taskKey = `${subagentType}::${normalizeOutputForHashing(description)}`;
        const record = state.subagentFrequencies.get(taskKey) || { count: 0, epoch: state.mutationEpoch };
        if (record.epoch === state.mutationEpoch) {
          if (record.count >= 3) {
            const novelty = record.lastPrompt ? computePromptNovelty(record.lastPrompt, prompt) : 1.0;
            if (novelty < 0.3) {
              throw new Error("🛑 ANTI-LOOP TRIGGERED: You have spawned 3 subagents for this task and all failed. You are stuck in a strategic loop. DO NOT spawn another subagent. DO NOT tweak the existing file. You must delete the file, write a new plan, and test a miniaturized version of the architecture.");
            }
            record.count = 0;
          }
          record.count++;
        } else {
          record.count = 1;
          record.epoch = state.mutationEpoch;
        }
        record.lastPrompt = prompt;
        state.subagentFrequencies.set(taskKey, record);
      }

      if (tool !== "task" && tool !== "skill") {
        const isWriteEdit = tool === "write" || tool === "edit";
        const isBashHeredoc = tool === "bash" && args.command && args.command.includes("<<");
        
        const contentToHash = isWriteEdit 
          ? (args.content || args.newString || args.new_string || "")
          : isBashHeredoc
            ? args.command
            : undefined;

        recordAction(state, {
          signature: actionSignature,
          normalizedSignature: normalizeActionSignature(actionSignature),
          semanticGroup,
          intent: tool === "bash" ? (intent as any) : undefined,
          contentHash: contentToHash !== undefined ? hashContent(contentToHash) : undefined,
        });
        const cycle = detectActionCycle(state);
        if (cycle) {
          const isSetupCycle = cycle.pattern.every(p => p.intent === "setup");
          
          if (!(isSetupCycle && cycle.cycleLength === 1)) {
            if (cycle.severity === 'warning') {
              const cycleError = buildActionCycleError(cycle.cycleLength, cycle.count, cycle.pattern, cycle.semantic);
              const rolledBack = await performRollback(state, cycleError, input.sessionID);
              if (!rolledBack) await throwAfterCompact(cycleError, input.sessionID);
              return;
            } else if (cycle.severity === 'advisory') {
              const advisory = buildActionCycleAdvisory(cycle.cycleLength, cycle.count, cycle.pattern, cycle.semantic);
              if (tool === "bash") {
                const pending = pendingBash.get(input.callID);
                if (pending) pending.advisory = advisory;
              } else if (tool === "write" || tool === "edit") {
                const pending = pendingWrites.get(input.callID);
                if (pending) pending.advisory = advisory;
              }
            }
          }
        }
      }
    },

    "tool.execute.after": async (input: any, output: any) => {
      const { tool } = input;
      const didSucceed = !output.error && output.ok !== false;
      if (didSucceed) {
        state.consecutiveBlockedCalls = 0;
      }

      if (tool === "write" || tool === "edit") {
        const pending = pendingWrites.get(input.callID);
        if (pending && didSucceed) {
          recordFileHash(state, pending.pathKey, pending.nextHash, "write");
          state.hasProducedFirstWrite = true;
          if (pending.advisory) {
            const note = `\n\n${pending.advisory}`;
            if (typeof output.output === "string") output.output += note;
            else output.output = note;
          }
        }
        updateLatestActionRecord(state, {
          outputHash: hashContent(normalizeOutputForHashing(getOutputText(output) || (output?.ok !== false ? "success" : "failure"))),
          isTimeout: isTimeoutResult(output),
        });
        pendingWrites.delete(input.callID);
        return;
      }

      if (tool === "bash") {
        const pending = pendingBash.get(input.callID);
        const didSucceedBash = !output.error && output.ok !== false;
        const isTimeout = isTimeoutResult(output);
        if (didSucceedBash) {
          resetHardLoopStreak(state);
        } else {
          if (state.hardLoopStreak >= state.options.maxHardLoops - 1) {
            pendingBash.delete(input.callID);
            await compactSession(input.sessionID);
            return;
          }
          recordHardLoopViolation(state);
        }
        if (pending && (didSucceedBash || isTimeout)) {
          if (!didSucceedBash || isTimeout) {
             const note = "\n[Harness Note: Command failed or timed out. If you are stuck, invoke the 'systematic-debugging' skill before trying again.]";
             if (typeof output.stderr === "string") output.stderr += note;
             else if (typeof output.output === "string") output.output += note;
             else if (typeof output.error === "string") output.error += note;
             else if (output.error && typeof output.error.message === "string") output.error.message += note;
             else output.stderr = note;
          }
          if (pending.advisory) {
            const note = `\n\n${pending.advisory}`;
            if (typeof output.output === "string") output.output += note;
            else if (typeof output.stderr === "string") output.stderr += note;
            else output.output = note;
          }
          if (didSucceedBash && pending.isWriteMutation) state.mutationEpoch++;
          const outputString = getOutputText(output);
          const outputHash = hashContent(normalizeOutputForHashing(outputString));
          updateLatestActionRecord(state, { outputHash, isTimeout });
          updateCommandStreakAfter(state, pending.normalizedCommand, isTimeout, outputHash);
          // Track output hashes independently of command identity
          if (didSucceedBash && outputHash) {
            const outputStreak = trackOutputHash(state, outputHash);
            if (outputStreak >= state.options.maxConsecutiveIdenticalOutputs) {
              pendingBash.delete(input.callID);
              await throwAfterCompact(
                buildConsecutiveIdenticalOutputError(outputStreak, state.options.maxConsecutiveIdenticalOutputs),
                input.sessionID
              );
            }
          }
          if (didSucceedBash) {
            for (const target of pending.testTargets) {
              updateTestRunAfter(state, target.pathKey, target.hash, pending.normalizedCommand);
            }
          }
        }
        pendingBash.delete(input.callID);
      }
    },
  };
}
