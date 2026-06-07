import type { ActionRecord } from "./types.js";

export function buildExplorationSprawlError(steps: number, max: number): string {
  return `
🚨🚨🚨 EXPLORATION SPRAWL DETECTED 🚨🚨🚨

STOP.
You have completed ${steps} steps without writing any code (limit: ${max}).
Even though you may be running different diagnostic commands, you are stuck in an exploration loop and failing to produce artifacts.

YOU MUST:
1. STOP reading reference code.
2. STOP running diagnostic commands.
3. WRITE your implementation file NOW using the information you already have.

DO NOT RUN ANOTHER READ-ONLY COMMAND.
`.trim();
}

export function buildConsecutiveIdenticalOutputError(streak: number, max: number): string {
  return `🛑 ANTI-LOOP: Your last ${streak} commands ALL produced identical output (limit: ${max}). You are stuck in a diagnosis loop — writing different scripts that test the same thing. STOP writing diagnostic scripts. You already know what the problem is. Write a FIX instead.`;
}

export function buildFileTargetInvestigationError(
  fileTargetKey: string, 
  count: number, 
  max: number,
  isGlobal: boolean = false,
  semanticGroup?: string
): string {
  const scopeMsg = isGlobal 
    ? `total investigations across all topics` 
    : (semanticGroup ? `investigations of the same topic ("${semanticGroup}")` : `investigations`);

  return `
🚨🚨🚨 INVESTIGATION LOOP DETECTED 🚨🚨🚨

STOP.
You have written ${count} different scripts that all perform ${scopeMsg} on the same data file(s): ${fileTargetKey}
(limit: ${max})

Even though each script has a different name and slightly different code, you are
repeating the same investigation without making progress.

YOU MUST:
1. STOP writing diagnostic scripts.
2. COMMIT to the facts you have already learned.
3. If you need more data, use a REFERENCE IMPLEMENTATION (e.g., install the canonical library and run a single authoritative comparison).
4. Move forward with writing the actual solution code.

DO NOT write another diagnostic script targeting these files.
`.trim();
}

export function buildDuplicateTestError(
  target: string,
  hash: string,
  runs: number,
  max: number
): string {
  return `
🚨🚨🚨 ANTI-LOOP BLOCKED THIS TEST COMMAND 🚨🚨🚨

STOP.
YOU ARE RE-RUNNING A TEST AGAINST AN UNCHANGED TARGET.
THIS IS A LOOP. THIS WILL NOT PRODUCE NEW INFORMATION.

TARGET: ${target}
HASH: ${hash.slice(0, 12)}
UNCHANGED TEST RUNS: ${runs}
THRESHOLD: ${max}

REQUIRED NEXT ACTION:
- Change the file being tested, OR
- Change the evaluation strategy, OR
- Explicitly explain why another identical run is justified.

DO NOT RUN THE SAME TEST AGAIN WITHOUT A REAL CHANGE.
ABANDON THE CURRENT APPROACH.
`.trim();
}

export function buildRepeatedCommandError(cmd: string, runs: number, max: number): string {
  return `
🚨🚨🚨 COMMAND LOOP DETECTED 🚨🚨🚨

STOP.
THE EXACT SAME BASH COMMAND HAS BEEN RUN TOO MANY TIMES
WITHOUT A TRACKED FILE CHANGE.

COMMAND: ${cmd}
CONSECUTIVE RUNS: ${runs}
THRESHOLD: ${max}

THIS IS WASTING TOKENS AND TIME.
PICK A DIFFERENT ACTION NOW:
- edit code
- change the test
- inspect results
- abandon the current strategy

DO NOT RETRY THIS COMMAND IMMEDIATELY.
`.trim();
}

export function buildTimeoutLoopError(cmd: string): string {
  return `
🚨🚨🚨 TIMEOUT LOOP DETECTED 🚨🚨🚨

STOP.
THIS BASH COMMAND HAS TIMED OUT MULTIPLE TIMES.

COMMAND: ${cmd}

THERE IS LIKELY AN INFINITE LOOP OR SEVERE PERFORMANCE BUG.
THIS WILL WASTE TOKENS AND KILL THE AGENT.

REQUIRED NEXT ACTION:
- Do NOT run this command again blindly.
- Add debug prints (e.g. printf, console.log) inside the main loop.
- Compile with sanitizers.
- Reduce the scope of the run to pinpoint where it hangs.
`.trim();
}

export function buildIdenticalOutputError(cmd: string, runs: number, max: number): string {
  return `
🚨🚨🚨 IDENTICAL OUTPUT LOOP DETECTED 🚨🚨🚨

STOP.
THE COMMAND "${cmd}" HAS PRODUCED THE EXACT SAME OUTPUT ${runs} TIMES IN A ROW (LIMIT: ${max}).

Even though you may be changing files, the changes are having NO EFFECT on the command's output.
You are stuck in a "guess and check" loop.

REQUIRED NEXT ACTION:
- Stop guessing.
- Write a diagnostic script to understand the problem.
- Print the variables or state that you think you are changing.
- Review the code carefully instead of blindly recompiling.
`.trim();
}

export function buildActionCycleAdvisory(
  cycleLength: number,
  count: number,
  pattern: ActionRecord[],
  semantic: boolean = false
): string {
  const type = semantic ? "conceptual" : "action";
  return `
[Anti-Loop Advisory] You have repeated the same ${type} pattern ${count} times (Length: ${cycleLength}).
If your results are improving or you are following a systematic iteration plan, you may continue.
If you are stuck in a "guess and check" loop, consider a different approach.
`.trim();
}

export function buildActionCycleError(
  cycleLength: number,
  count: number,
  pattern: ActionRecord[],
  semantic: boolean = false
): string {
  if (semantic) {
    return `
🚨🚨🚨 SEMANTIC LOOP DETECTED 🚨🚨🚨

STOP.
You have repeated the same conceptual investigation ${count} times.
Even though you are using different script names or slightly different commands, you are investigating the same files or topics repeatedly.

Cycle Length: ${cycleLength}
Pattern Topics:
${pattern.map(p => `  - ${p.semanticGroup || p.signature}`).join("\n")}

YOU ARE STUCK IN AN EXPLORATION LOOP.
1. STOP running diagnostic scripts.
2. COMMIT to the facts you have already learned.
3. If you are unsure, write a high-level reference implementation (e.g., in Python) to verify your assumptions end-to-end before writing low-level code.
4. Move forward with implementation.
`.trim();
  }

  return `
🚨🚨🚨 SYSTEM OVERRIDE: ANTI-LOOP DETECTED 🚨🚨🚨

STOP.
You have repeated the same sequence of actions ${count} times.
Cycle Length: ${cycleLength}
Pattern:
${pattern.map(p => `  - ${p.signature}`).join("\n")}

Even if the file contents or compiler outputs differ slightly, YOUR STRATEGY IS LOOPING. You are stuck in a local maximum and are not making progress.

YOU MUST:
1. PIVOT your current approach.
2. Review the output of your previous attempts to understand why they didn't meet the target.
3. Propose a fundamentally different architecture or strategy.

DO NOT REPEAT THESE ACTIONS.
`.trim();
}
