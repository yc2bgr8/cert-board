import { expect, test } from 'vitest';
import { serviceName } from './index.js';
test('后端包可以加载', () => expect(serviceName).toBe('cert-board-backend'));
