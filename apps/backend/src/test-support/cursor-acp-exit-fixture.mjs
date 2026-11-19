import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  const reply = (result) =>
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  if (method === 'initialize') reply({ protocolVersion: 1 });
  else if (method === 'session/new') reply({ sessionId: 'synthetic-session', configOptions: [] });
  else if (method === 'session/set_config_option') {
    reply({
      configOptions: [
        { id: params.configId, category: params.configId, currentValue: params.value },
      ],
    });
    if (params.configId === 'model') setTimeout(() => process.exit(0), 20);
  }
});
