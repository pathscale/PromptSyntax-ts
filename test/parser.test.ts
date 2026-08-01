import { describe, expect, test } from "bun:test";
import {
  type DiagnosticCode,
  type Directive,
  type ParserOptions,
  PromptSyntaxParser,
} from "../src";

interface ConformanceCase {
  name: string;
  source: string;
  options: {
    entities?: string[];
    actions?: string[];
    authoring_namespaces?: string[];
  };
  data_plane: string;
  directives: Directive["kind"][];
  diagnostics: DiagnosticCode[];
}

describe("PromptSyntaxParser", () => {
  test("separates control and data planes losslessly", () => {
    const source = "@opus Summarize @file:q3-report.md /concise";
    const parsed = new PromptSyntaxParser({ entities: ["opus"], actions: ["concise"] }).parse(
      source,
    );
    expect(
      parsed.segments
        .map((segment) => (segment.type === "text" ? segment.text : segment.source))
        .join(""),
    ).toBe(source);
    expect(parsed.dataPlane).toBe(" Summarize  ");
    expect(parsed.directives).toHaveLength(3);
    expect(parsed.diagnostics).toEqual([]);
  });

  test("keeps unknown bare names, emails, paths, escapes, and fences inert", () => {
    const source = "mail a@b.com @unknown /usr/bin \\@model:x\n```\n@model:y\n```";
    const parsed = new PromptSyntaxParser().parse(source);
    expect(parsed.dataPlane).toBe(source);
    expect(parsed.directives).toHaveLength(0);
  });

  test("supports full-width sigils and Unicode names", () => {
    const parsed = new PromptSyntaxParser({ actions: ["បកប្រែ"] }).parse(
      "＠file:របាយការណ៍.md ／បកប្រែ",
    );
    expect(parsed.directives).toHaveLength(2);
  });

  test("parses escaped quotes and commas inside arguments", () => {
    const parsed = new PromptSyntaxParser().parse(
      String.raw`@agency:items.add(title: "Fix \"quoted\", text", status: active)`,
    );
    const first = parsed.directives[0].directive;
    expect(first.kind).toBe("reference");
    if (first.kind !== "reference") throw new Error("expected reference");
    expect(first.reference.arguments).toHaveLength(2);
    expect(first.reference.arguments[0].value).toEqual({
      kind: "string",
      value: 'Fix "quoted", text',
    });
  });

  test("parses budgeted fallback routes", () => {
    const source =
      "@opus! limit(wall_time: 5s) else @model:openai/gpt-5.6@2026-07-01 else ask\nDo it";
    const parsed = new PromptSyntaxParser({ entities: ["opus"] }).parse(source);
    const first = parsed.directives[0].directive;
    expect(first.kind).toBe("route");
    if (first.kind !== "route") throw new Error("expected route");
    expect(first.route.steps).toHaveLength(2);
    expect(first.route.terminal).toBe("ask");
    expect(parsed.dataPlane).toBe("\nDo it");
  });

  test("keeps span inner prose in the data plane", () => {
    const source = "Before <ps @file:glossary.md>use @file:terms.md here</ps> after";
    const parsed = new PromptSyntaxParser().parse(source);
    expect(parsed.dataPlane).toBe("Before use  here after");
    expect(parsed.directives).toHaveLength(2);
    const span = parsed.directives[0].directive;
    if (span.kind !== "span") throw new Error("expected span");
    expect(span.header.references).toHaveLength(1);
  });

  test("parses canonical span attributes", () => {
    const parsed = new PromptSyntaxParser().parse(
      '<ps context="file:workspace/acme/9fc2" fill="strict">Summarize</ps>',
    );
    const span = parsed.directives[0].directive;
    if (span.kind !== "span") throw new Error("expected span");
    expect(span.header.attributes).toEqual([
      { key: "context", value: { kind: "string", value: "file:workspace/acme/9fc2" } },
      { key: "fill", value: { kind: "string", value: "strict" } },
    ]);
  });

  test("removes strict frontmatter from the data plane", () => {
    const parsed = new PromptSyntaxParser().parse('---ps\nversion: "0.2"\n---\nSummarize.');
    expect(parsed.dataPlane).toBe("Summarize.");
    expect(parsed.directives).toHaveLength(1);
  });

  test("accepts empty frontmatter without a final newline", () => {
    const parsed = new PromptSyntaxParser().parse("---ps\n---");
    expect(parsed.directives[0].directive).toEqual({ kind: "frontmatter", body: "" });
  });

  test("accepts Windows line endings in frontmatter", () => {
    const parsed = new PromptSyntaxParser().parse('---ps\r\nversion: "0.2"\r\n---\r\nBody');
    expect(parsed.dataPlane).toBe("Body");
    expect(parsed.directives).toHaveLength(1);
  });

  test("supports AgencyZero's declared single-line authoring surface", () => {
    const source = 'Before\n<ps @agency:items.state(id: "item-869382d3", status: "active")>\nAfter';
    const parsed = new PromptSyntaxParser({ authoringNamespaces: ["agency"] }).parse(source);
    expect(parsed.dataPlane).toBe("Before\n\nAfter");
    expect(parsed.directives).toHaveLength(1);
    expect(parsed.directives[0].directive.kind).toBe("authoring_segment");
  });

  test("keeps undeclared single-line tags inert", () => {
    const source = '<ps @agency:items.state(id: "x", status: "active")>';
    const parsed = new PromptSyntaxParser().parse(source);
    expect(parsed.dataPlane).toBe(source);
    expect(parsed.directives).toHaveLength(0);
    expect(parsed.diagnostics[0].code).toBe("UNCLOSED_SPAN");
  });

  test("rejects bidi controls without leaking a partial directive", () => {
    const source = "@model:openai/gpt\u202e-5";
    const parsed = new PromptSyntaxParser().parse(source);
    expect(parsed.dataPlane).toBe(source);
    expect(parsed.directives).toHaveLength(0);
    expect(parsed.diagnostics[0].code).toBe("BIDI_CONTROL");
  });

  test("reports malformed qualified references as inert text", () => {
    const source = "Use @model: now";
    const parsed = new PromptSyntaxParser().parse(source);
    expect(parsed.dataPlane).toBe(source);
    expect(parsed.diagnostics[0].code).toBe("SYNTAX_INVALID");
  });

  test("arbitrary Unicode input round-trips without throwing", () => {
    const alphabet = [
      "a",
      "5",
      "@",
      "＠",
      "/",
      "／",
      "<",
      ">",
      "(",
      ")",
      ":",
      ",",
      "\\",
      "\n",
      " ",
      '"',
      "'",
      "`",
      "~",
      "ក",
      "報",
      "\u202e",
    ];
    const parser = new PromptSyntaxParser({
      entities: ["a"],
      actions: ["a"],
      authoringNamespaces: ["a"],
    });
    let state = 0x5eed;
    const next = () => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state;
    };
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      const length = next() % 48;
      let source = "";
      for (let index = 0; index < length; index += 1) source += alphabet[next() % alphabet.length];
      const parsed = parser.parse(source);
      expect(
        parsed.segments
          .map((segment) => (segment.type === "text" ? segment.text : segment.source))
          .join(""),
      ).toBe(source);
      for (const directive of parsed.directives) {
        expect(source.slice(directive.span.start, directive.span.end)).toBe(directive.source);
      }
    }
  });
});

test("shared Rust and TypeScript conformance corpus", async () => {
  const cases = (await Bun.file(
    new URL("conformance.json", import.meta.url),
  ).json()) as ConformanceCase[];
  for (const fixture of cases) {
    const options: ParserOptions = {
      entities: fixture.options.entities,
      actions: fixture.options.actions,
      authoringNamespaces: fixture.options.authoring_namespaces,
    };
    const parsed = new PromptSyntaxParser(options).parse(fixture.source);
    const roundTrip = parsed.segments
      .map((segment) => (segment.type === "text" ? segment.text : segment.source))
      .join("");
    expect(roundTrip, `${fixture.name} round trip`).toBe(fixture.source);
    expect(parsed.dataPlane, `${fixture.name} data`).toBe(fixture.data_plane);
    expect(
      parsed.directives.map((directive) => directive.directive.kind),
      `${fixture.name} directives`,
    ).toEqual(fixture.directives);
    expect(
      parsed.diagnostics.map((diagnostic) => diagnostic.code),
      `${fixture.name} diagnostics`,
    ).toEqual(fixture.diagnostics);
  }
});
