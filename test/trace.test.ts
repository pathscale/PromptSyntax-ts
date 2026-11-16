import { expect, test } from "bun:test";
import { produceTraceJson, TraceProducerFailure } from "../src";

interface ProducedTrace {
  events: Array<{
    event: string;
    routing?: { outcome: string; fill: Array<{ status: string }> };
  }>;
}

async function fixture(name: string): Promise<string> {
  return Bun.file(new URL(`trace-producer/${name}.json`, import.meta.url)).text();
}

function failureCode(input: string): string {
  try {
    produceTraceJson(input);
  } catch (error) {
    if (error instanceof TraceProducerFailure) return error.details.code;
    throw error;
  }
  throw new Error("expected the producer to fail");
}

const statuses: [string, string, string][] = [
  ["input-kept", "kept", "invoked"],
  ["input-fallback", "fallback", "invoked"],
  ["input-substituted", "substituted", "invoked"],
  ["input-refused", "refused", "refused"],
];

for (const [name, status, outcome] of statuses) {
  test(`Trace producer derives ${status} without an expected trace`, async () => {
    const trace = produceTraceJson(await fixture(name)) as ProducedTrace;
    expect(trace.events[0].routing?.fill[0].status).toBe(status);
    expect(trace.events[0].routing?.outcome).toBe(outcome);
  });
}

for (const name of ["input-boundary-succeeded", "input-boundary-failed"]) {
  test(`Trace producer emits a boundary event for ${name}`, async () => {
    const trace = produceTraceJson(await fixture(name)) as ProducedTrace;
    expect(trace.events.map((event) => event.event)).toEqual(["inference", "boundary"]);
  });
}

const failures: [string, string][] = [
  ["input-strict-substitution", "TRACE_PRODUCER_SUBSTITUTION_NOT_AUTHORIZED"],
  ["input-multiple-filled", "TRACE_PRODUCER_MULTIPLE_FILLED"],
  ["input-refusal-conflict", "TRACE_PRODUCER_REFUSAL_CONFLICT"],
  ["input-missing-refusal", "TRACE_PRODUCER_REFUSAL_REQUIRED"],
];

for (const [name, code] of failures) {
  test(`Trace producer rejects ${name} with ${code}`, async () => {
    expect(failureCode(await fixture(name))).toBe(code);
  });
}

test("Trace producer reports a missing nested object as typed invalid input", async () => {
  const input = JSON.parse(await fixture("input-kept")) as {
    inferences: Array<{ routing?: unknown }>;
  };
  delete input.inferences[0].routing;
  expect(failureCode(JSON.stringify(input))).toBe("TRACE_PRODUCER_INPUT_INVALID");
});

test("Trace producer reports non-JSON input as typed invalid input", () => {
  expect(failureCode("not json")).toBe("TRACE_PRODUCER_INPUT_INVALID");
});
