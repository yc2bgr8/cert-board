import { expect, test } from 'vitest';
import { applicationName } from './index.js';
test('界面包可以加载', () => expect(applicationName).toBe('器械认证'));
