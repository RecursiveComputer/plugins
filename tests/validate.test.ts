import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// @ts-expect-error -- plain ESM script without declarations
import { checkImports } from '../scripts/validate.mjs';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-validate-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('checkImports', () => {
  it('accepts the SDK, npm packages and the plugin\'s own files', () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), [
      "import { defineOperation, type ToolResult } from '@recursivecomputer/plugin-sdk';",
      "import sharp from 'sharp';",
      "import { helper } from './lib/helper.ts';",
    ].join('\n'));
    expect(checkImports(dir)).toEqual({ problems: [], sdkValues: [] });
  });

  it('rejects internal packages, unpublished scoped packages and escapes', () => {
    const file = path.join(dir, 'a.ts');
    fs.writeFileSync(file, [
      "import { getPluginSettings } from '@recursive/core-db';",
      "import ui from '@recursivecomputer/plugin-ui';",
      "import x from '../../elsewhere/x.ts';",
    ].join('\n'));
    const { problems } = checkImports(dir);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain('internal to Recursive');
    expect(problems[1]).toContain('not published');
    expect(problems[2]).toContain('reaches outside the plugin');
  });

  it('reports SDK values that need host API 2', () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), "import { toolFailure, defineOperation } from '@recursivecomputer/plugin-sdk';");
    expect(checkImports(dir).sdkValues).toEqual(['toolFailure']);
  });
});
