/** A half-open UTF-16 range in the original JavaScript string. */
export interface SourceSpan {
  start: number;
  end: number;
}

export type Scalar =
  | { kind: "string"; value: string }
  | { kind: "number"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  | { kind: "bare"; value: string };

export interface Argument {
  key: string;
  value: Scalar;
}

export interface Reference {
  namespace: string | null;
  name: string;
  version: string | null;
  strict: boolean;
  arguments: Argument[];
}

export interface Action {
  name: string;
  arguments: Argument[];
}

export interface RouteStep {
  reference: Reference;
  limits: Argument[];
}

export interface Route {
  steps: RouteStep[];
  terminal: "ask" | "fail" | null;
}

export interface SpanAttribute {
  key: string;
  value: Scalar;
}

export interface SpanHeader {
  raw: string;
  references: Reference[];
  attributes: SpanAttribute[];
}

export type Directive =
  | { kind: "reference"; reference: Reference }
  | { kind: "action"; action: Action }
  | { kind: "route"; route: Route }
  | { kind: "span"; header: SpanHeader; segments: Segment[] }
  | { kind: "authoring_segment"; reference: Reference }
  | { kind: "invalid_authoring_segment"; header: string }
  | { kind: "frontmatter"; body: string };

export interface TextSegment {
  type: "text";
  span: SourceSpan;
  text: string;
}

export interface DirectiveSegment {
  type: "directive";
  span: SourceSpan;
  source: string;
  directive: Directive;
}

export type Segment = TextSegment | DirectiveSegment;

export type DiagnosticCode =
  | "SYNTAX_INVALID"
  | "BIDI_CONTROL"
  | "UNCLOSED_SPAN"
  | "UNCLOSED_FRONTMATTER";

export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
  span: SourceSpan;
}

export interface ParsedPrompt {
  source: string;
  segments: Segment[];
  directives: DirectiveSegment[];
  dataPlane: string;
  diagnostics: Diagnostic[];
}

export interface ParserOptions {
  entities?: Iterable<string>;
  actions?: Iterable<string>;
  authoringNamespaces?: Iterable<string>;
}

interface Parsed<T> {
  value: T;
  end: number;
}

interface Region {
  segments: Segment[];
  diagnostics: Diagnostic[];
}

const ID_START = /^[_\p{ID_Start}]$/u;
const ID_CONTINUE = /^(?:[_\p{ID_Continue}]|\u200C|\u200D)$/u;
const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/u;

/** A conservative parser for content already designated as user-authored. */
export class PromptSyntaxParser {
  readonly #entities: Set<string>;
  readonly #actions: Set<string>;
  readonly #authoringNamespaces: Set<string>;

  constructor(options: ParserOptions = {}) {
    this.#entities = normalizedSet(options.entities);
    this.#actions = normalizedSet(options.actions);
    this.#authoringNamespaces = normalizedSet(options.authoringNamespaces);
  }

  parse(source: string): ParsedPrompt {
    const parsed = this.#parseRegion(source, 0, true);
    const directives: DirectiveSegment[] = [];
    collectDirectives(parsed.segments, directives);
    return {
      source,
      segments: parsed.segments,
      directives,
      dataPlane: dataPlane(parsed.segments),
      diagnostics: parsed.diagnostics,
    };
  }

  #parseRegion(source: string, base: number, documentStart: boolean): Region {
    const segments: Segment[] = [];
    const diagnostics: Diagnostic[] = [];
    let cursor = 0;
    let textStart = 0;

    const openEnd = documentStart ? frontmatterOpenEnd(source) : null;
    if (openEnd !== null) {
      const frontmatter = closingFrontmatter(source, openEnd);
      if (frontmatter === null) {
        return {
          segments: [textSegment(source, base, 0, source.length)],
          diagnostics: [
            {
              code: "UNCLOSED_FRONTMATTER",
              message: "strict Prompt Syntax frontmatter has no closing --- line",
              span: { start: base, end: base + source.length },
            },
          ],
        };
      }
      const { bodyEnd, end } = frontmatter;
      const raw = source.slice(0, end);
      segments.push({
        type: "directive",
        span: { start: base, end: base + end },
        source: raw,
        directive: { kind: "frontmatter", body: source.slice(openEnd, bodyEnd) },
      });
      cursor = end;
      textStart = end;
    }

    while (cursor < source.length) {
      const fenceEnd = fencedBlockEnd(source, cursor);
      if (fenceEnd !== null) {
        cursor = fenceEnd;
        continue;
      }

      const character = codePointAt(source, cursor);
      if (character === null) break;

      if (character === "\\") {
        const next = cursor + character.length;
        const escaped = codePointAt(source, next);
        if (escaped !== null && ["@", "/", "＠", "／"].includes(escaped)) {
          cursor = next + escaped.length;
          continue;
        }
      }

      let parsed: Parsed<Directive> | null = null;
      const startsPs = source.startsWith("<ps", cursor) && boundaryAfterPs(source, cursor);
      if (startsPs) {
        parsed = this.#parseSpan(source, cursor, base, diagnostics);
      } else if (["@", "＠"].includes(character) && boundaryBefore(source, cursor)) {
        parsed = this.#parseReferenceOrRoute(source, cursor, base, diagnostics);
      } else if (["/", "／"].includes(character) && boundaryBefore(source, cursor)) {
        parsed = this.#parseAction(source, cursor, base, diagnostics);
      }

      if (parsed !== null) {
        pushText(source, base, textStart, cursor, segments);
        segments.push({
          type: "directive",
          span: { start: base + cursor, end: base + parsed.end },
          source: source.slice(cursor, parsed.end),
          directive: parsed.value,
        });
        cursor = parsed.end;
        textStart = parsed.end;
        continue;
      }

      if (startsPs) {
        const headerEnd = findTagEnd(source, cursor + 3);
        if (headerEnd !== null) {
          cursor = headerEnd + 1;
          continue;
        }
      }
      cursor += character.length;
    }

    pushText(source, base, textStart, source.length, segments);
    return { segments, diagnostics };
  }

  #parseReferenceOrRoute(
    source: string,
    start: number,
    base: number,
    diagnostics: Diagnostic[],
  ): Parsed<Directive> | null {
    const reference = parseReference(source, start);
    if (reference === null) {
      if (looksQualified(source, start)) {
        diagnostics.push(syntaxDiagnostic(base + start, base + islandHintEnd(source, start)));
      }
      return null;
    }

    const hintedEnd = islandHintEnd(source, start);
    if (BIDI.test(source.slice(start, hintedEnd))) {
      diagnostics.push(bidiDiagnostic(base + start, base + hintedEnd));
      return null;
    }
    if (!this.#referenceIsLive(reference.value)) return null;

    const steps: RouteStep[] = [{ reference: reference.value, limits: [] }];
    let end = reference.end;
    let isRoute = false;
    const limits = parseNamedArguments(source, end, "limit");
    if (limits !== null) {
      steps[0].limits = limits.value;
      end = limits.end;
      isRoute = true;
    }

    let terminal: Route["terminal"] = null;
    while (true) {
      const checkpoint = end;
      const afterElse = keyword(source, skipSpace(source, end), "else");
      if (afterElse === null) break;
      const next = skipSpace(source, afterElse);
      const ask = keyword(source, next, "ask");
      if (ask !== null) {
        terminal = "ask";
        end = ask;
        isRoute = true;
        break;
      }
      const fail = keyword(source, next, "fail");
      if (fail !== null) {
        terminal = "fail";
        end = fail;
        isRoute = true;
        break;
      }
      const fallback = parseReference(source, next);
      if (fallback === null || !this.#referenceIsLive(fallback.value)) {
        end = checkpoint;
        break;
      }
      const step: RouteStep = { reference: fallback.value, limits: [] };
      end = fallback.end;
      const fallbackLimits = parseNamedArguments(source, end, "limit");
      if (fallbackLimits !== null) {
        step.limits = fallbackLimits.value;
        end = fallbackLimits.end;
      }
      steps.push(step);
      isRoute = true;
    }

    return {
      end,
      value: isRoute
        ? { kind: "route", route: { steps, terminal } }
        : { kind: "reference", reference: reference.value },
    };
  }

  #parseAction(
    source: string,
    start: number,
    base: number,
    diagnostics: Diagnostic[],
  ): Parsed<Directive> | null {
    const action = parseAction(source, start);
    if (action === null) return null;
    const hintedEnd = islandHintEnd(source, start);
    if (BIDI.test(source.slice(start, hintedEnd))) {
      diagnostics.push(bidiDiagnostic(base + start, base + hintedEnd));
      return null;
    }
    if (!this.#actions.has(normalize(action.value.name))) return null;
    return { end: action.end, value: { kind: "action", action: action.value } };
  }

  #parseSpan(
    source: string,
    start: number,
    base: number,
    diagnostics: Diagnostic[],
  ): Parsed<Directive> | null {
    const headerEnd = findTagEnd(source, start + 3);
    if (headerEnd === null) return null;
    const header = source.slice(start + 3, headerEnd);
    const bodyStart = headerEnd + 1;

    if (BIDI.test(header)) {
      diagnostics.push(bidiDiagnostic(base + start, base + bodyStart));
      if (this.#isDeclaredAuthoringHeader(header) && lineTailIsEmpty(source, bodyStart)) {
        return {
          end: bodyStart,
          value: { kind: "invalid_authoring_segment", header: header.trim() },
        };
      }
      return null;
    }

    const close = findSpanClose(source, bodyStart);
    if (close === null) {
      if (lineTailIsEmpty(source, bodyStart)) {
        const trimmed = header.trim();
        const reference = parseReference(trimmed, 0);
        if (
          reference !== null &&
          reference.end === trimmed.length &&
          reference.value.namespace !== null &&
          this.#authoringNamespaces.has(reference.value.namespace)
        ) {
          return {
            end: bodyStart,
            value: { kind: "authoring_segment", reference: reference.value },
          };
        }
        if (this.#isDeclaredAuthoringHeader(header)) {
          diagnostics.push({
            code: "SYNTAX_INVALID",
            message: "malformed declared Prompt Syntax authoring segment",
            span: { start: base + start, end: base + bodyStart },
          });
          return {
            end: bodyStart,
            value: { kind: "invalid_authoring_segment", header: header.trim() },
          };
        }
      }
      diagnostics.push({
        code: "UNCLOSED_SPAN",
        message: "Prompt Syntax span has no closing </ps> tag",
        span: { start: base + start, end: base + source.length },
      });
      return null;
    }

    const parsedHeader = this.#parseSpanHeader(header);
    if (parsedHeader === null) {
      diagnostics.push({
        code: "SYNTAX_INVALID",
        message: "malformed Prompt Syntax span header",
        span: { start: base + start, end: base + bodyStart },
      });
    }
    const inner = this.#parseRegion(source.slice(bodyStart, close), base + bodyStart, false);
    diagnostics.push(...inner.diagnostics);
    return {
      end: close + "</ps>".length,
      value: {
        kind: "span",
        header: parsedHeader ?? { raw: header.trim(), references: [], attributes: [] },
        segments: inner.segments,
      },
    };
  }

  #referenceIsLive(reference: Reference): boolean {
    return reference.namespace !== null || this.#entities.has(normalize(reference.name));
  }

  #isDeclaredAuthoringHeader(header: string): boolean {
    const match = header.trim().match(/^[@＠]([^:]+):/u);
    return match?.[1] !== undefined && this.#authoringNamespaces.has(normalize(match[1]));
  }

  #parseSpanHeader(header: string): SpanHeader | null {
    const references: Reference[] = [];
    const attributes: SpanAttribute[] = [];
    let cursor = 0;
    while (cursor < header.length) {
      cursor = skipSpace(header, cursor);
      if (cursor === header.length) break;
      const character = codePointAt(header, cursor);
      if (character !== null && ["@", "＠"].includes(character)) {
        const reference = parseReference(header, cursor);
        if (reference === null) return null;
        references.push(reference.value);
        cursor = reference.end;
        continue;
      }

      const key = parseNameToken(header, cursor);
      if (key === null) return null;
      cursor = skipSpace(header, key.end);
      if (!header.startsWith("=", cursor)) return null;
      cursor = skipSpace(header, cursor + 1);
      const quote = header[cursor];
      if (quote !== "'" && quote !== '"') return null;
      const valueStart = cursor;
      cursor += 1;
      let escaped = false;
      let closed = false;
      while (cursor < header.length) {
        const current = header[cursor];
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === quote) {
          cursor += 1;
          closed = true;
          break;
        }
        cursor += 1;
      }
      if (!closed) return null;
      const value = parseScalar(header.slice(valueStart, cursor));
      if (value === null) return null;
      attributes.push({ key: normalize(key.value), value });
    }
    return { raw: header.trim(), references, attributes };
  }
}

/** Parse with one-off options without retaining a parser instance. */
export function parsePrompt(source: string, options: ParserOptions = {}): ParsedPrompt {
  return new PromptSyntaxParser(options).parse(source);
}

function parseReference(source: string, start: number): Parsed<Reference> | null {
  const sigil = codePointAt(source, start);
  if (sigil === null || !["@", "＠"].includes(sigil)) return null;
  let cursor = start + sigil.length;
  const first = parseNameToken(source, cursor);
  if (first === null) return null;
  cursor = first.end;

  let namespace: string | null = null;
  let name = first.value;
  if (source.startsWith(":", cursor)) {
    cursor += 1;
    const parsedName = parseNameToken(source, cursor);
    if (parsedName === null) return null;
    namespace = normalize(first.value);
    name = parsedName.value;
    cursor = parsedName.end;
  }

  let version: string | null = null;
  if (source.startsWith("@", cursor)) {
    const parsedVersion = parseVersion(source, cursor + 1);
    if (parsedVersion === null) return null;
    version = parsedVersion.value;
    cursor = parsedVersion.end;
  }
  const strict = source.startsWith("!", cursor);
  if (strict) cursor += 1;

  let args: Argument[] = [];
  if (source.startsWith("(", cursor)) {
    const parsed = parseArguments(source, cursor);
    if (parsed === null) return null;
    args = parsed.value;
    cursor = parsed.end;
  }
  return {
    end: cursor,
    value: {
      namespace,
      name: normalize(name),
      version,
      strict,
      arguments: args,
    },
  };
}

function parseAction(source: string, start: number): Parsed<Action> | null {
  const sigil = codePointAt(source, start);
  if (sigil === null || !["/", "／"].includes(sigil)) return null;
  const name = parseNameToken(source, start + sigil.length);
  if (name === null) return null;
  let end = name.end;
  let args: Argument[] = [];
  if (source.startsWith("(", end)) {
    const parsed = parseArguments(source, end);
    if (parsed === null) return null;
    args = parsed.value;
    end = parsed.end;
  }
  return { end, value: { name: normalize(name.value), arguments: args } };
}

function parseNameToken(source: string, start: number): Parsed<string> | null {
  let cursor = start;
  let segmentStart = true;
  while (cursor < source.length) {
    const character = codePointAt(source, cursor);
    if (character === null) break;
    if ([".", "/"].includes(character)) {
      if (segmentStart) break;
      segmentStart = true;
      cursor += character.length;
      continue;
    }
    const allowed = segmentStart
      ? ID_START.test(character) || /^\d$/u.test(character)
      : ID_CONTINUE.test(character) || character === "-";
    if (!allowed) break;
    segmentStart = false;
    cursor += character.length;
  }
  return cursor > start && !segmentStart
    ? { value: source.slice(start, cursor), end: cursor }
    : null;
}

function parseVersion(source: string, start: number): Parsed<string> | null {
  let cursor = start;
  while (cursor < source.length) {
    const character = codePointAt(source, cursor);
    if (character === null) break;
    if (!(ID_CONTINUE.test(character) || /^[.\-_]$/u.test(character))) break;
    cursor += character.length;
  }
  return cursor > start ? { value: source.slice(start, cursor), end: cursor } : null;
}

function parseArguments(source: string, open: number): Parsed<Argument[]> | null {
  const close = balancedClose(source, open, "(", ")");
  if (close === null) return null;
  const args: Argument[] = [];
  for (const raw of splitTopLevel(source.slice(open + 1, close), ",")) {
    if (raw.trim() === "") continue;
    const pair = splitKeyValue(raw);
    if (pair === null) return null;
    const key = pair[0].trim();
    if (!isIdentifier(key)) return null;
    const value = parseScalar(pair[1].trim());
    if (value === null) return null;
    args.push({ key: normalize(key), value });
  }
  return { value: args, end: close + 1 };
}

function parseNamedArguments(
  source: string,
  start: number,
  name: string,
): Parsed<Argument[]> | null {
  const cursor = skipSpace(source, start);
  const after = keyword(source, cursor, name);
  if (after === null) return null;
  const open = skipSpace(source, after);
  if (!source.startsWith("(", open)) return null;
  return parseArguments(source, open);
}

function parseScalar(value: string): Scalar | null {
  if (value.length >= 2 && ["'", '"'].includes(value[0]) && value.endsWith(value[0])) {
    const unescaped = unescapeString(value.slice(1, -1), value[0]);
    return unescaped === null ? null : { kind: "string", value: unescaped };
  }
  if (value === "true") return { kind: "boolean", value: true };
  if (value === "false") return { kind: "boolean", value: false };
  if (value === "null") return { kind: "null" };
  if (value === "") return null;
  if (looksNumber(value)) return { kind: "number", value };
  return { kind: "bare", value };
}

function unescapeString(value: string, quote: string): string | null {
  let output = "";
  for (let cursor = 0; cursor < value.length; cursor += 1) {
    const character = value[cursor];
    if (character !== "\\") {
      output += character;
      continue;
    }
    cursor += 1;
    if (cursor >= value.length) return null;
    const escaped = value[cursor];
    if (escaped === quote) output += quote;
    else if (escaped === "n") output += "\n";
    else if (escaped === "r") output += "\r";
    else if (escaped === "t") output += "\t";
    else output += escaped;
  }
  return output;
}

function splitKeyValue(value: string): [string, string] | null {
  let quote: string | null = null;
  let escaped = false;
  for (let cursor = 0; cursor < value.length; cursor += 1) {
    const character = value[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== null) {
      escaped = true;
      continue;
    }
    if (quote !== null && character === quote) quote = null;
    else if (quote === null && ["'", '"'].includes(character)) quote = character;
    else if (quote === null && character === ":") {
      return [value.slice(0, cursor), value.slice(cursor + 1)];
    }
  }
  return null;
}

function splitTopLevel(value: string, separator: string): string[] {
  const output: string[] = [];
  let start = 0;
  let quote: string | null = null;
  let escaped = false;
  let depth = 0;
  for (let cursor = 0; cursor < value.length; cursor += 1) {
    const character = value[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== null) {
      escaped = true;
      continue;
    }
    if (quote !== null && character === quote) quote = null;
    else if (quote === null && ["'", '"'].includes(character)) quote = character;
    else if (quote === null && "([{".includes(character)) depth += 1;
    else if (quote === null && ")]}".includes(character)) depth = Math.max(0, depth - 1);
    else if (quote === null && character === separator && depth === 0) {
      output.push(value.slice(start, cursor));
      start = cursor + 1;
    }
  }
  output.push(value.slice(start));
  return output;
}

function balancedClose(
  source: string,
  open: number,
  opener: string,
  closer: string,
): number | null {
  let quote: string | null = null;
  let escaped = false;
  let depth = 0;
  for (let cursor = open; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== null) {
      escaped = true;
      continue;
    }
    if (quote !== null && character === quote) quote = null;
    else if (quote === null && ["'", '"'].includes(character)) quote = character;
    else if (quote === null && character === opener) depth += 1;
    else if (quote === null && character === closer) {
      depth -= 1;
      if (depth === 0) return cursor;
      if (depth < 0) return null;
    }
  }
  return null;
}

function frontmatterOpenEnd(source: string): number | null {
  const newline = source.indexOf("\n");
  if (newline < 0) return null;
  const end = newline + 1;
  return source.slice(0, end).replace(/[\r\n]+$/u, "") === "---ps" ? end : null;
}

function closingFrontmatter(
  source: string,
  openEnd: number,
): { bodyEnd: number; end: number } | null {
  let cursor = openEnd;
  while (cursor > 0 && cursor < source.length) {
    const newline = source.indexOf("\n", cursor);
    const end = newline < 0 ? source.length : newline + 1;
    if (source.slice(cursor, end).replace(/[\r\n]+$/u, "") === "---") {
      return { bodyEnd: cursor, end };
    }
    cursor = end;
  }
  return null;
}

function fencedBlockEnd(source: string, start: number): number | null {
  if (start > 0 && source[start - 1] !== "\n") return null;
  const newline = source.indexOf("\n", start);
  const lineEnd = newline < 0 ? source.length : newline + 1;
  const line = source.slice(start, lineEnd).replace(/[\r\n]+$/u, "");
  const indent = line.match(/^ */u)?.[0].length ?? 0;
  if (indent > 3) return null;
  const trimmed = line.slice(indent);
  const marker = trimmed[0];
  if (marker !== "`" && marker !== "~") return null;
  const width = countPrefix(trimmed, marker);
  if (width < 3) return null;

  let cursor = lineEnd;
  while (cursor < source.length) {
    const nextNewline = source.indexOf("\n", cursor);
    const next = nextNewline < 0 ? source.length : nextNewline + 1;
    const candidate = source
      .slice(cursor, next)
      .replace(/[\r\n]+$/u, "")
      .trim();
    const closeWidth = countPrefix(candidate, marker);
    if (closeWidth >= width && candidate.slice(closeWidth).trim() === "") return next;
    cursor = next;
  }
  return source.length;
}

function findTagEnd(source: string, start: number): number | null {
  let quote: string | null = null;
  let escaped = false;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== null) {
      escaped = true;
      continue;
    }
    if (quote !== null && character === quote) quote = null;
    else if (quote === null && ["'", '"'].includes(character)) quote = character;
    else if (quote === null && character === ">") return cursor;
  }
  return null;
}

function findSpanClose(source: string, start: number): number | null {
  let cursor = start;
  let depth = 1;
  while (cursor < source.length) {
    const fenceEnd = fencedBlockEnd(source, cursor);
    if (fenceEnd !== null) {
      cursor = fenceEnd;
      continue;
    }
    if (source.startsWith("<ps", cursor) && boundaryAfterPs(source, cursor)) {
      const headerEnd = findTagEnd(source, cursor + 3);
      if (headerEnd === null) return null;
      depth += 1;
      cursor = headerEnd + 1;
      continue;
    }
    if (source.startsWith("</ps>", cursor)) {
      depth -= 1;
      if (depth === 0) return cursor;
      cursor += "</ps>".length;
      continue;
    }
    const character = codePointAt(source, cursor);
    if (character === null) break;
    cursor += character.length;
  }
  return null;
}

function dataPlane(segments: Segment[]): string {
  let output = "";
  for (const segment of segments) {
    if (segment.type === "text") output += segment.text;
    else if (segment.directive.kind === "span") output += dataPlane(segment.directive.segments);
  }
  return output;
}

function collectDirectives(segments: Segment[], output: DirectiveSegment[]): void {
  for (const segment of segments) {
    if (segment.type !== "directive") continue;
    output.push(segment);
    if (segment.directive.kind === "span") collectDirectives(segment.directive.segments, output);
  }
}

function pushText(
  source: string,
  base: number,
  start: number,
  end: number,
  output: Segment[],
): void {
  if (start < end) output.push(textSegment(source, base, start, end));
}

function textSegment(source: string, base: number, start: number, end: number): TextSegment {
  return {
    type: "text",
    span: { start: base + start, end: base + end },
    text: source.slice(start, end),
  };
}

function boundaryAfterPs(source: string, start: number): boolean {
  const character = codePointAt(source, start + 3);
  return character !== null && (character === ">" || /^\s$/u.test(character));
}

function boundaryBefore(source: string, start: number): boolean {
  if (start === 0) return true;
  const previous = codePointBefore(source, start);
  return previous === null || !/^[A-Za-z0-9_.\\-]$/u.test(previous);
}

function lineTailIsEmpty(source: string, start: number): boolean {
  const match = source.slice(start).search(/[\r\n]/u);
  const end = match < 0 ? source.length : start + match;
  return source.slice(start, end).trim() === "";
}

function keyword(source: string, start: number, expected: string): number | null {
  const candidate = source.slice(start, start + expected.length);
  if (candidate.toLowerCase() !== expected.toLowerCase()) return null;
  const end = start + expected.length;
  const next = codePointAt(source, end);
  return next !== null && ID_CONTINUE.test(next) ? null : end;
}

function skipSpace(source: string, start: number): number {
  let cursor = start;
  while (cursor < source.length) {
    const character = codePointAt(source, cursor);
    if (character === null || !/^\s$/u.test(character)) break;
    cursor += character.length;
  }
  return cursor;
}

function islandHintEnd(source: string, start: number): number {
  const match = source.slice(start).search(/\s/u);
  return match < 0 ? source.length : start + match;
}

function looksQualified(source: string, start: number): boolean {
  return source.slice(start, islandHintEnd(source, start)).includes(":");
}

function syntaxDiagnostic(start: number, end: number): Diagnostic {
  return {
    code: "SYNTAX_INVALID",
    message: "malformed Prompt Syntax island",
    span: { start, end },
  };
}

function bidiDiagnostic(start: number, end: number): Diagnostic {
  return {
    code: "BIDI_CONTROL",
    message: "bidirectional control character inside Prompt Syntax island",
    span: { start, end },
  };
}

function looksNumber(value: string): boolean {
  const amount = value.startsWith("$") ? value.slice(1) : value;
  const scalar = amount.replace(/(?:ms|s|tok)$/u, "");
  return scalar !== "" && Number.isFinite(Number(scalar));
}

function isIdentifier(value: string): boolean {
  const characters = [...value];
  return (
    characters.length > 0 &&
    ID_START.test(characters[0]) &&
    characters.slice(1).every((character) => ID_CONTINUE.test(character))
  );
}

function normalizedSet(values: Iterable<string> | undefined): Set<string> {
  return new Set([...(values ?? [])].map(normalize));
}

function normalize(value: string): string {
  return value.normalize("NFC");
}

function codePointAt(source: string, index: number): string | null {
  const point = source.codePointAt(index);
  return point === undefined ? null : String.fromCodePoint(point);
}

function codePointBefore(source: string, index: number): string | null {
  if (index <= 0) return null;
  const previous = source.charCodeAt(index - 1);
  if (previous >= 0xdc00 && previous <= 0xdfff && index >= 2) return source.slice(index - 2, index);
  return source[index - 1];
}

function countPrefix(value: string, character: string): number {
  let count = 0;
  while (value[count] === character) count += 1;
  return count;
}
