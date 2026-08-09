import type { ProjectSpec } from "./project.ts";

export type CircuitJsonElement = Record<string, unknown> & { type: string };

type Point = { x: number; y: number };

/** Convert Blueprint's validated project model into the small Circuit JSON subset
 * consumed by the tscircuit schematic viewer. Blueprint remains the source of truth. */
export function projectToCircuitJson(project: ProjectSpec): CircuitJsonElement[] {
  const elements: CircuitJsonElement[] = [];
  const boardName = (project.boardMeta?.name || project.board).toUpperCase();
  const owners = [
    { id: "board", name: boardName, x: -7 },
    ...project.components.map((part, index) => ({ id: part.id, name: part.name, x: 5 + (index % 2) * 7 })),
  ];
  const ownerPins = new Map(owners.map((owner) => [owner.id, usedPins(project, owner.id)]));
  const ownerCenters = new Map<string, Point>();
  let rightY = 0;

  owners.forEach((owner, index) => {
    const pins = ownerPins.get(owner.id) || [];
    const height = Math.max(2.4, pins.length * 0.62 + 0.8);
    const center = owner.id === "board" ? { x: owner.x, y: 0 } : { x: owner.x, y: rightY };
    if (owner.id !== "board") rightY -= height + 1.8;
    ownerCenters.set(owner.id, center);
    const sourceComponentId = `source_component_${owner.id}`;
    const schematicComponentId = `schematic_component_${owner.id}`;
    elements.push({ type: "source_component", ftype: "simple_chip", source_component_id: sourceComponentId, name: owner.name });
    elements.push({
      type: "schematic_component", source_component_id: sourceComponentId, schematic_component_id: schematicComponentId,
      rotation: 0, center, size: { width: owner.id === "board" ? 3.2 : 3.8, height },
      port_arrangement: { left_size: owner.id === "board" ? 0 : pins.length, right_size: owner.id === "board" ? pins.length : 0 },
      port_labels: Object.fromEntries(pins.map((pin, pinIndex) => [String(pinIndex + 1), pin])),
      symbol_display_value: owner.name,
    });
    elements.push({
      type: "schematic_text", schematic_text_id: `schematic_text_${owner.id}`, schematic_component_id: schematicComponentId,
      text: owner.name, position: { x: center.x, y: center.y + height / 2 + 0.35 }, rotation: 0, anchor: "center", color: "#075299",
    });
    pins.forEach((pin, pinIndex) => {
      const side = owner.id === "board" ? "right" : "left";
      const x = center.x + (side === "right" ? 1 : -1) * (owner.id === "board" ? 1.6 : 1.9);
      const y = center.y + (pins.length - 1) * 0.31 - pinIndex * 0.62;
      elements.push({
        type: "source_port", source_component_id: sourceComponentId, source_port_id: sourcePortId(owner.id, pin), name: pin,
        pin_number: pinIndex + 1, port_hints: [pin],
      });
      elements.push({
        type: "schematic_port", source_port_id: sourcePortId(owner.id, pin), schematic_port_id: schematicPortId(owner.id, pin),
        schematic_component_id: schematicComponentId, center: { x, y }, pin_number: pinIndex + 1,
        facing_direction: side, side_of_component: side, display_pin_label: pin,
      });
    });
  });

  project.connections.forEach((connection, index) => {
    const from = portCenter(elements, connection.fromComponent, connection.fromPin);
    const to = portCenter(elements, connection.toComponent, connection.toPin);
    if (!from || !to) return;
    const sourceTraceId = `source_trace_${index + 1}`;
    const lane = Math.min(from.x, to.x) + Math.abs(to.x - from.x) * (0.35 + (index % 6) * 0.05);
    elements.push({
      type: "source_trace", source_trace_id: sourceTraceId,
      connected_source_port_ids: [sourcePortId(connection.fromComponent, connection.fromPin), sourcePortId(connection.toComponent, connection.toPin)],
      connected_source_net_ids: [],
    });
    elements.push({
      type: "schematic_trace", source_trace_id: sourceTraceId, schematic_trace_id: `schematic_trace_${index + 1}`, junctions: [],
      edges: [
        { from, to: { x: lane, y: from.y }, from_schematic_port_id: schematicPortId(connection.fromComponent, connection.fromPin) },
        { from: { x: lane, y: from.y }, to: { x: lane, y: to.y } },
        { from: { x: lane, y: to.y }, to, to_schematic_port_id: schematicPortId(connection.toComponent, connection.toPin) },
      ],
    });
  });
  return elements;
}

function usedPins(project: ProjectSpec, owner: string) {
  return [...new Set(project.connections.flatMap((wire) => [
    ...(wire.fromComponent === owner ? [wire.fromPin] : []),
    ...(wire.toComponent === owner ? [wire.toPin] : []),
  ]))];
}

function safe(value: string) { return value.replace(/[^a-zA-Z0-9_]/g, (character) => `_${character.codePointAt(0)?.toString(16)}_`); }
function sourcePortId(owner: string, pin: string) { return `source_port_${safe(owner)}_${safe(pin)}`; }
function schematicPortId(owner: string, pin: string) { return `schematic_port_${safe(owner)}_${safe(pin)}`; }
function portCenter(elements: CircuitJsonElement[], owner: string, pin: string): Point | undefined {
  return elements.find((element) => element.type === "schematic_port" && element.schematic_port_id === schematicPortId(owner, pin))?.center as Point | undefined;
}
