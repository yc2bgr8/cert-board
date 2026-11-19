import { createServer } from 'node:http';

export type LocalModelFixtureRequest = {
  pathname: string | undefined;
  authorization: string | undefined;
  body: unknown;
};

export async function startLocalModelFixture(
  respond: (request: LocalModelFixtureRequest) => unknown | Promise<unknown>,
) {
  const server = createServer(async (incoming, outgoing) => {
    try {
      let input = '';
      for await (const part of incoming.setEncoding('utf8')) {
        input += part;
        if (Buffer.byteLength(input) > 262144) throw new Error('LOCAL_FIXTURE_INPUT_LIMIT');
      }
      const response = await respond({
        pathname: incoming.url,
        authorization: incoming.headers.authorization,
        body: JSON.parse(input),
      });
      if (response !== undefined)
        outgoing
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(response));
    } catch {
      outgoing.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('LOCAL_FIXTURE_ADDRESS');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
