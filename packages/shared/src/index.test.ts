import { expect, test } from 'vitest';
import { dataLevels } from './index.js';
test('资料级别目录包含三个级别', () =>
  expect(dataLevels).toEqual(['public', 'internal', 'confidential']));
