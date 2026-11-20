import pg from 'pg';

export async function previewIsIdle(databaseUrl: string) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 3000,
  });
  try {
    const result = await pool.query<{ idle: boolean }>(`
      SELECT NOT EXISTS (SELECT 1 FROM run WHERE status IN ('queued','running','waiting'))
         AND NOT EXISTS (SELECT 1 FROM external_model_conversation WHERE state='discussing')
         AND NOT EXISTS (SELECT 1 FROM run_continuation WHERE state IN ('pending','queued','claimed','tool_recorded','model_started'))
         AS idle
    `);
    return result.rows[0]?.idle === true;
  } finally {
    await pool.end();
  }
}
