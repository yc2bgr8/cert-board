import { parseArgs } from 'node:util';
import { parseBackendConfig, testEmailOptionsSchema } from '@cert-board/shared';
import { createDependencies } from '../dependencies.js';
import { processTestOutbound } from './service.js';
import { processTestWechatCopy } from './wechat-copy.js';

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      simulate: { type: 'string' },
      'sent-folder': { type: 'string' },
      retry: { type: 'string' },
    },
  });
  const [channel, id] = positionals;
  if (!id || positionals.length !== 2 || !['email', 'wechat'].includes(channel ?? ''))
    throw new Error('INVALID_SIMULATION_COMMAND');
  const config = parseBackendConfig(process.env);
  if (!['development', 'test'].includes(config.NODE_ENV)) throw new Error('SIMULATION_DISABLED');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(config.DATABASE_URL).hostname))
    throw new Error('SIMULATION_LOOPBACK_REQUIRED');
  const resources = createDependencies(config);
  try {
    if (channel === 'email') {
      if (values.retry !== undefined) throw new Error('MAIL_SIMULATION_NO_RETRY');
      const outcome = await processTestOutbound(
        resources.database,
        id,
        testEmailOptionsSchema.parse({
          ...(values.simulate === undefined ? {} : { simulate: values.simulate }),
          ...(values['sent-folder'] === undefined ? {} : { sentFolder: values['sent-folder'] }),
        }),
      );
      console.log(
        JSON.stringify({
          dispatchId: outcome.dispatchId,
          status: outcome.status,
          attempts: outcome.attempts,
        }),
      );
    } else {
      if (values['sent-folder'] !== undefined) throw new Error('WECHAT_SIMULATION_NO_SENT_FOLDER');
      const outcome = await processTestWechatCopy(resources.database, id, {
        initial: values.simulate ?? 'success',
        retry: values.retry ?? 'success',
      });
      console.log(JSON.stringify(outcome));
    }
  } finally {
    await resources.close();
  }
}

main().catch(() => {
  console.error('本地外发模拟未完成。请核对开发环境、队列或提醒编号及模拟参数。');
  process.exitCode = 1;
});
