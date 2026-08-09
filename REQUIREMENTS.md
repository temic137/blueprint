# Blueprint Requirements

Status: **locked vision** (2026-07-20). This document is the product source of truth.

`BLUEPRINT_ARCHITECTURE.md` describes the **legacy implementation** (ESP32-centric, deterministic topology synthesizer). Where that document disagrees with this one, **this file wins** for what we are building next.

---

## 1. One-liner

Blueprint is a personal AI maker co-pilot: you describe an idea, it produces a **buildable, editable circuit** — parts, board, wiring, how-to, and bite-size explanations — so you can build in the physical world what you see on screen.

Audience: you and friends (local tool, not multi-tenant SaaS).

---

## 2. Product principles

1. **Dynamic over hard-coded.** Do not write per-project or per-schematic-type code. Do not maintain hand-written topologies for every doorbell, LED, sensor, etc.
2. **Project picks the hardware.** Board and parts follow the idea (Arduino, ESP32, Pico, …). Nothing is forced to ESP32.
3. **LLM designs the circuit.** The model proposes board, components, connections, explanations, and assembly. Reusable physics/safety checks ground it — not a topology recipe engine.
4. **What’s on screen is what you build.** Blueprint must use real part/board knowledge so the diagram is trustworthy. Users should not need EE expertise to “fix” the drawing.
5. **Expandable parts world.** Prefer open libraries + web fetch + cache over hand-coding every component and drawing every schematic symbol.
6. **Explain in bite sizes.** Each part gets a short “what it is / why it’s here.”

---

## 3. Locked decisions (v1)

| Topic | Decision |
| --- | --- |
| Boards | **Dynamic board cards** (JSON seed + catalog + cache). LLM chooses freely; Blueprint resolves/fetches a card — not a fixed TypeScript enum. |
| Component source | Bootstrap from open set (Wokwi + manifests). **Fetch/cache** unknown pin-complete parts into `part-cards/cache/`. No hand-editing app code for ordinary parts. |
| Circuit authority | **LLM proposes the full netlist.** User reviews/edits before treating a version as final. |
| Safety | **Small reusable electrical checks** (physics rules), not per-project topology code. |
| Firmware / compile | **In progress** — netlist-driven sketch + Firmware tab; compile check optional. |

---

## 4. Knowledge Blueprint must use

| Kind | Purpose | Sources |
| --- | --- | --- |
| **Component knowledge** | Pins, roles, voltage/current limits, interface, companion needs, plain-language blurb | Open libraries, datasheets, vendor docs, web lookup → **cache as part cards** |
| **Board / MCU knowledge** | Pinout, rails, 3.3 V vs 5 V, capabilities and limits | Board pinouts, MCU docs, board definitions |
| **Circuit / physics rules** | Catch designs that destroy parts or are electrically nonsense | Small reusable validators (see §6) |
| **Project / intent** | What this idea needs; why each part is present | LLM, grounded by the catalogs above |

Unknown visuals may render as a **generic labeled module**. Missing artwork must not block a buildable netlist.

---

## 5. Generation pipeline (target architecture)

```text
Idea
  → Resolve / fetch part & board cards (library + web cache)
  → LLM: board + parts + connections + explanations + assembly
  → Safety gate (reusable physics checks; one repair pass on failure)
  → Present blueprint (schematic, BOM, pins, how-to, why)
  → User edits → same loop
  → Build what is on screen
```

**Explicitly replace as authority:** legacy flow where AI only picks parts and deterministic code invents all wires via hard-coded topologies.

**Keep where useful:** app shell, project persistence, workspace UI, Groq provider wiring, Wokwi (or generic) visuals, SQLite.

---

## 6. Safety / verification policy

Goal: **don’t destroy components**; diagram should be followable.

### v1 (required)

Reusable checks, for example:

- Every connection endpoint exists on a real part/board pin in the catalog
- Required power and ground present where the part card says so
- No VCC–GND shorts
- Voltage-domain abuse (e.g. 5 V into a 3.3 V-only GPIO) flagged or rejected
- Obvious load abuse (GPIO driving a motor / high-current load without a driver)
- Parts that declare “needs series resistor” (or similar) without that companion flagged

On failure: return clear errors; optionally one LLM repair attempt; do not present as “ready to build” until checks pass or the user explicitly accepts risk.

### Never claim

- Simulated or safety-checked ≠ certified, regulatory-approved, or guaranteed on every breadboard.

### Physical build practice (product copy, not code)

Power off while wiring, check polarity, prefer current-limited supply on first power-up.

---

## 7. v1 must ship

1. Plain-language prompt → board + parts + connections  
2. Wiring / schematic view (Wokwi or generic modules)  
3. BOM + pin list  
4. Assembly / how-to-build steps  
5. Bite-size per-component explanations  
6. Edit + regenerate (preview before final)  
7. Save / reopen local projects  

### Explicitly later

- Firmware generation (PlatformIO / Arduino)  
- Compile check  
- Browser flashing  
- Full live-web search on every request without cache  
- Accounts, cloud sync, marketplace  

### Explicitly out of scope

- PCB layout / Gerbers  
- Full SPICE as the default path  
- Mains voltage, lithium charging, medical, or other hazardous designs  
- Multi-tenant SaaS hardening  

Electrical scope: **USB-powered, low-voltage breadboard / hobby projects only.**

---

## 8. User workflow (v1)

1. Enter an idea (e.g. “hands-free doorbell”).  
2. Blueprint selects a suitable board and parts (not forced ESP32).  
3. Review schematic, BOM, pins, assembly, and explanations.  
4. Edit if needed; regenerate; accept a version.  
5. Build the physical circuit from what is shown.  

Firmware/compile join this flow in a later phase.

---

## 9. Acceptance criteria (v1)

Given a prompt such as **“Build a hands-free doorbell”** (and similar ideas):

- [x] Blueprint chooses board and parts from project need; ESP32 is allowed but **not required**.  
- [x] Netlist comes from the **LLM**, not a hard-coded project/topology template.  
- [x] No new hand-written topology was required in code for that idea to generate.  
- [x] Parts resolve to catalog/cache cards (or a clear “unsupported / fetch failed” path).  
- [x] Safety gate runs; unsafe designs are not marked ready to build.  
- [x] UI shows wiring, BOM, pins, assembly, and bite-size explanations that match the same netlist.  
- [x] User can edit and regenerate without destroying history of accepted versions (preview/apply or equivalent).  
- [x] Building what is on screen is the intended path (trustworthy diagram).  
- [x] API keys stay server-side only.  

---

## 10. Non-goals for “dynamic”

Dynamic means: flexible part/board choice, LLM-planned circuits, growing part cache, no per-idea synthesizer code.

Dynamic does **not** mean: zero knowledge, zero safety checks, or inventing pin names that do not exist on real parts.

---

## 11. Implementation notes (for the next build cut)

1. [x] Rewrite `REQUIREMENTS` / product copy away from “ESP32-only deterministic builder.”  
2. [x] Introduce **part cards** + **board cards** as the grounding layer (bootstrap from open libs; cache web enrichment).  
3. [x] Change generation so the LLM returns the **full netlist** + explanations.  
4. [x] Replace topology synthesizer authority with the **safety gate** (generate + change).  
5. [x] Keep UI tabs that serve circuits-first; demote or hide firmware until that phase.  
6. [x] Add tests for safety rules and for “non-ESP32 board can be selected.”  

**Next cut:** richer LLM firmware for complex buses and compile-check hardening.

Overscope handling: Blueprint v1 is **simple projects only**. Ideas that need ML/apps/vision/translation (or >12 parts) are rejected with a clear “I can’t build this” message — no hollow demos.

---

## 12. Success test

You type an idea. Blueprint returns a sensible design for that idea — board not forced, parts not limited to a tiny hard-coded topology set — with wiring and explanations you can follow and edit, without adding a new topology module in code. You can build what you see.
