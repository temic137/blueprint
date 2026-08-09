import { COMPONENTS } from "./project.ts";

/** Schematik-style v1: only these boards are generate targets. */
export const KIT_BOARDS = ["arduino_uno", "esp32dev", "pico"] as const;
export type KitBoardId = (typeof KIT_BOARDS)[number];

/** Parts the wiring engine + firmware path can actually finish. */
export const KIT_PART_TYPES = [
  "pushbutton",
  "buzzer",
  "led",
  "resistor",
  "dht22",
  "ssd1306",
  "lcd1602",
  "hc_sr04",
  "pir",
  "potentiometer",
  "servo",
  "ntc",
  "photoresistor",
  "rotary_encoder",
  "neopixel",
] as const;

export type KitPartType = (typeof KIT_PART_TYPES)[number];

type KitComponent = { id: string; type: KitPartType; name: string; quantity: 1 };

export type KitArchitecture = {
  title: string;
  summary: string;
  board: KitBoardId;
  components: KitComponent[];
  parts: string[];
  explanations: Array<{ componentId: string; text: string }>;
};

type KitTemplate = {
  id: string;
  match: RegExp;
  architecture: KitArchitecture;
};

function part(type: KitPartType, id: string, name?: string): KitComponent {
  return { id, type, name: name || COMPONENTS[type]?.name || type, quantity: 1 };
}

function pack(board: KitBoardId, title: string, summary: string, components: KitComponent[], explanations: KitArchitecture["explanations"]): KitArchitecture {
  const boardName = board === "arduino_uno" ? "Arduino Uno" : board === "esp32dev" ? "ESP32 DevKit V1" : "Raspberry Pi Pico";
  return {
    title,
    summary,
    board,
    components,
    parts: [`1x ${boardName}`, ...components.map((component) => `1x ${component.name}`)],
    explanations,
  };
}

/** Guaranteed projects — no LLM architect call. */
export const KIT_TEMPLATES: KitTemplate[] = [
  // ponytail: doorbell-flavored briefs must win over generic parking / motion titles
  {
    id: "hands_free_doorbell_pir",
    match: /\b(doorbell|door\s*bell|chime)\b[\s\S]{0,120}\b(pir|motion)\b|\b(pir|motion)\b[\s\S]{0,120}\b(doorbell|door\s*bell|chime)\b/i,
    architecture: pack("arduino_uno", "Hands-free doorbell", "A PIR detects someone approaching and a piezo buzzer plays a chime.", [
      part("pir", "motion"),
      part("buzzer", "buzzer"),
    ], [
      { componentId: "motion", text: "Detects someone approaching the door." },
      { componentId: "buzzer", text: "Plays the doorbell chime." },
    ]),
  },
  {
    id: "hands_free_doorbell_ultrasonic",
    match: /\b(doorbell|door\s*bell|chime)\b[\s\S]{0,120}\b(ultrasonic|hc-?sr04)\b|\b(ultrasonic|hc-?sr04)\b[\s\S]{0,120}\b(doorbell|door\s*bell|chime)\b/i,
    architecture: pack("arduino_uno", "Hands-free doorbell", "An HC-SR04 detects someone close, then lights an LED and sounds a buzzer.", [
      part("hc_sr04", "range"),
      part("resistor", "r1", "1kΩ resistor"),
      part("resistor", "r2", "2kΩ resistor"),
      part("buzzer", "buzzer"),
      part("led", "led"),
      part("resistor", "r3", "220Ω resistor"),
    ], [
      { componentId: "range", text: "Detects someone standing close to the door." },
      { componentId: "r1", text: "Top half of the HC-SR04 echo voltage divider." },
      { componentId: "r2", text: "Bottom half of the HC-SR04 echo voltage divider." },
      { componentId: "buzzer", text: "Plays the doorbell chime." },
      { componentId: "led", text: "Lights when someone is detected." },
      { componentId: "r3", text: "Current-limits the LED." },
    ]),
  },
  {
    id: "ultrasonic_parking",
    match: /\b(parking\s*sensor|distance\s*sensor|range\s*finder)\b|\b(ultrasonic|hc-?sr04)\b(?![\s\S]*\b(doorbell|door\s*bell|chime)\b)/i,
    architecture: pack("arduino_uno", "Ultrasonic parking sensor", "Measures distance with an HC-SR04 and can drive a simple alert.", [
      part("hc_sr04", "range"),
      part("resistor", "r1", "1kΩ resistor"),
      part("resistor", "r2", "2kΩ resistor"),
      part("buzzer", "buzzer"),
      part("led", "led"),
      part("resistor", "r3", "220Ω resistor"),
    ], [
      { componentId: "range", text: "Measures how far an object is in front of the sensor." },
      { componentId: "r1", text: "Top half of the HC-SR04 echo voltage divider." },
      { componentId: "r2", text: "Bottom half of the HC-SR04 echo voltage divider." },
      { componentId: "buzzer", text: "Sounds when something is too close." },
      { componentId: "led", text: "Visual close-range indicator." },
      { componentId: "r3", text: "Current-limits the LED." },
    ]),
  },
  {
    id: "temp_display",
    match: /\b(temperature|thermometer|dht22|climate)\b[\s\S]{0,80}\b(oled|lcd|display|screen)\b|\b(oled|lcd|display|screen)\b[\s\S]{0,80}\b(temperature|thermometer|dht22|climate)\b/i,
    architecture: pack("arduino_uno", "Temperature display", "Reads ambient temperature and shows it on a small OLED.", [
      part("dht22", "dht22"),
      part("ssd1306", "oled"),
    ], [
      { componentId: "dht22", text: "Reads ambient temperature and humidity." },
      { componentId: "oled", text: "Shows the temperature reading." },
    ]),
  },
  {
    id: "doorbell",
    // ponytail: hands-free / motion doorbells must clarify first — not this button template
    match: /^(?!.*\b(hands[- ]free|pir|motion|ultrasonic|touchless|no button)\b).*\b(doorbell|door\s*bell|button.*buzzer|buzzer.*button)\b/i,
    architecture: pack("arduino_uno", "Doorbell", "A pushbutton rings a buzzer.", [
      part("pushbutton", "button"),
      part("buzzer", "buzzer"),
    ], [
      { componentId: "button", text: "Press to request a ring." },
      { componentId: "buzzer", text: "Makes the doorbell sound." },
    ]),
  },
  {
    id: "motion_alarm",
    match: /\b(motion\s*(alarm|detector|sensor)|pir\b)(?![\s\S]*\b(doorbell|door\s*bell|chime)\b)/i,
    architecture: pack("arduino_uno", "Motion alarm", "A PIR sensor triggers a buzzer when motion is detected.", [
      part("pir", "motion"),
      part("buzzer", "buzzer"),
    ], [
      { componentId: "motion", text: "Detects nearby motion." },
      { componentId: "buzzer", text: "Sounds when motion is detected." },
    ]),
  },
];

export function matchKitTemplate(prompt: string): KitTemplate | undefined {
  return KIT_TEMPLATES.find((template) => template.match.test(prompt));
}

export function isKitBoard(board: string) {
  return (KIT_BOARDS as readonly string[]).includes(board);
}

export function isKitPartType(type: string) {
  return (KIT_PART_TYPES as readonly string[]).includes(type);
}

/** Fill missing resistors / drivers the wiring engine needs. */
export function ensureKitDependencies(architecture: {
  board: string;
  title: string;
  summary: string;
  components: Array<{ id: string; type?: string; name: string; quantity: number }>;
  parts: string[];
}) {
  const components = [...architecture.components];
  const types = () => components.map((component) => component.type || component.id);
  const count = (type: string) => types().filter((value) => value === type).length;
  const add = (type: KitPartType, name: string) => {
    let n = 1;
    let id: string = type;
    while (components.some((component) => component.id === id)) id = `${type}_${++n}`;
    components.push({ id, type, name, quantity: 1 });
  };

  const needLedResistors = count("led") + count("rgb_led") * 3;
  const needEchoResistors = count("hc_sr04") * 2;
  let resistors = count("resistor");
  while (resistors < needLedResistors + needEchoResistors) {
    add("resistor", "resistor");
    resistors += 1;
  }
  if (count("stepper_motor") && !count("a4988")) {
    /* steppers are outside the small kit — leave for validateArchitecture to reject */
  }

  const boardName = architecture.board === "arduino_uno" ? "Arduino Uno"
    : architecture.board === "esp32dev" ? "ESP32 DevKit V1"
      : architecture.board === "pico" ? "Raspberry Pi Pico"
        : architecture.board;
  return {
    ...architecture,
    components,
    parts: [...new Set([`1x ${boardName}`, ...components.map((component) => `1x ${component.name}`)])],
  };
}

export function kitPartsOutside(architecture: { components: readonly { type?: string; id: string; name: string }[] }) {
  return architecture.components.filter((component) => !isKitPartType(component.type || component.id));
}

export function kitCatalogForPrompt() {
  const boards = KIT_BOARDS.map((id) => {
    const label = id === "arduino_uno" ? "Arduino Uno (prefer for simple wired sensors)" : id === "esp32dev" ? "ESP32 DevKit (Wi-Fi/Bluetooth)" : "Raspberry Pi Pico";
    return `${id}: ${label}`;
  }).join("\n");
  const parts = KIT_PART_TYPES.map((type) => `${type}: ${COMPONENTS[type]?.name || type}`).join("\n");
  return { boards, parts };
}

export function outOfKitMessage(parts: readonly { name: string }[]) {
  return [
    "I can't build this with Blueprint's current starter kit.",
    `Unsupported parts: ${parts.map((part) => part.name).join(", ")}.`,
    "Supported boards: Arduino Uno, ESP32 DevKit, Raspberry Pi Pico.",
    `Supported parts include: ${KIT_PART_TYPES.slice(0, 8).join(", ")}, and a few more basic sensors/actuators.`,
    "Try a kit-sized brief — for example: “Build an ultrasonic parking sensor.”",
  ].join(" ");
}
