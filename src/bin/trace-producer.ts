import { produceTraceJson, TraceProducerFailure } from "../trace";

const [inputPath, ...extra] = Bun.argv.slice(2);
if (inputPath === undefined || extra.length > 0) {
  console.error("usage: bun run trace-producer <producer-input.json>");
  process.exit(2);
}

try {
  const input = await Bun.file(inputPath).text();
  console.log(JSON.stringify(produceTraceJson(input), null, 2));
} catch (error) {
  if (error instanceof TraceProducerFailure) {
    console.log(JSON.stringify({ format_version: "0.1-draft", error: error.details }, null, 2));
    process.exit(1);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
