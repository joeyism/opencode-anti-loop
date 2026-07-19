# OpenCode Anti-Loop Plugin

Detects and blocks infinite agent loops — duplicate tests, repeated commands, identical outputs, exploration sprawl, zombie steps, truncation, and more — through layered detection with configurable escalation.

## Why Use It

AI coding agents can get stuck in loops: re-running the same test against unchanged code, re-executing failed commands, writing endless diagnostic scripts that investigate the same data, or cycling through the same edit→build→run sequence without progress. These loops waste tokens, time, and can run indefinitely.

This plugin intercepts the agent's tool lifecycle and blocks loops before they spiral. It detects:

- **Exact repetition** — same command, same output, same test against same code
- **Semantic repetition** — different script names investigating the same files
- **Strategic loops** — cycling through the same action sequence
- **Exploration sprawl** — many steps without producing any output
- **Zombie loops** — steps with zero reasoning tokens
- **Timeout loops** — commands that keep timing out
- **Output truncation** — steps that hit the model's output token limit without emitting a tool call

When a loop is detected, the plugin blocks the action with a descriptive error guiding the agent to change approach. If the agent keeps getting blocked, the plugin escalates to session compaction and (optionally) rollback.

## Installation

```bash
npm install opencode-anti-loop
```

## Quick Start

Add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-anti-loop"
  ]
}
```

To pass configuration options, use the tuple form:

```json
{
  "plugin": [
    ["opencode-anti-loop", { "maxRepeatedCommands": 5 }]
  ]
}
```

## Table of Contents

- [Why Use It](#why-use-it)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [How It Works](#how-it-works)
  - [Detection Modes](#detection-modes)
  - [Detection Details](#detection-details)
  - [Phase Awareness](#phase-awareness)
  - [Escalation Behavior](#escalation-behavior)
  - [Behavioral Side Effects](#behavioral-side-effects)
- [Tool Coverage](#tool-coverage)
- [Setup Command Exemptions](#setup-command-exemptions)
- [Configuration](#configuration)
  - [Options](#options)
  - [Examples](#examples)
- [Limitations](#limitations)
- [Programmatic Usage](#programmatic-usage)
- [License](#license)

## How It Works

The plugin hooks into three points of OpenCode's tool lifecycle (`event`, `tool.execute.before`, `tool.execute.after`) and runs ~11 independent detectors in parallel. Each targets a specific loop pathology.

### Detection Modes

| Detector | What it catches | Default | Action |
|---|---|---|---|
| Duplicate test | Re-running tests against unchanged code | 2 runs | Block |
| Command streak | Same normalized command without file changes | 3 runs/epoch | Block |
| Identical output (per-command) | Same command producing identical output | 3 runs | Block |
| Identical output (global) | Any consecutive commands producing identical output | 5 streak | Block |
| Timeout loop | Same command timing out repeatedly | 2 timeouts | Block |
| Action cycle (exact) | Repeated sequence of identical actions | 6 repeats | Block (5 = advisory) |
| Action cycle (semantic) | Repeated conceptual investigation pattern | 8 repeats | Block (7 = advisory) |
| Zombie loop | Steps with zero reasoning tokens | 3 steps | Block |
| Hard loop | Consecutive failed bash commands | 3 failures | Block |
| Exploration sprawl | Steps without writing code | 8 (pre-first-write) / 20 (after) | Block |
| File investigation | Repeatedly probing the same data files | 12 per group / 24 global | Block |
| Subagent loop | Repeated subagent spawns with similar prompts | 3 spawns + <30% novelty | Block |
| Output truncation | Step ends with `reason: "length"` or output > 16K tokens | — | Inject "act now" prompt |

### Detection Details

Here is a detailed breakdown of each detection mode, including examples of what gets caught and why blocking it makes sense:

#### 1. Duplicate Test
* **What gets caught**: Running `pytest tests/test_math.py` twice in a row without modifying any files in the workspace.
* **Why it makes sense**: Running a test against unchanged code cannot produce new information. It wastes tokens and time. The agent must change the code or the test before running it again.

#### 2. Command Streak
* **What gets caught**: Running `python run.py` 3 times in a row without any file writes or edits in between.
* **Why it makes sense**: If the agent runs the exact same command repeatedly without changing any files, the output will be identical. This is a classic "stuck" loop where the agent is waiting for a different result without taking action.

#### 3. Identical Output (Per-Command)
* **What gets caught**: Running `python run.py`, then editing a file, then running `python run.py` again, and repeating this 3 times, where the output of `python run.py` is exactly the same every time.
* **Why it makes sense**: Even though the agent is editing files, the edits are having absolutely no effect on the command's output. The agent is stuck in a "guess and check" loop. It needs to stop guessing and write a diagnostic script or print variables to understand why its changes are inert.

#### 4. Identical Output (Global)
* **What gets caught**: Running `python test1.py`, then `python test2.py`, then `python test3.py`, where all of them output `Error: database connection failed`.
* **Why it makes sense**: The agent is writing different scripts to test the same underlying issue. It already knows the database connection is failing; writing more diagnostic scripts won't fix it. It needs to stop diagnosing and write a fix.

#### 5. Timeout Loop
* **What gets caught**: Running `gcc main.c && ./a.out` twice, and both times the command times out (takes >120s or is terminated).
* **Why it makes sense**: The code likely has an infinite loop or a severe performance bug. Running it again blindly will just time out again, wasting tokens and killing the agent. The agent must add debug prints or reduce the scope of the run to find the hang.

#### 6. Action Cycle (Exact)
* **What gets caught**: Repeating the sequence `[edit file.c, gcc file.c]` 6 times in a row, where the file content and compiler output are identical in each cycle.
* **Why it makes sense**: The agent is stuck in a local maximum, repeating the exact same sequence of actions. It needs to pivot its strategy and try a fundamentally different approach.

#### 7. Action Cycle (Semantic)
* **What gets caught**: Repeating the sequence `[write check_weights1.py, python check_weights1.py]` then `[write check_weights2.py, python check_weights2.py]` with the same description "Check weights layout" 8 times.
* **Why it makes sense**: Even though the script names are different, the conceptual investigation is identical. The agent is looping strategically. It needs to commit to the facts it has learned and move forward with implementation.

#### 8. Zombie Loop
* **What gets caught**: The agent completes 3 consecutive steps where its reasoning token count is 0 (it just calls tools without any internal thought/reasoning).
* **Why it makes sense**: The agent is acting on autopilot without thinking. This often happens when it gets confused or stuck in a tool-execution loop. Forcing a block forces the agent to stop and reason.

#### 9. Hard Loop
* **What gets caught**: Running 3 consecutive bash commands that all fail (exit code != 0 or error output).
* **Why it makes sense**: The agent is blindly retrying failing commands or guessing syntax. It needs to stop, read the error message, and use a systematic debugging approach instead of guessing.

#### 10. Exploration Sprawl
* **What gets caught**: Running 9 read-only commands (like `cat`, `grep`, `ls`) before writing any code, or running 21 read-only commands after the first write.
* **Why it makes sense**: The agent is stuck in "analysis paralysis" or exploration sprawl — reading endless files and running diagnostics without actually producing any deliverables. It needs to stop reading and start writing.

#### 11. File Investigation
* **What gets caught**: Writing 13 different scripts that all read and print parts of `gpt2-124M.ckpt`.
* **Why it makes sense**: The agent is repeatedly probing the same data file without making progress. It needs to commit to the facts it has already learned from the file and move on to writing the solution.

#### 12. Subagent Loop
* **What gets caught**: Spawning a `fixer` subagent 4 times with the prompt "Write GPT-2 in C" where the prompt novelty is very low.
* **Why it makes sense**: The agent is repeatedly delegating the same task to subagents and failing. It needs to stop spawning subagents, write a new plan, and test a miniaturized version of the architecture itself.

#### 13. Output Truncation
* **What gets caught**: A step finishes with `reason: "length"` (the model hit its output token limit) or produced more than 16,000 output tokens.
* **Why it makes sense**: When a model over-thinks a problem, it can spend its entire output budget on reasoning without ever emitting a tool call. The step ends with `reason: "length"` and no file was written, no command was run — the agent produced nothing. The plugin detects this and injects a prompt telling the agent to make a tool call immediately, limiting reasoning to 3-5 lines.
* **How it works**: On every `step-finish` event, the plugin checks `part.reason` and `part.tokens.output`. If `reason === "length"` or `output > 16000`, it calls `ctx.client.session.prompt()` to inject a message: *"⚠️ OUTPUT TRUNCATION DETECTED: Your previous response produced N tokens and was cut off. You MUST make a tool call (write, bash, or edit) in your next response. Limit reasoning to 3-5 lines. Act immediately."*
* **Note**: This detector fires even when `tokens.reasoning` is absent (as is the case with models like GLM-5.2 that don't separate reasoning tokens). The zombie-loop detector alone would miss this case because it requires `typeof reasoning === "number"`.

### Normalization & Progress Tracking

Commands are normalized before tracking — incrementing filenames (`file1.c` → `file.c`), heredoc bodies, and cosmetic variations collapse to one key, so the agent can't evade detection by renaming things. Output is similarly normalized (line numbers, timestamps, memory addresses stripped) before hashing. Genuine progress is not penalized: different content hashes or output hashes break cycles.

### Phase Awareness

The plugin reads the `AGENT_PHASE` environment variable to adjust its behavior during different phases of an agent pipeline (e.g., FrankCode's main → verify → fix cycle).

| Phase prefix | What's skipped | What still runs |
|---|---|---|
| `verify_*` | Exploration sprawl, file-target investigation, global file investigation | Duplicate test, command streak, timeout loop, hard loop, action cycle, subagent loop, truncation detection |
| `fix_*` | (no exemptions — same as main) | All detectors active |
| `main` or unset | (no exemptions) | All detectors active |

**Why**: During verification phases, the agent's primary job is to read deliverables and test output — activities that would normally trigger exploration sprawl or file-investigation detectors. These detectors produce false positives during verification, blocking the agent from doing its job. The phase awareness feature ensures that only genuinely harmful loops (duplicate tests, repeated commands, etc.) are blocked during verification.

**How to set the phase**: The orchestrator (e.g., FrankCode) sets `AGENT_PHASE` in the environment before launching each opencode session. The value is typically `main`, `verify_1`, `verify_2`, `fix_1`, `fix_2`, etc.

```bash
AGENT_PHASE=verify_1 opencode run "verify the deliverables..."
```

### Escalation Behavior

When a detector triggers, the plugin throws an error with a descriptive message guiding the agent to change approach. If the agent keeps getting blocked, the plugin escalates:

1. **Advisory** (at N-1 threshold): A note is appended to the tool output suggesting the agent reconsider its approach. Does not block.
2. **Block** (at N threshold): The action is blocked with a 🚨/🛑 error message.
3. **Compact + redirect** (5+ consecutive blocks): The session is compacted and a "SYSTEM OVERRIDE" prompt is injected demanding the agent write code. Investigation counters are reset.
4. **Rollback** (10+ consecutive blocks, if `allowRollback: true`): The session is reverted to an earlier message via `session.revert`, and the agent is prompted to try a fundamentally different approach. Max 1 rollback per session.

> ⚠️ **Rollback is aggressive.** It reverts the agent's session state (conversation history) to an earlier point and injects a system prompt. Files written by the agent may still exist on disk after rollback — only the conversation context is rolled back. Only enable `allowRollback` if you understand this. Defaults to `false`.

### Behavioral Side Effects

Besides blocking, the plugin modifies tool outputs and subagent prompts:

| Behavior | When | What happens |
|---|---|---|
| Subagent prompt injection | Every `task` call | Prepends an `<EXTREMELY_IMPORTANT>` block mandating use of the `skill` tool and TDD |
| Harness notes | Failed/timed-out bash | Appends a note suggesting the `systematic-debugging` skill |
| Advisory notes | Approaching cycle limits | Appends a note to tool output |
| Session compaction | 5+ consecutive blocks | Calls `session.summarize` |
| System override injection | 5+ consecutive blocks | Injects a `session.prompt` demanding the agent write code |
| Truncation prompt injection | Step ends with `reason: "length"` or output > 16K | Injects a `session.prompt` telling the agent to make a tool call immediately |

> ⚠️ **Subagent prompt injection cannot be disabled.** Every subagent spawned via the `task` tool gets an `<EXTREMELY_IMPORTANT>` instruction prepended, mandating use of the `skill` tool and TDD. If you don't use the "superpowers" skill system, this injection will still appear in your subagent prompts.

## Tool Coverage

| Tool | Monitored | How |
|---|---|---|
| `bash` | Yes | Command normalization, intent classification, streak tracking, output hashing, file-target extraction, test detection |
| `write` | Yes | File hash tracking, mutation epoch increment, action cycle detection |
| `edit` | Yes | Same as `write` |
| `read` | Partial | Tracked in action history for cycle detection; increments sprawl counter |
| `task` | Yes | Subagent frequency tracking, prompt novelty computation, prompt injection |
| `skill` | No | Explicitly exempt |
| `event` (step-finish) | Yes | Zombie loop detection, output truncation detection |

## Setup Command Exemptions

The following commands are classified as "setup" intent and exempt from command streak detection (retrying them is often legitimate due to network/IO flakiness):

- `pip install`, `pip3 install`, `python3 -m pip install`
- `npm install`, `npm add`, `npx install`, `yarn install/add`, `pnpm install/add`
- `apt-get install`, `apt install`, `apk add`, `yum install`, `dnf install`, `pacman install`
- `cargo install`, `rustup`, `go install`, `gem install`, `brew install`
- `curl`/`wget` with `install`, `setup`, `build`, `bootstrap`, `configure`, or `.sh` in the command

**Note:** Setup commands are still subject to identical-output detection (if `pip install` produces the same output 3 times, it's blocked) and timeout detection (2 timeouts = blocked).

## Configuration

### Options

| Option | Type | Default | Description |
|---|---|---|---|
| `maxIdenticalTests` | `number` | `2` | Max times a test can run against unchanged target code |
| `maxRepeatedCommands` | `number` | `3` | Max consecutive runs of the same normalized command per mutation epoch |
| `maxConsecutiveIdenticalOutputs` | `number` | `5` | Max consecutive commands (any command) producing identical output |
| `maxCyclicalActionRepeats` | `number` | `6` | Max exact action-cycle repeats before blocking (advisory at N-1) |
| `maxSemanticCycleRepeats` | `number` | `8` | Max semantic/conceptual cycle repeats before blocking (advisory at N-1) |
| `maxZombieSteps` | `number` | `3` | Max consecutive steps with zero reasoning tokens |
| `maxHardLoops` | `number` | `3` | Max consecutive failed bash commands |
| `maxSameFileInvestigations` | `number` | `12` | Max investigations of the same file group (global cap is 2× this) |
| `maxStepsWithoutWrite` | `number` | `20` | Max steps without a write, after the first write |
| `maxStepsWithoutFirstWrite` | `number` | `8` | Max steps before the first write |
| `trackedFilePatterns` | `string[]` | `["*"]` | Glob patterns for files to track for hash-based detection |
| `testCommandPatterns` | `string[]` | `["pmars", "pytest", "npm test", "cargo test", "go test", "make test", "./test.sh"]` | Command substrings that identify test commands |
| `allowRollback` | `boolean` | `false` | Enable session rollback on persistent loops (see Escalation Behavior) |

> Defaults are defined in `src/config.ts`. If you change them in code, update this table to match.

> **Truncation threshold** is hardcoded at 16,000 output tokens in `src/hooks.ts`. It is not configurable via plugin options. To change it, modify the `TRUNCATION_THRESHOLD` constant.

### Examples

**Less aggressive (raise thresholds):**

```json
{
  "plugin": [
    ["opencode-anti-loop", {
      "maxRepeatedCommands": 5,
      "maxCyclicalActionRepeats": 10,
      "maxStepsWithoutWrite": 30
    }]
  ]
}
```

**Track only Python files:**

```json
{
  "plugin": [
    ["opencode-anti-loop", {
      "trackedFilePatterns": ["**/*.py"],
      "testCommandPatterns": ["pytest", "python -m pytest"]
    }]
  ]
}
```

**Enable rollback:**

```json
{
  "plugin": [
    ["opencode-anti-loop", {
      "allowRollback": true
    }]
  ]
}
```

> ⚠️ See [Escalation Behavior](#escalation-behavior) before enabling rollback.

## Limitations

- **All detectors are always active.** There is no per-detector disable. To effectively disable one, set its threshold to a very high number.
- **No bypass or whitelist.** If a detector triggers, the action is blocked. There is no "allow this once" flag.
- **State is in-memory only.** Tracking resets when OpenCode restarts. The agent gets a clean slate on each session.
- **No logging or telemetry.** The plugin is silent during normal operation. You'll only see output when a detector triggers or an advisory note is appended.
- **Rollback reverts session state, not the filesystem.** Files written by the agent may still exist on disk after rollback.
- **Subagent prompt injection cannot be disabled.** Every `task` call gets an `<EXTREMELY_IMPORTANT>` instruction prepended.
- **Truncation threshold is not configurable.** The 16K-token threshold is hardcoded. To change it, modify `src/hooks.ts`.
- **Phase awareness requires `AGENT_PHASE` env var.** Without it, all detectors run at full strength regardless of phase.

## Programmatic Usage

```typescript
import { antiLoop } from "opencode-anti-loop";

// Called by OpenCode's plugin loader with (ctx, options)
// Returns a Hooks object
```

## License

[MIT](LICENSE)
