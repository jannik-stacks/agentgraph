/**
 * How long a harness waits for a model's response to start, and then between streamed chunks, before it gives up on
 * the request and retries it: longer than the model proxy's own stream timeout, well inside the runner's stall watch.
 */
export const modelTimeouts = { headersMs: 120_000, idleMs: 180_000 };
