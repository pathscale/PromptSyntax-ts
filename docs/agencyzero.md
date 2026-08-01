# AgencyZero integration

The package is intentionally split at the same seam AgencyZero needs:

```ts
const parsed = new PromptSyntaxParser({
  entities: selectedModelsAndContextAliases,
  actions: availableCommands,
  authoringNamespaces: ["agency"],
}).parse(draft);
```

## Advanced composer

Render `parsed.segments` before submission. Directive segments are the mandatory visual
island markers; text segments retain the user's exact spelling and source offsets.

Do not concatenate resolved content back into the prompt and parse again. Submit the
pieces through two typed paths:

1. Send `parsed.directives` to the resolver/compiler that checks the capability envelope,
   pins canonical entities, expands context by reference, and creates the fill report.
2. Send `parsed.dataPlane` as the user's natural-language body after the compiler has
   assembled any authorized context. The raw island spelling never becomes model data.

If `parsed.diagnostics` is non-empty, keep the prompt in the editor and mark those source
ranges. A malformed qualified island fails closed as text in the lossless segment view,
but Advanced mode should not submit until the user fixes or explicitly escapes it.

Bare references and slash actions are environment-relative. Populate `entities` from
AgencyZero's currently selected models/context aliases and `actions` from the active
provider's command capability event. An unknown bare name remains ordinary text, as the
spec requires; a qualified name is unambiguous syntax even before resolution.

## Reverse channel

`authoringNamespaces: ["agency"]` recognizes AgencyZero's declared single-line surface:

```text
<ps @agency:items.state(id: "item-869382d3", status: "active")>
```

The parser only designates and decodes the reference. AgencyZero must still enforce its
closed verb list, reserved statuses, project reach, typed fill outcome, and receipt. An
undeclared namespace remains inert, and an ordinary `<ps>` span still requires `</ps>`.

