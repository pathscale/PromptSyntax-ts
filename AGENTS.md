# Working agreement

- Use TypeScript in strict mode, Bun, and Biome.
- The parser is provenance-aware. Never turn inert, escaped, quoted, or fenced content
  into control-plane syntax.
- Bare references and actions are environment-relative and parse only when the caller
  declares them available. Qualified references may parse without a resolver.
- Preserve UTF-16 source offsets and source text exactly.
- Keep the TypeScript and Rust conformance cases behavior-compatible.
- Run typecheck, tests, lint, and build before reporting completion.
- Do not publish or push without explicit approval.

