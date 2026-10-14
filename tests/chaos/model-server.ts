import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** What the fake model does with one request. */
export type Step =
  | { say: string }
  | { tool: string; args?: unknown }
  | { status: number; retryAfter?: number }
  | { hang: true }
  | { stall: number }
  | { drop: number }
  | { slow: number };

const chunk = (delta: object, finish?: string) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`;

const words = (text: string) => text.match(/\S+\s*/g) ?? [];
const sentence = "the answer is a long enough sentence to be cut off halfway";

/**
 * An OpenAI-compatible `/chat/completions` server that plays `script[n]` for the nth request (the last step repeats).
 * `stall` and `drop` send that many chunks, then go silent or reset the socket; `slow` sends a chunk every `slow` ms.
 * Resolves to its `/v1` base url, every request body seen, and a `close`.
 */
export const modelServer = async (script: Step[]) => {
  const seen: string[] = [];
  const open = new Set<ServerResponse>();
  const play = (step: Step, res: ServerResponse) => {
    if ("hang" in step) return;
    if ("status" in step) {
      const retry = step.retryAfter
        ? { "retry-after": String(step.retryAfter) }
        : {};
      res.writeHead(step.status, {
        "content-type": "application/json",
        ...retry,
      });
      return void res.end(
        JSON.stringify({ error: { message: `HTTP ${step.status}` } }),
      );
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const call = (name: string, args: unknown) => ({
      tool_calls: [
        {
          index: 0,
          id: "c1",
          function: { name, arguments: JSON.stringify(args ?? {}) },
        },
      ],
    });
    const parts =
      "tool" in step
        ? [chunk(call(step.tool, step.args)), chunk({}, "tool_calls")]
        : [
            ...words("say" in step ? step.say : sentence).map((w) =>
              chunk({ content: w }),
            ),
            chunk({}, "stop"),
          ];
    const limit =
      "stall" in step ? step.stall : "drop" in step ? step.drop : parts.length;
    const delay = "slow" in step ? step.slow : 0;
    const send = (i: number) => {
      if (res.destroyed) return;
      if (i < limit) {
        res.write(parts[i]);
        return void setTimeout(send, delay, i + 1);
      }
      if ("drop" in step) res.socket?.destroy();
      else if (!("stall" in step)) res.end("data: [DONE]\n\n");
    };
    send(0);
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (part) => (body += part));
    req.on("end", () => {
      seen.push(body);
      open.add(res);
      res.on("close", () => open.delete(res));
      play(
        script[Math.min(seen.length, script.length) - 1] ?? { say: "ok" },
        res,
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    seen,
    close: () => {
      for (const res of open) res.socket?.destroy();
      server.close();
    },
  };
};
