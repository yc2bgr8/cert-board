import { createInterface } from 'node:readline';
import { existsSync, watch } from 'node:fs';
import path from 'node:path';

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  const reply = (result) =>
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  if (method === 'initialize') reply({ protocolVersion: 1 });
  else if (method === 'session/new') reply({ sessionId: 'synthetic-session', configOptions: [] });
  else if (method === 'session/prompt') {
    if (existsSync(path.join(process.env.CURSOR_CONFIG_DIR, 'empty-response-fixture'))) {
      reply({ stopReason: 'end_turn' });
      return;
    }
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: params.sessionId, update: { sessionUpdate: 'tool_call' } },
      }) + '\n',
    );
    reply({ stopReason: 'end_turn' });
  } else if (method === 'session/set_config_option') {
    if (params.configId === 'model') {
      watch(process.env.CURSOR_CONFIG_DIR, (_kind, filename) => {
        if (String(filename) === 'exit-fixture') process.exit(0);
      });
    }
    reply({
      configOptions: [
        { id: params.configId, category: params.configId, currentValue: params.value },
      ],
    });
  }
});
