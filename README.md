# OpenCode Anti-Loop Plugin

OpenCode plugin that detects and blocks infinite agent loops by tracking file hashes and command repetition

## Installation

```bash
npm install opencode-anti-loop
```

## Features

- Detects repetitive command execution with identical outputs.
- Prevents "Zombie Loops" where the agent fails to take action.
- Tracks file modifications to prevent infinite testing loops.
- Rolls back state when the agent is stuck in an exploration sprawl.

## Usage

This is a plugin for [OpenCode](https://github.com/opencode-ai). 

You can easily enable this plugin globally by adding it to your `opencode.json` (or `opencode.jsonc`) configuration file under the `plugins` array.

```json
{
  "plugins": [
    "opencode-anti-loop"
  ]
}
```

Once added to your configuration, OpenCode will automatically load and activate the plugin whenever it starts.

Alternatively, if you are configuring OpenCode programmatically via the SDK, you can register it like this:

```typescript
import { configureAgent } from '@opencode-ai/sdk';
import plugin from 'opencode-anti-loop';

const agent = configureAgent({
  plugins: [
    plugin({
      // Provide configuration options here
    })
  ]
});
```

## License

[MIT](LICENSE)
