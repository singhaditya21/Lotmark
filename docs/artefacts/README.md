# Source artefacts — the product specification

| File | Standing |
|---|---|
| `lotmark-app.html` | The working single-file prototype. **Behavioural reference**: where it and the wireframe disagree, this is what actually ran. |
| `lotmark-product-wireframe.html` | The product wireframe. **Scope and intent reference**: the screen inventory and the core/commodity split. |

Both are read-only inputs. They are never edited to match the build; where the
build deviates, the deviation is recorded and reasoned rather than the artefact
being quietly rewritten.

Known conflict between them: they number the segregation-of-duties rules
differently, for different rules. See `packages/domain/src/sod.ts` — the union
is modelled with provenance from both, and tests assert the mapping.

The estimate workbook has moved to `docs/commercial/` because it is a bid
artefact, not a specification. See the README there.
