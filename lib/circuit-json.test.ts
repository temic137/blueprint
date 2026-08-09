import test from "node:test";
import assert from "node:assert/strict";
import { convertCircuitJsonToSchematicSvg } from "circuit-to-svg";
import { ensureBoardCard, toBoardProfile } from "./boards.ts";
import { projectToCircuitJson } from "./circuit-json.ts";
import type { ProjectSpec } from "./project.ts";

const project = {
  title: "Knob hand", summary: "A servo hand controlled by a potentiometer.", board: "esp32dev",
  boardMeta: toBoardProfile(ensureBoardCard("esp32dev")),
  components: [
    { id: "knob", type: "potentiometer", name: "Control knob", quantity: 1 },
    { id: "hand", type: "servo", name: "Hand servo", quantity: 1 },
  ],
  connections: [
    { fromComponent: "board", fromPin: "3V3", toComponent: "knob", toPin: "VCC", color: "#ef4444", purpose: "power" },
    { fromComponent: "board", fromPin: "GPIO34", toComponent: "knob", toPin: "SIG", color: "#3b82f6", purpose: "input" },
    { fromComponent: "board", fromPin: "GPIO18", toComponent: "hand", toPin: "PWM", color: "#f59e0b", purpose: "control" },
  ],
  parts: ["ESP32", "potentiometer", "servo"], instructions: ["One", "Two", "Three"], pins: [],
  files: { platformioIni: "[env:esp32dev]\nplatform = espressif32", mainCpp: "// firmware placeholder long enough for the validated project specification to accept this value" },
} satisfies ProjectSpec;

test("adapts every component, used port, and connection to renderable Circuit JSON", () => {
  const json = projectToCircuitJson(project);
  assert.equal(json.filter((item) => item.type === "schematic_component").length, 3);
  assert.equal(json.filter((item) => item.type === "schematic_trace").length, project.connections.length);
  assert.equal(json.filter((item) => item.type === "source_trace").length, project.connections.length);
  const svg = convertCircuitJsonToSchematicSvg(json as never[]);
  assert.match(svg, /<svg/);
  assert.match(svg, /schematic_trace_3/);
  assert.match(svg, /ESP32 DEVKIT/);
});

test("keeps punctuation-distinguished motor pins unique", () => {
  const motorProject = structuredClone(project);
  motorProject.components = [{ id: "motor", type: "stepper_motor", name: "Stepper motor", quantity: 1 }];
  motorProject.connections = [
    { fromComponent: "board", fromPin: "GPIO18", toComponent: "motor", toPin: "A+", color: "#3b82f6", purpose: "coil" },
    { fromComponent: "board", fromPin: "GPIO19", toComponent: "motor", toPin: "A-", color: "#3b82f6", purpose: "coil" },
  ];
  const ports = projectToCircuitJson(motorProject).filter((item) => item.type === "schematic_port" && item.schematic_component_id === "schematic_component_motor");
  assert.equal(new Set(ports.map((item) => item.schematic_port_id)).size, 2);
  assert.doesNotThrow(() => convertCircuitJsonToSchematicSvg(projectToCircuitJson(motorProject) as never[]));
});
