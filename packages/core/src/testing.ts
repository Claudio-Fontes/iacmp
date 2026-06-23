import * as path from 'path';
import { Stack, BaseConstruct } from './stack';

export interface TestableStack {
  readonly raw: Stack;
  findResource(id: string): BaseConstruct | undefined;
}

export const Testing = {
  loadStack(relativePath: string): TestableStack {
    const resolved = path.resolve(process.cwd(), relativePath);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(resolved) as Record<string, unknown>;
    const stack = (mod.default ?? mod) as Stack;
    if (!stack || !Array.isArray((stack as Stack).constructs)) {
      throw new Error(`"${relativePath}" não exporta uma Stack válida (export default).`);
    }
    return {
      raw: stack,
      findResource(id: string): BaseConstruct | undefined {
        return stack.constructs.find((c) => c.id === id);
      },
    };
  },
};
