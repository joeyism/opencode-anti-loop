import type { PluginInput, Hooks } from "@opencode-ai/plugin";
import { resolveOptions } from "./config.js";
import { createState } from "./state.js";
import { createHooks } from "./hooks.js";
import type { AntiLoopOptions } from "./types.js";

const antiLoop = async (ctx: PluginInput, options?: AntiLoopOptions): Promise<Hooks> => {
  const resolved = resolveOptions(options);
  const state = createState(resolved);
  return createHooks(ctx, state);
};

export { antiLoop };
export default antiLoop;
