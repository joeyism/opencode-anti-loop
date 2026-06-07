import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/types.ts', 'src/errors.ts', 'src/index.ts', 'src/config.ts', 'src/command.ts', 'src/state.ts'],
      all: true,
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100
    }
  }
});
