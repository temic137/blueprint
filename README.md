# Blueprint

Personal AI maker co-pilot: describe an idea, get a buildable editable circuit (parts, board, wiring, how-to, explanations).

**Product direction:** [REQUIREMENTS.md](REQUIREMENTS.md) (locked vision).

**Status:** circuits-first path is live — dynamic board/part cards, LLM-authored netlists (generate + change), reusable safety gate, multi-board. Firmware tab shows netlist-driven PlatformIO sketches with optional compile check. Legacy topology notes remain in [BLUEPRINT_ARCHITECTURE.md](BLUEPRINT_ARCHITECTURE.md).

## Provider setup

Copy `.env.example` to `.env` and set `GROQ_API_KEY`, the Supabase/Postgres values, and the compiler service values. To let Blueprint discover unknown exact part numbers automatically, also set `DIGIKEY_CLIENT_ID` and `DIGIKEY_CLIENT_SECRET` for a DigiKey application subscribed to Product Information V4. Keep all credentials out of source control and browser-side code.

## Run locally

```powershell
npm install
npm run dev
```

Open <http://localhost:3000>.

## Checks

```powershell
npm test
npm run lint
npm run build
```
