import { expect, test } from "bun:test";
import { produceTraceJson, TraceProducerFailure } from "../src";

test("Trace producer derives kept without an expected trace", async () => {
  const input = await Bun.file(new URL("trace-producer/input-kept.json", import.meta.url)).text();
  const trace = produceTraceJson(input) as {
    events: Array<{ routing: { fill: Array<{ status: string }> } }>;
  };
  expect(trace.events[0].routing.fill[0].status).toBe("kept");
});

test("Trace producer rejects strict substitution", async () => {
  const input = await Bun.file(
    new URL("trace-producer/input-strict-substitution.json", import.meta.url),
  ).text();
  try {
    produceTraceJson(input);
    throw new Error("expected strict substitution to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(TraceProducerFailure);
    if (!(error instanceof TraceProducerFailure)) throw error;
    expect(error.details.code).toBe("TRACE_PRODUCER_SUBSTITUTION_NOT_AUTHORIZED");
  }
});
