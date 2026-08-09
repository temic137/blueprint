import { COMPONENTS, type CircuitDesign, type ProjectPlan } from "./project.ts";
import { isBoardSignalPin, isPowerOrGroundPin } from "./board-types.ts";

const HIGH_CURRENT_TYPES = new Set(["stepper_motor", "servo", "neopixel_matrix", "neopixel_ring"]);

function componentType(plan: Pick<ProjectPlan, "components">, id: string) {
  const component = plan.components.find((item) => item.id === id);
  return component?.type || component?.id || "";
}

function pinsFor(plan: Pick<ProjectPlan, "components">, owner: string) {
  if (owner === "board") return null;
  const component = plan.components.find((item) => item.id === owner);
  if (!component) return null;
  return COMPONENTS[component.type || component.id]?.pins || component.registry?.pins || null;
}

function wireTouches(plan: ProjectPlan, owner: string, pin: string) {
  return plan.connections.some((wire) =>
    (wire.fromComponent === owner && wire.fromPin === pin) || (wire.toComponent === owner && wire.toPin === pin));
}

function boardEnd(wire: ProjectPlan["connections"][number]) {
  if (wire.fromComponent === "board") return wire.fromPin;
  if (wire.toComponent === "board") return wire.toPin;
  return null;
}

function otherEnd(wire: ProjectPlan["connections"][number], owner: string) {
  if (wire.fromComponent === owner) return { owner: wire.toComponent, pin: wire.toPin };
  if (wire.toComponent === owner) return { owner: wire.fromComponent, pin: wire.fromPin };
  return null;
}

/**
 * Reusable physics/safety checks — not per-project topology recipes.
 * A design that fails these must not be marked ready to build.
 */
export function runSafetyGate(plan: ProjectPlan): string[] {
  const errors: string[] = [];
  const profile = plan.boardMeta;
  if (!profile) return [`Missing board card metadata for ${plan.board}`];
  const boardPins = new Set(profile.pins);
  const selected = new Set(plan.components.map((component) => component.id));

  for (const wire of plan.connections) {
    for (const [owner, pin] of [[wire.fromComponent, wire.fromPin], [wire.toComponent, wire.toPin]] as const) {
      if (owner === "board") {
        if (!boardPins.has(pin)) errors.push(`Unknown board pin on ${plan.board}: ${pin}`);
        continue;
      }
      if (!selected.has(owner)) {
        errors.push(`Connection references missing component ${owner}`);
        continue;
      }
      const pins = pinsFor(plan, owner);
      if (pins && !pins.includes(pin)) errors.push(`Unknown pin ${owner}.${pin}`);
    }

    const fromPower = isPowerOrGroundPin(wire.fromPin) || (wire.fromComponent === "board" && isPowerOrGroundPin(wire.fromPin));
    const toPower = isPowerOrGroundPin(wire.toPin) || (wire.toComponent === "board" && isPowerOrGroundPin(wire.toPin));
    if (wire.fromComponent === "board" && wire.toComponent === "board") {
      const a = wire.fromPin;
      const b = wire.toPin;
      const short = (a === "GND" && (b === "3V3" || b === "5V" || b === "VIN" || b === "VSYS"))
        || (b === "GND" && (a === "3V3" || a === "5V" || a === "VIN" || a === "VSYS"));
      if (short) errors.push(`Power rail short on the board: ${a} connected to ${b}`);
    }
    void fromPower;
    void toPower;
  }

  if (!plan.connections.some((wire) => boardEnd(wire) === "GND")) {
    errors.push("Circuit must share ground with the board (GND).");
  }

  const logicVoltage = profile.logicVoltage;
  if (logicVoltage === 3.3) {
    for (const wire of plan.connections) {
      const boardPin = boardEnd(wire);
      if (!boardPin || !isBoardSignalPin(profile, boardPin)) continue;
      const other = wire.fromComponent === "board"
        ? { owner: wire.toComponent, pin: wire.toPin }
        : { owner: wire.fromComponent, pin: wire.fromPin };
      if (other.owner === "board") continue;
      const type = componentType(plan, other.owner);
      // HC-SR04 ECHO is 5V — flag direct board signal without a resistor in the path.
      if (type === "hc_sr04" && other.pin === "ECHO") {
        errors.push(`${other.owner}.ECHO is a 5V output; do not wire it directly to a ${logicVoltage}V ${plan.board} signal pin.`);
      }
    }
  }

  for (const component of plan.components) {
    const type = component.type || component.id;
    const definition = COMPONENTS[type];
    if (!definition) continue;

    if (type === "led" || type === "rgb_led") {
      const hasResistor = plan.components.some((item) => (item.type || item.id) === "resistor");
      if (!hasResistor) errors.push(`LED ${component.id} needs a series resistor in the parts list.`);
    }

    const needsPower = definition.pins.includes("VCC") || definition.pins.includes("VDD") || definition.pins.includes("POS");
    const needsGnd = definition.pins.includes("GND") || definition.pins.includes("NEG") || definition.pins.includes("VSS");
    if (needsPower) {
      const powered = definition.pins.some((pin) => ["VCC", "VDD", "POS", "VIN", "5V"].includes(pin) && wireTouches(plan, component.id, pin));
      if (!powered) errors.push(`${component.id} has a power pin but is not powered.`);
    }
    if (needsGnd) {
      const grounded = definition.pins.some((pin) => ["GND", "NEG", "VSS"].includes(pin) && wireTouches(plan, component.id, pin));
      if (!grounded) errors.push(`${component.id} has a ground pin but is not grounded.`);
    }

    if (HIGH_CURRENT_TYPES.has(type) && type === "stepper_motor") {
      const throughDriver = plan.connections.some((wire) => {
        const other = otherEnd(wire, component.id);
        return other && componentType(plan, other.owner) === "a4988";
      });
      if (!throughDriver) errors.push(`${component.id} stepper must connect through a driver, not directly to the MCU.`);
    }
  }

  const signalLoad = new Map<string, string[]>();
  for (const wire of plan.connections) {
    const boardPin = boardEnd(wire);
    if (!boardPin || !isBoardSignalPin(profile, boardPin)) continue;
    const other = wire.fromComponent === "board"
      ? { owner: wire.toComponent, pin: wire.toPin }
      : { owner: wire.fromComponent, pin: wire.fromPin };
    const type = componentType(plan, other.owner);
    if (type === "stepper_motor" || (type === "servo" && other.pin === "VCC")) {
      signalLoad.set(boardPin, [...(signalLoad.get(boardPin) || []), `${other.owner}.${other.pin} (${type})`]);
    }
  }
  for (const [pin, loads] of signalLoad) {
    if (loads.some((load) => load.includes("stepper_motor"))) {
      errors.push(`Board signal ${pin} must not drive a stepper coil directly (${loads.join(", ")}).`);
    }
  }

  return [...new Set(errors)];
}

export function assertSafeToBuild(plan: ProjectPlan) {
  const errors = runSafetyGate(plan);
  if (errors.length) throw new Error(`Safety gate failed: ${errors.join(" ")}`);
}

export function safetyGateForDesign(design: CircuitDesign) {
  return runSafetyGate({
    title: design.title,
    summary: design.summary,
    board: design.board,
    boardMeta: design.boardMeta,
    components: design.components,
    connections: design.connections,
    parts: design.parts,
    instructions: design.instructions,
  });
}
