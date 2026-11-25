import { createInterface } from 'node:readline';
import { existsSync, watch } from 'node:fs';
import path from 'node:path';

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const { id, method, params } = JSON.parse(line);
  const reply = (result) =>
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  const update = (value) =>
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId: params.sessionId, update: value },
      }) + '\n',
    );
  if (method === 'initialize') reply({ protocolVersion: 1 });
  else if (method === 'session/new') reply({ sessionId: 'synthetic-session', configOptions: [] });
  else if (method === 'session/prompt') {
    if (existsSync(path.join(process.env.CURSOR_CONFIG_DIR, 'direct-contract-fixture'))) {
      const [instructions, body] = params.prompt[0].text.split('\n\nRequest JSON:\n');
      if (instructions.startsWith('Return exactly one JSON object') && body) {
        const request = JSON.parse(body);
        const tag = /CERT_BOARD_TURN_START ([a-f0-9-]{36})/u.exec(instructions)?.[1];
        if (
          instructions.includes('256 UTF-8 bytes') && request.max_tokens === 256 &&
          request.messages[0]?.role === 'user' && request.messages[0]?.content === '合成验收' &&
          request.tools[0]?.function.name === 'read_example' &&
          tag && instructions.includes('CERT_BOARD_TURN_END ' + tag)
        ) {
          for (const text of [
            '正在核对合成资料。\n',
            'CERT_BOARD_TURN_START ' + tag + '\n',
            '{"content":null,"actions":[{"name":"read_example","arguments":{}}]}\n',
            'CERT_BOARD_TURN_END ' + tag,
          ]) update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
        }
      }
      reply({ stopReason: 'end_turn' });
      return;
    }
    if (existsSync(path.join(process.env.CURSOR_CONFIG_DIR, 'empty-response-fixture'))) {
      reply({ stopReason: 'end_turn' });
      return;
    }
    update({ sessionUpdate: 'tool_call' });
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
