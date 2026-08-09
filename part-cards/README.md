# Part cards

Exact parts can live in `component-manifests/` (curated) or be **fetched into** `part-cards/cache/` at runtime from Wokwi/library discovery when Blueprint resolves an unknown but pin-complete part.

Do not hand-edit application TypeScript to add ordinary parts — add a manifest or let resolve/fetch cache them.
