import { z } from "zod";
import { boardPinCompatible, isBoardSignalPin, type BoardId, type BoardProfile } from "./board-types.ts";

export type { BoardId, BoardProfile } from "./board-types.ts";

type ComponentDefinition = { name: string; tag?: string; pins: readonly string[]; description: string; firmware?: string; boardPins?: Record<string, readonly string[]> };

const boardId = z.string().regex(/^[a-z][a-z0-9_]*$/);

const ADC_INPUTS = ["GPIO32", "GPIO33", "GPIO34", "GPIO35", "GPIO36", "GPIO39"];
const DIGITAL_OUTPUTS = ["GPIO4", "GPIO13", "GPIO14", "GPIO16", "GPIO17", "GPIO18", "GPIO19", "GPIO21", "GPIO22", "GPIO23", "GPIO25", "GPIO26", "GPIO27", "GPIO32", "GPIO33"];
const DIGITAL_INPUTS = [...DIGITAL_OUTPUTS, "GPIO34", "GPIO35", "GPIO36", "GPIO39"];

export const COMPONENTS: Record<string, ComponentDefinition> = {
  // DHT22 modules are commonly 3.3–5.5V; Arduino Uno projects usually feed 5V.
  dht22: { name: "DHT22 temperature/humidity sensor", tag: "wokwi-dht22", pins: ["VCC", "DATA", "GND"], description: "digital temperature and humidity", firmware: "Adafruit DHT sensor library; include DHT.h", boardPins: { VCC: ["3V3", "5V", "VIN"], GND: ["GND"], DATA: DIGITAL_OUTPUTS } },
  // I2C OLED: power is 3.3/5V module-dependent; SDA/SCL use any digital pair (ESP allowlist remaps on non-ESP boards).
  ssd1306: { name: "SSD1306 OLED", tag: "wokwi-ssd1306", pins: ["VCC", "GND", "SDA", "SCL"], description: "small I2C display", firmware: "adafruit/Adafruit SSD1306 and Adafruit GFX Library", boardPins: { VCC: ["3V3", "5V", "VIN"], GND: ["GND"], SDA: DIGITAL_OUTPUTS, SCL: DIGITAL_OUTPUTS } },
  lcd2004: { name: "LCD2004 display", tag: "wokwi-lcd2004", pins: ["VSS", "VDD", "V0", "RS", "RW", "E", "D4", "D5", "D6", "D7", "A", "K"], description: "20x4 parallel character display" },
  potentiometer: { name: "10k potentiometer", tag: "wokwi-potentiometer", pins: ["VCC", "SIG", "GND"], description: "analog knob input", boardPins: { VCC: ["3V3"], GND: ["GND"], SIG: ADC_INPUTS } },
  slide_potentiometer: { name: "slide potentiometer", tag: "wokwi-slide-potentiometer", pins: ["VCC", "SIG", "GND"], description: "analog slider input" },
  servo: { name: "SG90 servo", tag: "wokwi-servo", pins: ["VCC", "PWM", "GND"], description: "position-controlled actuator", firmware: "madhephaestus/ESP32Servo; include ESP32Servo.h, never Servo.h", boardPins: { VCC: ["VIN"], GND: ["GND"], PWM: DIGITAL_OUTPUTS } },
  pca9685: { name: "PCA9685 16-channel PWM servo driver", pins: ["VCC", "GND", "SDA", "SCL", "V+", "CH0", "CH1", "CH2", "CH3", "CH4", "CH5", "CH6", "CH7"], description: "I2C PWM expander for up to eight modeled servos; logic uses 3.3V and servos use a separate regulated 5V supply", firmware: "adafruit/Adafruit PWM Servo Driver Library; include Adafruit_PWMServoDriver.h", boardPins: { VCC: ["3V3"], GND: ["GND"], SDA: DIGITAL_OUTPUTS, SCL: DIGITAL_OUTPUTS, "V+": [], CH0: [], CH1: [], CH2: [], CH3: [], CH4: [], CH5: [], CH6: [], CH7: [] } },
  servo_power_supply: { name: "regulated 5V servo power supply", pins: ["POS", "NEG"], description: "separate regulated 5V supply sized for servo stall current; NEG shares ESP32 ground and POS feeds the PCA9685 servo rail", boardPins: { POS: [], NEG: ["GND"] } },
  stepper_motor: { name: "4-wire bipolar stepper motor", tag: "wokwi-stepper-motor", pins: ["A-", "A+", "B+", "B-"], description: "precise rotary actuator; must connect through one A4988 driver, never directly to ESP32", firmware: "waspinator/AccelStepper", boardPins: { "A-": [], "A+": [], "B+": [], "B-": [] } },
  a4988: { name: "A4988 stepper driver", pins: ["VMOT", "GND", "VDD", "STEP", "DIR", "EN", "1A", "1B", "2A", "2B"], description: "one bipolar stepper driver; VMOT uses external 8-35V supply, VDD uses ESP32 3V3, shared ground; 1A/1B/2A/2B connect only to the motor coils", firmware: "waspinator/AccelStepper", boardPins: { VMOT: [], GND: ["GND"], VDD: ["3V3"], STEP: DIGITAL_OUTPUTS, DIR: DIGITAL_OUTPUTS, EN: ["GND", ...DIGITAL_OUTPUTS], "1A": [], "1B": [], "2A": [], "2B": [] } },
  external_dc_supply: { name: "external DC motor supply", pins: ["POS", "NEG"], description: "separate 8-12V motor supply; POS connects to driver VMOT and NEG connects to ESP32 GND for a shared reference; never connect POS to ESP32", boardPins: { POS: [], NEG: ["GND"] } },
  hc_sr04: { name: "HC-SR04 ultrasonic sensor", tag: "wokwi-hc-sr04", pins: ["VCC", "TRIG", "ECHO", "GND"], description: "5V distance sensor; ECHO->R1->junction->MCU input, junction->R2->GND", boardPins: { VCC: ["5V", "VIN"], GND: ["GND"], TRIG: DIGITAL_OUTPUTS, ECHO: [] } },
  pir: { name: "PIR motion sensor", tag: "wokwi-pir-motion-sensor", pins: ["VCC", "OUT", "GND"], description: "human motion detector" },
  photoresistor: { name: "photoresistor module", tag: "wokwi-photoresistor-sensor", pins: ["VCC", "GND", "DO", "AO"], description: "ambient light sensor" },
  ntc: { name: "NTC temperature sensor", tag: "wokwi-ntc-temperature-sensor", pins: ["VCC", "OUT", "GND"], description: "analog temperature sensor" },
  flame_sensor: { name: "flame sensor module", tag: "wokwi-flame-sensor", pins: ["VCC", "GND", "DOUT", "AOUT"], description: "flame/infrared detector" },
  gas_sensor: { name: "MQ gas sensor module", tag: "wokwi-gas-sensor", pins: ["VCC", "GND", "DOUT", "AOUT"], description: "gas/smoke detector" },
  sound_sensor: { name: "sound sensor module", tag: "wokwi-big-sound-sensor", pins: ["VCC", "GND", "DOUT", "AOUT"], description: "sound level detector" },
  small_sound_sensor: { name: "compact sound sensor", tag: "wokwi-small-sound-sensor", pins: ["VCC", "GND", "DOUT", "AOUT"], description: "compact analog and digital sound detector" },
  heartbeat: { name: "heartbeat sensor", tag: "wokwi-heart-beat-sensor", pins: ["VCC", "OUT", "GND"], description: "analog pulse sensor" },
  joystick: { name: "analog joystick", tag: "wokwi-analog-joystick", pins: ["VCC", "VERT", "HORZ", "SEL", "GND"], description: "two-axis analog input with button" },
  rotary_encoder: { name: "KY-040 rotary encoder", tag: "wokwi-ky-040", pins: ["CLK", "DT", "SW", "VCC", "GND"], description: "digital incremental rotary input; not an analog control" },
  rotary_dialer: { name: "rotary telephone dial", tag: "wokwi-rotary-dialer", pins: ["GND", "DIAL", "PULSE"], description: "pulse-based rotary number input", boardPins: { GND: ["GND"], DIAL: DIGITAL_OUTPUTS, PULSE: DIGITAL_OUTPUTS } },
  pushbutton: { name: "pushbutton", tag: "wokwi-pushbutton", pins: ["1", "2"], description: "momentary digital input" },
  pushbutton_6mm: { name: "6mm tactile pushbutton", tag: "wokwi-pushbutton-6mm", pins: ["1.l", "2.l", "1.r", "2.r"], description: "four-leg momentary tactile input; same-numbered legs are internally common" },
  slide_switch: { name: "slide switch", tag: "wokwi-slide-switch", pins: ["1", "2", "3"], description: "on/off or selector input" },
  tilt_switch: { name: "tilt switch module", tag: "wokwi-tilt-switch", pins: ["VCC", "OUT", "GND"], description: "orientation/tilt detector" },
  buzzer: { name: "piezo buzzer", tag: "wokwi-buzzer", pins: ["POS", "NEG"], description: "tone and alarm output", boardPins: { POS: DIGITAL_OUTPUTS, NEG: ["GND"] } },
  resistor: { name: "resistor", tag: "wokwi-resistor", pins: ["1", "2"], description: "current limiting or voltage divider" },
  led: { name: "LED", tag: "wokwi-led", pins: ["A", "C"], description: "single indicator; requires a series resistor" },
  rgb_led: { name: "RGB LED", tag: "wokwi-rgb-led", pins: ["R", "COM", "G", "B"], description: "three-channel color indicator; requires resistors" },
  neopixel: { name: "NeoPixel RGB LED", tag: "wokwi-neopixel", pins: ["VDD", "DIN", "DOUT", "VSS"], description: "addressable RGB LED", firmware: "adafruit/Adafruit NeoPixel" },
  neopixel_matrix: { name: "NeoPixel LED matrix", tag: "wokwi-neopixel-matrix", pins: ["VCC", "DIN", "DOUT", "GND"], description: "addressable RGB LED matrix", firmware: "adafruit/Adafruit NeoPixel", boardPins: { VCC: ["VIN"], DIN: DIGITAL_OUTPUTS, DOUT: [], GND: ["GND"] } },
  neopixel_ring: { name: "NeoPixel LED ring", tag: "wokwi-neopixel-ring", pins: ["VCC", "DIN", "DOUT", "GND"], description: "addressable RGB LED ring", firmware: "adafruit/Adafruit NeoPixel", boardPins: { VCC: ["VIN"], DIN: DIGITAL_OUTPUTS, DOUT: [], GND: ["GND"] } },
  seven_segment: { name: "single-digit seven-segment display", tag: "wokwi-7segment", pins: ["COM.1", "COM.2", "A", "B", "C", "D", "E", "F", "G", "DP"], description: "numeric LED display; every driven segment requires its own series resistor" },
  led_bar_graph: { name: "10-segment LED bar graph", tag: "wokwi-led-bar-graph", pins: ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10"], description: "ten independent LEDs; every driven segment requires its own series resistor" },
  dip_switch_8: { name: "8-position DIP switch", tag: "wokwi-dip-switch-8", pins: ["1a", "1b", "2a", "2b", "3a", "3b", "4a", "4b", "5a", "5b", "6a", "6b", "7a", "7b", "8a", "8b"], description: "eight independent on/off configuration inputs" },
  mpu6050: { name: "MPU6050 IMU", tag: "wokwi-mpu6050", pins: ["VCC", "GND", "SDA", "SCL", "INT"], description: "I2C accelerometer and gyroscope", firmware: "adafruit/Adafruit MPU6050", boardPins: { VCC: ["3V3", "5V", "VIN"], GND: ["GND"], SDA: DIGITAL_OUTPUTS, SCL: DIGITAL_OUTPUTS, INT: DIGITAL_OUTPUTS } },
  ds1307: { name: "DS1307 real-time clock", tag: "wokwi-ds1307", pins: ["5V", "GND", "SDA", "SCL", "SQW"], description: "I2C clock and calendar", firmware: "adafruit/RTClib" },
  hx711: { name: "HX711 load-cell amplifier", tag: "wokwi-hx711", pins: ["VCC", "DT", "SCK", "GND"], description: "load-cell/scale interface", firmware: "bogde/HX711" },
  ir_receiver: { name: "IR receiver", tag: "wokwi-ir-receiver", pins: ["VCC", "DAT", "GND"], description: "infrared remote receiver", firmware: "z3t0/IRremote" },
  microsd: { name: "microSD card module", tag: "wokwi-microsd-card", pins: ["VCC", "GND", "SCK", "MISO", "MOSI", "CS"], description: "SPI file storage" },
  ili9341: { name: "ILI9341 TFT display", tag: "wokwi-ili9341", pins: ["VCC", "GND", "CS", "RST", "DC", "MOSI", "SCK", "LED", "MISO"], description: "color SPI display", firmware: "adafruit/Adafruit ILI9341 and Adafruit GFX Library" },
  lcd1602: { name: "LCD1602 display", tag: "wokwi-lcd1602", pins: ["VSS", "VDD", "VO", "RS", "RW", "E", "D4", "D5", "D6", "D7", "A", "K"], description: "16x2 parallel character display" },
  membrane_keypad: { name: "4x4 membrane keypad", tag: "wokwi-membrane-keypad", pins: ["R1", "R2", "R3", "R4", "C1", "C2", "C3", "C4"], description: "sixteen-key matrix input" },
  generic_digital_sensor: { name: "generic digital sensor module", pins: ["VCC", "OUT", "GND"], description: "datasheet-defined digital sensor fallback", boardPins: { VCC: ["3V3", "VIN"], OUT: DIGITAL_INPUTS, GND: ["GND"] } },
  generic_analog_sensor: { name: "generic analog sensor module", pins: ["VCC", "OUT", "GND"], description: "datasheet-defined analog sensor fallback", boardPins: { VCC: ["3V3"], OUT: ADC_INPUTS, GND: ["GND"] } },
  generic_i2c_module: { name: "generic I2C module", pins: ["VCC", "GND", "SDA", "SCL"], description: "datasheet-defined I2C peripheral fallback", boardPins: { VCC: ["3V3", "VIN"], GND: ["GND"], SDA: DIGITAL_OUTPUTS, SCL: DIGITAL_OUTPUTS } },
  generic_spi_module: { name: "generic SPI module", pins: ["VCC", "GND", "SCK", "MISO", "MOSI", "CS"], description: "datasheet-defined SPI peripheral fallback", boardPins: { VCC: ["3V3", "VIN"], GND: ["GND"], SCK: DIGITAL_OUTPUTS, MISO: DIGITAL_INPUTS, MOSI: DIGITAL_OUTPUTS, CS: DIGITAL_OUTPUTS } },
  generic_uart_module: { name: "generic UART module", pins: ["VCC", "GND", "TX", "RX"], description: "datasheet-defined serial peripheral fallback", boardPins: { VCC: ["3V3", "VIN"], GND: ["GND"], TX: DIGITAL_INPUTS, RX: DIGITAL_OUTPUTS } },
  generic_digital_actuator: { name: "generic low-voltage actuator module", pins: ["VCC", "IN", "GND"], description: "driver-equipped low-voltage actuator fallback", boardPins: { VCC: ["3V3", "VIN"], IN: DIGITAL_OUTPUTS, GND: ["GND"] } },
} as const;

export const WOKWI_ELEMENT_EXCLUSIONS: Record<string, string> = {
  "wokwi-arduino-mega": "controller board; select via board cards (fetched from catalog when chosen)",
  "wokwi-franzininho": "controller board; fetch via Wokwi board discovery when selected",
  "wokwi-nano-rp2040-connect": "controller board; use pico or fetch when selected",
  "wokwi-esp32-devkit-v1": "Blueprint controller board, rendered separately",
  "wokwi-arduino-uno": "Blueprint controller board, rendered separately",
  "wokwi-arduino-nano": "Blueprint controller board, rendered separately",
  "wokwi-pi-pico": "Blueprint controller board, rendered separately",
  "wokwi-ir-remote": "wireless test accessory with no circuit terminals",
  "wokwi-ks2e-m-dc5": "bare relay requires a transistor and flyback protection model not yet validated",
  "wokwi-biaxial-stepper": "bare dual-axis actuator without a validated driver model",
};

export const BOARD_PINS = () => [] as string[];
export const COMPONENT_IDS = Object.keys(COMPONENTS);

export type ComponentSupportLevel = "validated" | "generic-family" | "datasheet-derived" | "visual-only" | "unsupported";
export type ComponentRegistryRecord = {
  id: string; name: string; aliases: string[]; category: string; capabilities: string[]; supportLevel: ComponentSupportLevel;
  source: string; baseType: string; pins: readonly string[]; boardPins?: Record<string, readonly string[]>; description: string; visual?: string; firmware?: string; requirements?: string[];
};

const REGISTRY_METADATA: Record<string, Partial<Pick<ComponentRegistryRecord, "aliases" | "category" | "capabilities" | "supportLevel" | "source">>> = {
  dht22: { aliases: ["temperature and humidity sensor"], category: "sensor", capabilities: ["temperature_sensing", "humidity_sensing"] },
  ntc: { aliases: ["thermistor"], category: "sensor", capabilities: ["temperature_sensing"] },
  pir: { aliases: ["motion detector", "HC-SR501"], category: "sensor", capabilities: ["motion_detection"] },
  hc_sr04: { aliases: ["ultrasonic sensor", "range finder"], category: "sensor", capabilities: ["distance_measurement"] },
  ssd1306: { aliases: ["OLED"], category: "display", capabilities: ["display_output"] },
  lcd1602: { aliases: ["16x2 LCD"], category: "display", capabilities: ["display_output"] },
  lcd2004: { aliases: ["20x4 LCD"], category: "display", capabilities: ["display_output"] },
  ili9341: { aliases: ["TFT screen"], category: "display", capabilities: ["display_output"] },
  servo: { aliases: ["SG90", "servo motor"], category: "actuator", capabilities: ["position_control", "rotation"] },
  pca9685: { aliases: ["16-channel servo driver", "PWM expander", "servo controller"], category: "driver", capabilities: ["servo_expansion", "i2c_peripheral"] },
  servo_power_supply: { aliases: ["5V servo supply", "external servo power"], category: "power", capabilities: ["servo_power"] },
  stepper_motor: { aliases: ["bipolar stepper"], category: "actuator", capabilities: ["precise_rotation"] },
  potentiometer: { aliases: ["rotary knob", "analog knob"], category: "input", capabilities: ["analog_control"] },
  buzzer: { aliases: ["beeper", "audible alarm"], category: "output", capabilities: ["sound_output"] },
  led: { aliases: ["indicator light"], category: "output", capabilities: ["light_output"] },
  generic_digital_sensor: { aliases: ["digital sensor module"], category: "generic", capabilities: ["digital_sensing"], supportLevel: "generic-family" },
  generic_analog_sensor: { aliases: ["analog sensor module"], category: "generic", capabilities: ["analog_sensing"], supportLevel: "generic-family" },
  generic_i2c_module: { aliases: ["I2C breakout", "I2C sensor"], category: "generic", capabilities: ["i2c_peripheral"], supportLevel: "generic-family" },
  generic_spi_module: { aliases: ["SPI breakout", "SPI sensor"], category: "generic", capabilities: ["spi_peripheral"], supportLevel: "generic-family" },
  generic_uart_module: { aliases: ["serial module", "UART sensor"], category: "generic", capabilities: ["uart_peripheral"], supportLevel: "generic-family" },
  generic_digital_actuator: { aliases: ["actuator module"], category: "generic", capabilities: ["digital_actuation"], supportLevel: "generic-family" },
};

export function componentRegistry(extra: readonly ComponentRegistryRecord[] = []) {
  const builtIn = COMPONENT_IDS.map((id): ComponentRegistryRecord => {
    const definition = COMPONENTS[id];
    const metadata = REGISTRY_METADATA[id] || {};
    return { id, name: definition.name, aliases: metadata.aliases || [], category: metadata.category || "component", capabilities: metadata.capabilities || [], supportLevel: metadata.supportLevel || "validated", source: metadata.source || (definition.tag ? "@wokwi/elements + Blueprint electrical validation" : "Blueprint validated catalog"), baseType: id, pins: definition.pins, description: definition.description, visual: definition.tag, firmware: definition.firmware };
  });
  return [...builtIn, ...extra];
}

export function searchRegistryRecords(query: string, records: readonly ComponentRegistryRecord[], limit = 12) {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2);
  return records.map((record) => {
    const identity = `${record.id} ${record.name} ${record.aliases.join(" ")}`.toLowerCase();
    const context = `${identity} ${record.category} ${record.capabilities.join(" ")} ${record.description}`;
    const relevance = terms.reduce((total, term) => total + (identity.includes(term) ? 5 : context.includes(term) ? 1 : 0), 0);
    const score = relevance ? relevance + (record.baseType && record.supportLevel !== "visual-only" ? 2 : 0) : 0;
    return { record, score };
  }).filter(({ score }) => !terms.length || score > 0).sort((a, b) => b.score - a.score || a.record.name.localeCompare(b.record.name)).slice(0, limit).map(({ record }) => record);
}

export function searchComponentRegistry(query: string, extra: readonly ComponentRegistryRecord[] = [], limit = 12) {
  return searchRegistryRecords(query, componentRegistry(extra), limit);
}

export function unsupportedRequestedParts(prompt: string, records: readonly ComponentRegistryRecord[], boardIdentities: readonly string[] = []) {
  const candidates = prompt.match(/\b(?:[A-Z]{2,}[A-Z0-9]*-[A-Z0-9-]+|(?=[A-Za-z0-9-]*[A-Za-z])(?=[A-Za-z0-9-]*\d)[A-Za-z][A-Za-z0-9-]{3,})\b/g) || [];
  const covered = [...boardIdentities, ...records.flatMap((record) => [record.id, record.name, ...record.aliases])]
    .map((value) => value.toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter((identity) => identity.length >= 3);
  return [...new Set(candidates)].filter((candidate) => {
    const normalized = candidate.toLowerCase().replace(/[^a-z0-9]/g, "");
    return !covered.some((identity) => identity.includes(normalized) || normalized.includes(identity));
  });
}

const componentId = z.string().refine((id) => id in COMPONENTS, "Unsupported component");
const registryMetadataSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  supportLevel: z.enum(["validated", "generic-family", "datasheet-derived", "visual-only", "unsupported"]),
  source: z.string().min(3).max(500),
  capabilities: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).max(20),
  firmware: z.string().max(500).optional(),
  requirements: z.array(z.string().min(3).max(300)).max(12).optional(),
  pins: z.array(z.string().min(1).max(40)).min(1).max(40).optional(),
  boardPins: z.record(z.string(), z.array(z.string())).optional(),
}).strict();
const componentSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9_]*$/), type: componentId.optional(), name: z.string(), quantity: z.number().int().min(1).max(1), registry: registryMetadataSchema.optional() }).strict().superRefine((component, context) => {
  if (!component.type && !(component.id in COMPONENTS) && !component.registry?.pins?.length) context.addIssue({ code: "custom", path: ["type"], message: "A supported component type or trusted registry pin contract is required." });
});
const connectionSchema = z.object({
  fromComponent: z.string(), fromPin: z.string(), toComponent: z.string(), toPin: z.string(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/), purpose: z.string().min(2).max(100),
}).strict();
const filesSchema = z.object({ platformioIni: z.string().min(20), mainCpp: z.string().min(80) }).strict();
const boardMetaSchema = z.object({
  name: z.string().min(2).max(120),
  platformio: z.string().max(80),
  platform: z.string().min(2).max(80),
  family: z.string().min(2).max(40),
  logicVoltage: z.number().positive().max(24),
  pins: z.array(z.string()).min(3).max(120).readonly(),
  signalPins: z.array(z.string()).min(1).max(100).readonly(),
  visual: z.string().max(80).optional(),
  summary: z.string().min(5).max(400),
}).strict();

export const ProjectPlanSchema = z.object({
  title: z.string().min(3).max(80),
  summary: z.string().min(10).max(240),
  board: boardId,
  boardMeta: boardMetaSchema.optional(),
  components: z.array(componentSchema).min(1).max(12),
  connections: z.array(connectionSchema).min(2).max(50),
  parts: z.array(z.string()).min(2).max(30),
  instructions: z.array(z.string()).min(3).max(20),
}).strict();

const explanationSchema = z.object({
  componentId: z.string().regex(/^[a-z][a-z0-9_]*$/),
  text: z.string().min(5).max(240),
}).strict();

export const ProjectSpecSchema = ProjectPlanSchema.extend({
  pins: z.array(z.object({ component: z.string(), pin: z.string(), boardPin: z.string(), purpose: z.string() }).strict()),
  files: filesSchema,
  explanations: z.array(explanationSchema).max(20).optional(),
  generation: z.object({
    calls: z.number().int().min(1), inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0),
    providers: z.array(z.string()), models: z.array(z.string()),
  }).strict().optional(),
}).strict();

export const BuildOutputSchema = z.object({
  connections: z.array(connectionSchema).min(2).max(50), instructions: z.array(z.string()).min(3).max(20), files: filesSchema,
}).strict();

export type ProjectPlan = z.infer<typeof ProjectPlanSchema>;
export type ProjectSpec = z.infer<typeof ProjectSpecSchema>;

export const ArchitectureSchema = z.object({
  title: z.string().min(3).max(80), summary: z.string().min(10).max(240), board: boardId,
  boardMeta: boardMetaSchema.optional(),
  components: z.array(componentSchema).min(1).max(12), parts: z.array(z.string()).min(2).max(30),
}).strict();

/** LLM-authored circuit: architecture + netlist + how-to + bite-size explanations. */
export const CircuitDesignSchema = ArchitectureSchema.extend({
  connections: z.array(connectionSchema).min(2).max(50),
  instructions: z.array(z.string()).min(3).max(20),
  explanations: z.array(explanationSchema).min(1).max(20),
}).strict();
export type CircuitDesign = z.infer<typeof CircuitDesignSchema>;

export const WiringSchema = z.object({ connections: z.array(connectionSchema).min(2).max(50), instructions: z.array(z.string()).min(3).max(20) }).strict();

export function validateArchitecture(architecture: { components: readonly { id: string; type?: string }[] }) {
  const types = architecture.components.map((component) => component.type || component.id);
  const stepperCount = types.filter((type) => type === "stepper_motor").length;
  const driverCount = types.filter((type) => type === "a4988").length;
  const resistorCount = types.filter((type) => type === "resistor").length;
  const servoCount = types.filter((type) => type === "servo").length;
  const servoDriverCount = types.filter((type) => type === "pca9685").length;
  const servoSupplyCount = types.filter((type) => type === "servo_power_supply").length;
  const requiredResistors = types.filter((type) => type === "led").length + types.filter((type) => type === "rgb_led").length * 3 + types.filter((type) => type === "hc_sr04").length * 2;
  const errors: string[] = [];
  if (stepperCount !== driverCount) errors.push("Each stepper motor requires exactly one A4988 driver component.");
  if (driverCount && !types.includes("external_dc_supply")) errors.push("Stepper drivers require an external_dc_supply component for motor power.");
  if (!driverCount && types.includes("external_dc_supply")) errors.push("An external motor supply may only be selected with a stepper driver that uses it.");
  if (servoDriverCount > 1) errors.push("Blueprint currently supports one PCA9685 servo driver per project.");
  if (servoDriverCount && !servoCount) errors.push("A PCA9685 may only be selected when it controls at least one servo.");
  if (servoDriverCount && servoSupplyCount !== 1) errors.push("A PCA9685 servo project requires exactly one regulated 5V servo_power_supply.");
  if (!servoDriverCount && servoSupplyCount) errors.push("A servo_power_supply may only be selected with a PCA9685 servo driver.");
  if (servoDriverCount && servoCount > 8) errors.push("Blueprint currently models at most eight servo channels on one PCA9685.");
  if (resistorCount < requiredResistors) errors.push(`This architecture requires at least ${requiredResistors} resistor components: one per LED channel and two per HC-SR04 ECHO voltage divider.`);
  return errors;
}

const componentJsonSchema = { type: "object", additionalProperties: false, required: ["id", "type", "name", "quantity"], properties: { id: { type: "string" }, type: { type: "string", enum: COMPONENT_IDS }, name: { type: "string" }, quantity: { type: "integer", enum: [1] } } };
const partsJsonSchema = { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "quantity", "notes"], properties: { name: { type: "string" }, quantity: { type: "integer" }, notes: { type: "string" } } } };

const connectionProperties = {
  fromComponent: { type: "string" }, fromPin: { type: "string" },
  toComponent: { type: "string" }, toPin: { type: "string" },
  color: { type: "string", enum: ["#ef4444", "#111827", "#f59e0b", "#3b82f6", "#8b5cf6", "#14b8a6"] }, purpose: { type: "string" },
};

export const PROJECT_JSON_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["title", "summary", "board", "components", "connections", "parts", "instructions"],
  properties: {
    title: { type: "string" }, summary: { type: "string" }, board: { type: "string" },
    components: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "type", "name", "quantity"], properties: { id: { type: "string" }, type: { type: "string", enum: COMPONENT_IDS }, name: { type: "string" }, quantity: { type: "integer", enum: [1] } } } },
    connections: { type: "array", items: { type: "object", additionalProperties: false, required: Object.keys(connectionProperties), properties: connectionProperties } },
    parts: { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "quantity", "notes"], properties: { name: { type: "string" }, quantity: { type: "integer" }, notes: { type: "string" } } } },
    instructions: { type: "array", items: { type: "string" } },
  },
} as const;

export const ARCHITECTURE_JSON_SCHEMA = {
  type: "object", additionalProperties: false, required: ["title", "summary", "board", "components", "parts"],
  properties: { title: { type: "string" }, summary: { type: "string" }, board: { type: "string" }, components: { type: "array", items: componentJsonSchema }, parts: partsJsonSchema },
} as const;

export const WIRING_JSON_SCHEMA = {
  type: "object", additionalProperties: false, required: ["connections", "instructions"],
  properties: { connections: { type: "array", items: { type: "object", additionalProperties: false, required: Object.keys(connectionProperties), properties: connectionProperties } }, instructions: { type: "array", items: { type: "string" } } },
} as const;

export const FILES_JSON_SCHEMA = {
  type: "object", additionalProperties: false, required: ["platformioIni", "mainCpp"],
  properties: { platformioIni: { type: "string" }, mainCpp: { type: "string" } },
} as const;

export function validateHardware(project: ProjectPlan) {
  const errors: string[] = validateArchitecture(project);
  const profile = project.boardMeta;
  if (!profile) {
    errors.push(`Missing board card metadata for ${project.board}`);
    return [...new Set(errors)];
  }
  const safePins = new Set<string>(profile.pins);
  const selectedComponents = new Map(project.components.map((component) => [component.id, component]));
  const selected = new Map(project.components.map((component) => [component.id, component.type || component.id]));
  const validPin = (owner: string, pin: string) => {
    const component = selectedComponents.get(owner);
    return owner === "board" ? safePins.has(pin) : Boolean(component && (COMPONENTS[component.type || component.id]?.pins || component.registry?.pins || []).includes(pin));
  };
  for (const connection of project.connections) {
    if (!validPin(connection.fromComponent, connection.fromPin)) errors.push(`Unsupported endpoint: ${connection.fromComponent}.${connection.fromPin}`);
    if (!validPin(connection.toComponent, connection.toPin)) errors.push(`Unsupported endpoint: ${connection.toComponent}.${connection.toPin}`);
    const componentOwner = connection.fromComponent === "board" ? connection.toComponent : connection.toComponent === "board" ? connection.fromComponent : null;
    const componentPin = connection.fromComponent === "board" ? connection.toPin : connection.toComponent === "board" ? connection.fromPin : null;
    const boardPin = connection.fromComponent === "board" ? connection.fromPin : connection.toComponent === "board" ? connection.toPin : null;
    if (componentOwner && componentPin && boardPin) {
      const component = selectedComponents.get(componentOwner);
      const allowed = component && (COMPONENTS[component.type || component.id]?.boardPins || component.registry?.boardPins)?.[componentPin];
      if (allowed && !boardPinCompatible(profile, allowed, boardPin)) errors.push(`${componentOwner}.${componentPin} must connect to a compatible ${project.board} terminal (allowed family: ${allowed.join(" or ")}), not ${boardPin}.`);
    }
  }
  const terminalUse = new Map<string, number>();
  for (const wire of project.connections) for (const [owner, pin] of [[wire.fromComponent, wire.fromPin], [wire.toComponent, wire.toPin]]) {
    if (owner === "board") continue;
    const type = selected.get(owner) || "";
    // 6mm tactile switches short 1.l↔1.r and 2.l↔2.r internally — count as one terminal family.
    const side = type === "pushbutton_6mm" ? String(pin).match(/^(\d+)\.[lr]$/i) : null;
    const key = side ? `${owner}.${side[1]}` : `${owner}.${pin}`;
    terminalUse.set(key, (terminalUse.get(key) || 0) + 1);
  }
  for (const [terminal, count] of terminalUse) {
    const owner = terminal.slice(0, terminal.indexOf("."));
    if (count > 1 && !["resistor", "external_dc_supply", "servo_power_supply", "pca9685"].includes(selected.get(owner) || "")) errors.push(`Duplicate wiring on ${terminal}.`);
  }
  const wireKeys = project.connections.map((wire) => [`${wire.fromComponent}.${wire.fromPin}`, `${wire.toComponent}.${wire.toPin}`].sort().join("--"));
  if (new Set(wireKeys).size !== wireKeys.length) errors.push("The circuit contains duplicate wires.");
  for (const component of project.components) if (!project.connections.some((wire) => wire.fromComponent === component.id || wire.toComponent === component.id)) errors.push(`${component.id} is selected but not wired.`);
  const boardSignals = new Map<string, string[]>();
  for (const wire of project.connections) {
    const boardPin = wire.fromComponent === "board" ? wire.fromPin : wire.toComponent === "board" ? wire.toPin : null;
    if (boardPin && isBoardSignalPin(profile, boardPin)) boardSignals.set(boardPin, [...(boardSignals.get(boardPin) || []), wire.purpose]);
  }
  for (const [pin, purposes] of boardSignals) if (purposes.length > 1 && !purposes.every((purpose) => /i2c/i.test(purpose))) errors.push(`${pin} is assigned to multiple signals.`);
  if (project.instructions.some((instruction) => /(?:add|connect|place|use).{0,50}resistor|resistor.{0,50}(?:between|divider)/i.test(instruction)) && ![...selected.values()].includes("resistor")) errors.push("Instructions require a resistor that is missing from the component diagram.");
  if (!project.instructions.some((instruction) => /disconnect|unplug|power off/i.test(instruction))) errors.push("Instructions must say to disconnect power before wiring.");
  if (!project.connections.some((wire) => (wire.fromComponent === "board" && wire.fromPin === "GND") || (wire.toComponent === "board" && wire.toPin === "GND"))) errors.push("Every project must share a ground connection.");
  if ([...selected.values()].some((type) => type === "led" || type === "rgb_led") && ![...selected.values()].includes("resistor")) errors.push("LED circuits require a resistor component in the wiring diagram.");
  const types = [...selected.values()];
  const linked = (owner: string, pin: string, targetType: string, targetPins: readonly string[]) => project.connections.some((wire) => {
    const other = wire.fromComponent === owner && wire.fromPin === pin ? [wire.toComponent, wire.toPin] : wire.toComponent === owner && wire.toPin === pin ? [wire.fromComponent, wire.fromPin] : null;
    return Boolean(other && selected.get(other[0]) === targetType && targetPins.includes(other[1]));
  });
  const linkedToBoard = (owner: string, pin: string, boardPins: readonly string[]) => project.connections.some((wire) =>
    (wire.fromComponent === owner && wire.fromPin === pin && wire.toComponent === "board" && boardPins.includes(wire.toPin)) ||
    (wire.toComponent === owner && wire.toPin === pin && wire.fromComponent === "board" && boardPins.includes(wire.fromPin)));
  for (const component of project.components) {
    const type = selected.get(component.id);
    if (type === "a4988") {
      if (!linked(component.id, "VMOT", "external_dc_supply", ["POS"])) errors.push(`${component.id}.VMOT must connect to the external motor supply POS terminal.`);
      for (const [pin, boardPins] of [["VDD", ["3V3"]], ["GND", ["GND"]], ["STEP", DIGITAL_OUTPUTS], ["DIR", DIGITAL_OUTPUTS]] as const) if (!linkedToBoard(component.id, pin, boardPins)) errors.push(`${component.id}.${pin} must connect to a suitable ESP32 terminal.`);
      for (const pin of ["1A", "1B", "2A", "2B"]) if (!linked(component.id, pin, "stepper_motor", ["A-", "A+", "B+", "B-"])) errors.push(`${component.id}.${pin} must connect to its stepper motor.`);
    }
    if (type === "stepper_motor") for (const pin of ["A-", "A+", "B+", "B-"]) if (!linked(component.id, pin, "a4988", ["1A", "1B", "2A", "2B"])) errors.push(`${component.id}.${pin} must connect through an A4988 driver.`);
    if (type === "external_dc_supply" && !linkedToBoard(component.id, "NEG", ["GND"])) errors.push(`${component.id}.NEG must connect to ESP32 GND.`);
    if (type === "servo_power_supply" && !linkedToBoard(component.id, "NEG", ["GND"])) errors.push(`${component.id}.NEG must connect to ESP32 GND.`);
    if (type === "pca9685") {
      for (const [pin, boardPins] of [["VCC", ["3V3"]], ["GND", ["GND"]], ["SDA", DIGITAL_OUTPUTS], ["SCL", DIGITAL_OUTPUTS]] as const) if (!linkedToBoard(component.id, pin, boardPins)) errors.push(`${component.id}.${pin} must connect to a suitable ESP32 terminal.`);
      if (!linked(component.id, "V+", "servo_power_supply", ["POS"])) errors.push(`${component.id}.V+ must connect to the regulated servo supply POS terminal.`);
    }
    if (type === "servo" && types.includes("pca9685")) {
      if (!linked(component.id, "PWM", "pca9685", ["CH0", "CH1", "CH2", "CH3", "CH4", "CH5", "CH6", "CH7"])) errors.push(`${component.id}.PWM must connect to a PCA9685 channel.`);
      if (!linked(component.id, "VCC", "pca9685", ["V+"])) errors.push(`${component.id}.VCC must connect to the PCA9685 servo power rail.`);
      if (!linkedToBoard(component.id, "GND", ["GND"])) errors.push(`${component.id}.GND must share ESP32 ground.`);
    }
  }
  if (selected.size !== project.components.length) errors.push("Every component instance needs a unique id.");
  return [...new Set(errors)];
}

const REQUIRED_CAPABILITIES: Array<{ pattern: RegExp; label: string; capability?: string; types?: string[]; boards?: string[] }> = [
  { pattern: /\b(camera|photo|photograph|video|image capture|computer vision)\b/i, label: "camera", boards: ["esp32cam"] },
  { pattern: /\b(temperature|thermometer)\b/i, label: "temperature sensor", capability: "temperature_sensing", types: ["dht22", "ntc"] },
  { pattern: /\bhumidity\b/i, label: "humidity sensor", capability: "humidity_sensing", types: ["dht22"] },
  { pattern: /\b(oled|lcd|display|screen)\b/i, label: "display", capability: "display_output", types: ["ssd1306", "lcd1602", "lcd2004", "ili9341"] },
  { pattern: /\b(ultrasonic|distance|range finder|time.of.flight|tof)\b/i, label: "distance sensor", capability: "distance_measurement", types: ["hc_sr04"] },
  { pattern: /\b(pir|motion sensor|motion detect)\b/i, label: "motion sensor", capability: "motion_detection", types: ["pir"] },
  { pattern: /\b(potentiometer|rotary knob|analog knob)\b/i, label: "potentiometer", capability: "analog_control", types: ["potentiometer", "slide_potentiometer"] },
  { pattern: /\bservo\b/i, label: "servo motor", capability: "position_control", types: ["servo"] },
  { pattern: /\bstepper\b/i, label: "stepper motor", capability: "precise_rotation", types: ["stepper_motor"] },
  { pattern: /\b(led|indicator light)\b/i, label: "LED", capability: "light_output", types: ["led", "rgb_led", "neopixel", "neopixel_matrix", "neopixel_ring"] },
  { pattern: /\b(buzzer|beeper|audible alarm)\b/i, label: "buzzer", capability: "sound_output", types: ["buzzer"] },
  { pattern: /\b(bluetooth speaker|speaker|music|stereo audio|audio output)\b/i, label: "audio amplifier", capability: "speaker_amplification" },
  { pattern: /\b(bluetooth speaker|speaker|music|stereo audio|audio output)\b/i, label: "loudspeaker", capability: "audio_output" },
];

export function validateIntentCoverage(idea: string, architecture: { board: BoardId; components: readonly ProjectSpec["components"][number][] }) {
  const types = new Set(architecture.components.map((component) => component.type || component.id));
  const capabilities = new Set(architecture.components.flatMap((component) => [
    ...(component.registry?.capabilities || []),
    ...(REGISTRY_METADATA[component.type || component.id]?.capabilities || []),
  ]));
  return REQUIRED_CAPABILITIES.flatMap((requirement) => {
    if (!requirement.pattern.test(idea)) return [];
    const covered = requirement.boards?.includes(architecture.board) || requirement.types?.some((type) => types.has(type)) || Boolean(requirement.capability && capabilities.has(requirement.capability));
    return covered ? [] : [`The requested ${requirement.label} capability is missing from the architecture.`];
  });
}

export function derivePins(project: ProjectPlan) {
  return project.connections.map((wire) => wire.fromComponent === "board"
    ? { component: wire.toComponent, pin: wire.toPin, boardPin: wire.fromPin, purpose: wire.purpose }
    : { component: wire.fromComponent, pin: wire.fromPin, boardPin: wire.toPin, purpose: wire.purpose });
}

const REFERENCE_PREFIX: Record<string, string> = {
  resistor: "R", potentiometer: "RV", slide_potentiometer: "RV",
  led: "LED", rgb_led: "LED", neopixel: "LED", neopixel_matrix: "LED", neopixel_ring: "LED",
  buzzer: "BZ", servo: "M", stepper_motor: "M", external_dc_supply: "PS", servo_power_supply: "PS", pca9685: "DRV",
  pushbutton: "SW", pushbutton_6mm: "SW", slide_switch: "SW", tilt_switch: "SW", dip_switch_8: "SW",
  rotary_encoder: "ENC", rotary_dialer: "ENC",
};

export function componentDisplayName(component: ProjectSpec["components"][number]) {
  const raw = component.name.trim().replace(/_/g, "-");
  if (component.type === "resistor") {
    const value = raw.match(/^res(?:istor)?[- ]?(\d+(?:\.\d+)?)([kKmM]?)$/i);
    if (value) return `${value[1]}${value[2].toLowerCase()}Ω resistor`;
  }
  const compact = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  const typeCompact = (component.type || component.id).toLowerCase().replace(/[^a-z0-9]/g, "");
  return compact === typeCompact ? COMPONENTS[component.type || component.id]?.name || component.registry?.id || raw : raw;
}

type ComponentDisplayProject = { components: readonly ProjectSpec["components"][number][]; board?: BoardId; boardMeta?: BoardProfile };
type ConnectionDisplayProject = ComponentDisplayProject & { connections: readonly ProjectSpec["connections"][number][] };

export function componentReferences(project: ComponentDisplayProject) {
  const counts = new Map<string, number>();
  return project.components.map((component) => {
    const type = component.type || component.id;
    const prefix = REFERENCE_PREFIX[type] || "U";
    const number = (counts.get(prefix) || 0) + 1;
    counts.set(prefix, number);
    const ref = `${prefix}${number}`;
    const name = componentDisplayName(component);
    return { ...component, ref, name, label: `${ref} — ${name}` };
  });
}

export function projectOwnerLabels(project: ComponentDisplayProject) {
  const board = project.board || "esp32dev";
  const boardName = project.boardMeta?.name || board;
  return new Map<string, { ref: string; name: string; label: string }>([
    ["board", { ref: "MCU1", name: boardName, label: `MCU1 — ${boardName}` }],
    ...componentReferences(project).map((component) => [component.id, { ref: component.ref, name: component.name, label: component.label }] as const),
  ]);
}

export function billOfMaterials(project: ComponentDisplayProject) {
  const board = project.board || "esp32dev";
  const rows = componentReferences(project).map((item) => ({
    ref: item.ref,
    quantity: item.quantity,
    component: item.name,
    type: COMPONENTS[item.type || item.id]?.name || item.registry?.id || "Component",
    purpose: COMPONENTS[item.type || item.id]?.description || item.registry?.requirements?.[0] || "Project component",
    support: item.registry?.supportLevel || "validated",
  }));
  const grouped = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    const key = `${row.component}|${row.type}|${row.purpose}|${row.support}`;
    const existing = grouped.get(key);
    if (existing) grouped.set(key, { ...existing, ref: `${existing.ref}, ${row.ref}`, quantity: existing.quantity + row.quantity });
    else grouped.set(key, row);
  }
  const boardName = project.boardMeta?.name || board;
  return [{ ref: "MCU1", quantity: 1, component: boardName, type: board === "esp32cam" ? "Camera controller" : "Controller", purpose: board === "esp32cam" ? "Runs the firmware and captures images with its built-in OV2640" : "Runs the firmware and controls the circuit", support: "validated" }, ...grouped.values()];
}

export function assemblySteps(project: ConnectionDisplayProject) {
  const labels = projectOwnerLabels(project);
  const connections = project.connections.map((wire, index) => {
    const from = labels.get(wire.fromComponent)?.label || wire.fromComponent;
    const to = labels.get(wire.toComponent)?.label || wire.toComponent;
    return { wire: `W${String(index + 1).padStart(2, "0")}`, connectionIndex: index, text: `Connect ${from} pin ${wire.fromPin} to ${to} pin ${wire.toPin}.` };
  });
  return [
    { wire: "SAFE", connectionIndex: null, text: "Disconnect USB and all external power before changing any wiring." },
    ...connections,
    { wire: "CHECK", connectionIndex: null, text: "Inspect every power, ground, polarity, and resistor connection against the wiring schedule before applying power." },
    { wire: "CODE", connectionIndex: null, text: "Upload the firmware, then power the project and test the intended behavior." },
  ];
}

export function humanizeProjectText(text: string, project: ComponentDisplayProject) {
  return componentReferences(project).reduce((result, component) => result.replace(new RegExp(`\\b${component.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), `${component.ref} (${component.name})`), text);
}

export function pinAssignments(project: ConnectionDisplayProject) {
  const names = projectOwnerLabels(project);
  return project.connections.map((wire) => {
    const startsAtBoard = wire.fromComponent === "board";
    const component = startsAtBoard ? wire.toComponent : wire.fromComponent;
    const connectedTo = startsAtBoard ? wire.fromComponent : wire.toComponent;
    return {
      component: names.get(component)?.label || component,
      pin: startsAtBoard ? wire.toPin : wire.fromPin,
      connectedTo: names.get(connectedTo)?.label || connectedTo,
      connectedPin: startsAtBoard ? wire.fromPin : wire.toPin,
      purpose: wire.purpose.replace(/[_-]+/g, " "),
    };
  });
}

export function projectDiff(current: ProjectSpec, target: ProjectSpec) {
  const currentParts = new Map(current.components.map((part) => [part.id, part]));
  const targetParts = new Map(target.components.map((part) => [part.id, part]));
  const labels = (project: ProjectSpec) => projectOwnerLabels(project);
  const currentLabels = labels(current);
  const targetLabels = labels(target);
  const added = target.components.filter((part) => !currentParts.has(part.id)).map((part) => targetLabels.get(part.id)?.label || part.name);
  const removed = current.components.filter((part) => !targetParts.has(part.id)).map((part) => currentLabels.get(part.id)?.label || part.name);
  const changed = target.components.filter((part) => {
    const before = currentParts.get(part.id);
    return before && (before.type !== part.type || before.name !== part.name || before.quantity !== part.quantity);
  }).map((part) => targetLabels.get(part.id)?.label || part.name);
  if (current.board !== target.board) changed.unshift(`MCU1: ${current.boardMeta?.name || current.board} → ${target.boardMeta?.name || target.board}`);
  const connectionKey = (wire: ProjectSpec["connections"][number]) => [wire.fromComponent, wire.fromPin, wire.toComponent, wire.toPin, wire.purpose].join("|");
  const beforeWires = new Set(current.connections.map(connectionKey));
  const afterWires = new Set(target.connections.map(connectionKey));
  const wiringChanges = [...current.connections.filter((wire) => !afterWires.has(connectionKey(wire))), ...target.connections.filter((wire) => !beforeWires.has(connectionKey(wire)))].length;
  return { components: { added, removed, changed }, wiringChanges, firmwareChanged: current.files.mainCpp !== target.files.mainCpp || current.files.platformioIni !== target.files.platformioIni };
}

export function catalogForPrompt(query?: string) {
  const rows = COMPONENT_IDS.map((id) => ({ id, text: `${id}: ${COMPONENTS[id].name} — ${COMPONENTS[id].description}` }));
  if (!query) return rows.map((row) => row.text).join("\n");
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2);
  return rows.map((row) => ({ ...row, score: terms.filter((term) => row.text.toLowerCase().includes(term)).length }))
    .sort((a, b) => b.score - a.score).slice(0, 14).map((row) => row.text).join("\n");
}

export function catalogLimitationsForPrompt() {
  return Object.entries(WOKWI_ELEMENT_EXCLUSIONS).map(([tag, reason]) => `${tag}: ${reason}`).join("\n");
}

export function wireLane(index: number, total: number, start: number, end: number) {
  if (total <= 1) return (start + end) / 2;
  const padding = Math.min(72, Math.max(28, (end - start) * .2));
  return start + padding + index * ((end - start - padding * 2) / (total - 1));
}

export function schematicLayout(components: readonly { id: string; type?: string }[]) {
  const tops = components.reduce<number[]>((positions, component, index) => {
    const previous = components[index - 1];
    positions.push(index ? positions[index - 1] + ((previous?.type || previous?.id) === "stepper_motor" ? 300 : 150) : 28);
    return positions;
  }, []);
  const lastType = components.at(-1)?.type || components.at(-1)?.id;
  return { tops, height: Math.max(510, (tops.at(-1) || 28) + (lastType === "stepper_motor" ? 300 : 170)) };
}
