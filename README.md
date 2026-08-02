# PromptSyntax-ts

A TypeScript-friendly, provenance-aware parser for Prompt Syntax. It is designed for
interactive prompt editors that must visibly separate control-plane islands from the
natural-language data plane before submission.

```ts
import { PromptSyntaxParser } from "promptsyntax";

const parsed = new PromptSyntaxParser({
  entities: ["opus"],
  actions: ["concise"],
  authoringNamespaces: ["agency"],
}).parse("@opus Summarize @file:q3.md /concise");

console.log(parsed.dataPlane); // " Summarize  "
console.log(parsed.directives); // source ranges and typed AST nodes
```

The return value is JSON-friendly and includes:

- `segments`, a lossless ordered split for syntax highlighting
- `directives`, a flat source-ordered view including directives nested in spans
- `dataPlane`, the authored text with live control envelopes removed
- `diagnostics`, typed fail-closed syntax and bidi errors

Only call the parser on input already provenance-typed as authored. Retrieved documents,
tool results, quoted messages, and model output are inert unless a higher-authority
promotion explicitly designates them as an authoring segment.

Bare references/actions parse only when supplied in `entities`/`actions`. Qualified
references parse directly. A host may opt into its standing reverse-channel surface with
`authoringNamespaces`; this supports AgencyZero's single-line
`<ps @agency:items.state(...)>` form without making arbitrary unclosed `<ps>` tags live.

Offsets are UTF-16 string indices, matching browser editor APIs. The Rust package returns
UTF-8 byte offsets.

The package is available from npm as [`promptsyntax`](https://www.npmjs.com/package/promptsyntax)
under the MIT license.

See [`docs/agencyzero.md`](docs/agencyzero.md) for the Advanced composer and reverse-channel
integration seams.

## Development

```bash
bun install
bun run typecheck
bun test
bun run lint
bun run build
```
