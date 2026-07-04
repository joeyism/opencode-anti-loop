# OpenCode Anti-Loop Plugin

Detects and blocks infinite agent loops — duplicate tests, repeated commands, identical outputs, exploration sprawl, zombie steps, and more — through layered detection with configurable escalation.

## Why Use It

AI coding agents can get stuck in loops: re-running the same test against unchanged code, re-executing failed commands, writing endless diagnostic scripts that investigate the same data, or cycling through the same edit→build→run sequence without progress. These loops waste tokens, time, and can run indefinitely.

This plugin intercepts the agent's tool lifecycle and blocks loops before they spiral. It detects:

- **Exact repetition** — same command, same output, same test against same code
- **Semantic repetition** — different script names investigating the same files
- **Strategic loops** — cycling through the same action sequence
- **Exploration sprawl** — many steps without producing any output
- **Zombie loops** — steps with zero reasoning tokens
- **Timeout loops** — commands that keep timing out

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

## How It Works

The plugin hooks into three points of OpenCode's tool lifecycle (`event`, `tool.execute.before`, `tool.execute.after`) and runs ~10 independent detectors in parallel. Each targets a specific loop pathology.

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

Commands are normalized before tracking — incrementing filenames (`file1.c` → `file.c`), heredoc bodies, and cosmetic variations collapse to one key, so the agent can't evade detection by renaming things. Output is similarly normalized (line numbers, timestamps, memory addresses stripped) before hashing. Genuine progress is not penalized: different content hashes or output hashes break cycles.

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

## Programmatic Usage

```typescript
import { antiLoop } from "opencode-anti-loop";

// Called by OpenCode's plugin loader with (ctx, options)
// Returns a Hooks object
```

## License

[MIT](LICENSE)
