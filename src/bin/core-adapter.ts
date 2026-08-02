import type {
  Action,
  Argument,
  DiagnosticCode,
  Directive,
  DirectiveSegment,
  ParserOptions,
  Reference,
  Scalar,
  Segment,
  SourceSpan,
} from "../index";
import { PromptSyntaxParser } from "../index";

interface Case {
  id: string;
  name: string;
  source: string;
  options: {
    entities?: string[];
    actions?: string[];
    authoring_namespaces?: string[];
  };
  data_plane?: string;
  directives?: Directive["kind"][];
  diagnostics?: DiagnosticCode[];
}

interface AdapterResult {
  format_version: "0.1-draft";
  target: "core-parser";
  implementation: {
    id: "promptsyntax-ts";
    version: string;
    commit: string;
  };
  results: CaseResult[];
}

interface CaseResult {
  case_id: string;
  conformant: boolean;
  diagnostics: string[];
  output: CoreOutput;
}

interface CoreOutput {
  round_trip: string;
  data_plane: string;
  segments: unknown[];
  directives: unknown[];
  parser_diagnostics: unknown[];
}

const [casesPath, commit, mode, ...extra] = Bun.argv.slice(2);
if (
  casesPath === undefined ||
  commit === undefined ||
  (mode !== undefined && mode !== "--jsonl") ||
  extra.length > 0
) {
  fail("usage: bun run core-adapter <core-cases.json> <commit> [--jsonl]");
}
if (!/^[0-9a-f]{40}$/iu.test(commit)) {
  fail("commit must be a 40-character hexadecimal Git object id");
}

const packageJson = (await Bun.file(new URL("../../package.json", import.meta.url)).json()) as {
  version: string;
};
const cases = (await Bun.file(casesPath).json()) as Case[];
const implementation: AdapterResult["implementation"] = {
  id: "promptsyntax-ts",
  version: packageJson.version,
  commit,
};
if (mode === "--jsonl") {
  const output = Bun.stdout.writer();
  output.write(
    `${JSON.stringify({ format_version: "0.1-draft", target: "core-parser", implementation })}\n`,
  );
  for (const fixture of cases) output.write(`${JSON.stringify(runCase(fixture))}\n`);
  output.end();
} else {
  const result: AdapterResult = {
    format_version: "0.1-draft",
    target: "core-parser",
    implementation,
    results: cases.map(runCase),
  };
  console.log(JSON.stringify(result, null, 2));
}

function runCase(fixture: Case): CaseResult {
  const options: ParserOptions = {
    entities: fixture.options.entities,
    actions: fixture.options.actions,
    authoringNamespaces: fixture.options.authoring_namespaces,
  };
  const parsed = new PromptSyntaxParser(options).parse(fixture.source);
  const roundTrip = parsed.segments.map(segmentSource).join("");
  const directiveKinds = parsed.directives.map((segment) => segment.directive.kind);
  const diagnosticCodes = parsed.diagnostics.map((diagnostic) => diagnostic.code);
  const diagnostics: string[] = [];

  if (roundTrip !== fixture.source) diagnostics.push("CORE_ROUND_TRIP_MISMATCH");
  if (
    fixture.data_plane !== undefined &&
    fixture.directives !== undefined &&
    fixture.diagnostics !== undefined
  ) {
    if (parsed.dataPlane !== fixture.data_plane) diagnostics.push("CORE_DATA_PLANE_MISMATCH");
    if (!sameStrings(directiveKinds, fixture.directives)) {
      diagnostics.push("CORE_DIRECTIVE_SEQUENCE_MISMATCH");
    }
    if (!sameStrings(diagnosticCodes, fixture.diagnostics)) {
      diagnostics.push("CORE_DIAGNOSTIC_SEQUENCE_MISMATCH");
    }
  } else if (
    fixture.data_plane !== undefined ||
    fixture.directives !== undefined ||
    fixture.diagnostics !== undefined
  ) {
    diagnostics.push("CORE_CASE_EXPECTATION_INCOMPLETE");
  }

  return {
    case_id: fixture.id,
    conformant: diagnostics.length === 0,
    diagnostics,
    output: {
      round_trip: roundTrip,
      data_plane: parsed.dataPlane,
      segments: parsed.segments.map((segment) => segmentJson(segment, fixture.source)),
      directives: parsed.directives.map((segment) => directiveSegmentJson(segment, fixture.source)),
      parser_diagnostics: parsed.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        span: spanJson(diagnostic.span, fixture.source),
      })),
    },
  };
}

function segmentSource(segment: Segment): string {
  return segment.type === "text" ? segment.text : segment.source;
}

function segmentJson(segment: Segment, source: string): unknown {
  if (segment.type === "text") {
    return {
      type: "text",
      span: spanJson(segment.span, source),
      source: segment.text,
    };
  }
  return {
    type: "directive",
    span: spanJson(segment.span, source),
    source: segment.source,
    directive: directiveJson(segment.directive, source),
  };
}

function directiveSegmentJson(segment: DirectiveSegment, source: string): unknown {
  return {
    span: spanJson(segment.span, source),
    source: segment.source,
    directive: directiveJson(segment.directive, source),
  };
}

function directiveJson(directive: Directive, source: string): unknown {
  switch (directive.kind) {
    case "reference":
      return { kind: "reference", reference: referenceJson(directive.reference) };
    case "action":
      return { kind: "action", action: actionJson(directive.action) };
    case "route":
      return {
        kind: "route",
        route: {
          steps: directive.route.steps.map((step) => ({
            reference: referenceJson(step.reference),
            limits: step.limits.map(argumentJson),
          })),
          terminal: directive.route.terminal,
        },
      };
    case "span":
      return {
        kind: "span",
        header: {
          raw: directive.header.raw,
          references: directive.header.references.map(referenceJson),
          attributes: directive.header.attributes.map((attribute) => ({
            key: attribute.key,
            value: scalarJson(attribute.value),
          })),
        },
        segments: directive.segments.map((segment) => segmentJson(segment, source)),
      };
    case "authoring_segment":
      return { kind: "authoring_segment", reference: referenceJson(directive.reference) };
    case "invalid_authoring_segment":
      return { kind: "invalid_authoring_segment", header: directive.header };
    case "frontmatter":
      return { kind: "frontmatter", body: directive.body };
  }
}

function referenceJson(reference: Reference): unknown {
  return {
    namespace: reference.namespace,
    name: reference.name,
    version: reference.version,
    strict: reference.strict,
    arguments: reference.arguments.map(argumentJson),
  };
}

function actionJson(action: Action): unknown {
  return {
    name: action.name,
    arguments: action.arguments.map(argumentJson),
  };
}

function argumentJson(argument: Argument): unknown {
  return { key: argument.key, value: scalarJson(argument.value) };
}

function scalarJson(scalar: Scalar): unknown {
  return scalar.kind === "null" ? { kind: "null" } : { kind: scalar.kind, value: scalar.value };
}

function spanJson(span: SourceSpan, source: string): unknown {
  if (span.start < 0 || span.end < span.start || span.end > source.length) {
    throw new Error(`parser emitted invalid UTF-16 span ${span.start}..${span.end}`);
  }
  return {
    start: utf8Length(source.slice(0, span.start)),
    end: utf8Length(source.slice(0, span.end)),
    source: source.slice(span.start, span.end),
  };
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}
