# Board cards

Board grounding data lives here as JSON — not as a fixed TypeScript enum.

| Path | Role |
| --- | --- |
| `*.json` (this folder) | Seed cards always loaded |
| `catalog/*.json` | Extra boards Blueprint can **fetch into cache** on demand |
| `cache/*.json` | Fetched/resolved cards written at runtime (gitignored) |

To support a new board without changing app code: drop a card JSON here or in `catalog/`. Generation resolves by id, name, or alias; on a miss it searches catalog + Wokwi controller visuals, then caches the result.
