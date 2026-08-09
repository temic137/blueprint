import { boardPinCompatible, isPowerOrGroundPin } from "./board-types.ts";
import { BOARD_PROFILES } from "./boards.ts";
import { COMPONENTS, type ProjectSpec } from "./project.ts";

type Architecture = Pick<ProjectSpec, "board" | "components"> & { boardMeta?: ProjectSpec["boardMeta"] };
type Connection = ProjectSpec["connections"][number];

const COLORS = { power: "#ef4444", ground: "#111827", signal: ["#f59e0b", "#3b82f6", "#8b5cf6", "#14b8a6"] } as const;
const INPUT_ONLY = new Set(["GPIO34", "GPIO35", "GPIO36", "GPIO39"]);
const ESP_ADC = ["GPIO34", "GPIO35", "GPIO36", "GPIO39", "GPIO32", "GPIO33"];

export function synthesizeCircuit(architecture: Architecture, required: Connection[] = []) {
  const components = new Map(architecture.components.map((component) => [component.id, component]));
  const connections: Connection[] = [];
  const terminals = new Set<string>();
  const usedSignals = new Set<string>();
  let colorIndex = 0;
  const key = (owner: string, pin: string) => `${owner}.${pin}`;
  const hasTerminal = (owner: string, pin: string) => terminals.has(key(owner, pin));
  const markBoardPin = (owner: string, pin: string) => {
    if (owner === "board" && !isPowerOrGroundPin(pin)) usedSignals.add(pin);
  };
  const add = (fromComponent: string, fromPin: string, toComponent: string, toPin: string, purpose: string, color?: string) => {
    const signature = [key(fromComponent, fromPin), key(toComponent, toPin)].sort().join("--");
    if (connections.some((wire) => [key(wire.fromComponent, wire.fromPin), key(wire.toComponent, wire.toPin)].sort().join("--") === signature)) return;
    connections.push({ fromComponent, fromPin, toComponent, toPin, purpose, color: color || COLORS.signal[colorIndex++ % COLORS.signal.length]! });
    if (fromComponent !== "board") terminals.add(key(fromComponent, fromPin));
    if (toComponent !== "board") terminals.add(key(toComponent, toPin));
    markBoardPin(fromComponent, fromPin);
    markBoardPin(toComponent, toPin);
  };
  for (const wire of required) if ((wire.fromComponent === "board" || components.has(wire.fromComponent)) && (wire.toComponent === "board" || components.has(wire.toComponent))) {
    add(wire.fromComponent, wire.fromPin, wire.toComponent, wire.toPin, wire.purpose, wire.color);
  }

  const profile = architecture.boardMeta || BOARD_PROFILES[architecture.board];
  if (!profile) throw new Error(`Unknown board card: ${architecture.board}`);
  const boardPins = profile.pins;
  const signalPins = profile.signalPins.length ? profile.signalPins : boardPins.filter((pin) => !isPowerOrGroundPin(pin));
  const resolveChoices = (choices: readonly string[]) => {
    const exact = choices.filter((pin) => boardPins.includes(pin));
    if (exact.length) return exact;
    // Catalog still lists ESP GPIO / power families — map onto whatever this board actually has.
    return boardPins.filter((pin) => boardPinCompatible(profile, choices, pin));
  };
  const claim = (choices: readonly string[], shared = false) => {
    const available = resolveChoices(choices);
    const pin = available.find((candidate) => shared || isPowerOrGroundPin(candidate) || !usedSignals.has(candidate));
    if (!pin) {
      throw new Error(`${profile.name} has no free terminal from ${choices.join("/")}; already assigned: ${[...usedSignals].join(", ") || "none"}. The selected component set exceeds the board's I/O capacity.`);
    }
    if (!shared && !isPowerOrGroundPin(pin)) usedSignals.add(pin);
    return pin;
  };
  const outputPins = signalPins.filter((pin) => !INPUT_ONLY.has(pin));
  const inputPins = [...signalPins];
  const adcPins = profile.family === "arduino"
    ? signalPins.filter((pin) => /^A\d+$/i.test(pin))
    : ESP_ADC.filter((pin) => boardPins.includes(pin));
  const ADC = adcPins.length ? adcPins : outputPins;
  const connectBoard = (component: string, pin: string, choices: readonly string[], purpose: string, shared = false) => {
    if (hasTerminal(component, pin)) return;
    const boardPin = claim(choices, shared);
    const powerColor = boardPin === "GND" ? COLORS.ground : isPowerOrGroundPin(boardPin) ? COLORS.power : undefined;
    add("board", boardPin, component, pin, purpose, powerColor);
  };
  const typeOf = (id: string) => components.get(id)?.type || components.get(id)?.registry?.id || id;
  const idsOf = (...types: string[]) => architecture.components.filter((component) => types.includes(typeOf(component.id))).map((component) => component.id);
  const processed = new Set<string>();

  const resistors = idsOf("resistor");
  let resistorIndex = 0;
  const takeResistor = () => {
    const resistor = resistors[resistorIndex++];
    if (!resistor) throw new Error("The selected circuit needs another resistor component.");
    processed.add(resistor);
    return resistor;
  };

  for (const led of idsOf("led")) {
    const resistor = takeResistor();
    const gpio = claim(outputPins);
    add("board", gpio, resistor, "1", "LED control");
    add(resistor, "2", led, "A", "LED series resistor");
    add(led, "C", "board", "GND", "LED ground", COLORS.ground);
    processed.add(led);
  }
  for (const led of idsOf("rgb_led")) {
    for (const channel of ["R", "G", "B"]) {
      const resistor = takeResistor();
      add("board", claim(outputPins), resistor, "1", channel + " LED control");
      add(resistor, "2", led, channel, channel + " LED series resistor");
    }
    add(led, "COM", "board", "GND", "RGB LED common ground", COLORS.ground);
    processed.add(led);
  }

  for (const sensor of idsOf("hc_sr04")) {
    const upper = takeResistor();
    const lower = takeResistor();
    connectBoard(sensor, "VCC", ["VIN", "5V"], "ultrasonic sensor power");
    connectBoard(sensor, "GND", ["GND"], "ultrasonic sensor ground", true);
    connectBoard(sensor, "TRIG", outputPins, "ultrasonic trigger output");
    add(sensor, "ECHO", upper, "1", "echo voltage divider input");
    add(upper, "2", "board", claim(ADC), "divided echo input");
    add(upper, "2", lower, "1", "echo divider junction");
    add(lower, "2", "board", "GND", "echo divider ground", COLORS.ground);
    processed.add(sensor);
  }

  const motors = idsOf("stepper_motor");
  const drivers = idsOf("a4988");
  const supplies = idsOf("external_dc_supply");
  motors.forEach((motor, index) => {
    const driver = drivers[index];
    const supply = supplies[index] || supplies[0];
    if (!driver || !supply) throw new Error("Every stepper motor needs an A4988 and external motor supply.");
    connectBoard(driver, "VDD", ["3V3", "5V"], "driver logic power");
    connectBoard(driver, "GND", ["GND"], "shared driver ground", true);
    connectBoard(driver, "STEP", outputPins, "step control");
    connectBoard(driver, "DIR", outputPins, "direction control");
    add("board", "GND", driver, "EN", "driver enabled", COLORS.ground);
    add(supply, "POS", driver, "VMOT", "external motor power", COLORS.power);
    add(supply, "NEG", "board", "GND", "external supply shared ground", COLORS.ground);
    for (const [driverPin, motorPin] of [["1A", "A+"], ["1B", "A-"], ["2A", "B+"], ["2B", "B-"]] as const) add(driver, driverPin, motor, motorPin, "stepper coil");
    processed.add(motor); processed.add(driver); processed.add(supply);
  });

  const amplifiers = idsOf("pam8403_module");
  const speakers = idsOf("speaker_4ohm");
  const connectors = idsOf("jst_xh_2pin");
  amplifiers.forEach((amplifier, amplifierIndex) => {
    connectBoard(amplifier, "VCC", ["VIN", "5V"], "amplifier 5V power");
    connectBoard(amplifier, "GND", ["GND"], "amplifier shared ground", true);
    connectBoard(amplifier, "LIN", ["GPIO25", ...outputPins], "left DAC audio");
    connectBoard(amplifier, "RIN", ["GPIO26", ...outputPins], "right DAC audio");
    ["L", "R"].forEach((channel, channelIndex) => {
      const speaker = speakers[amplifierIndex * 2 + channelIndex];
      if (!speaker) return;
      const connector = connectors[amplifierIndex * 2 + channelIndex];
      if (connector) {
        add(amplifier, channel + "OUT+", connector, "1A", channel + " speaker positive to connector");
        add(connector, "1B", speaker, "POS", channel + " speaker positive");
        add(amplifier, channel + "OUT-", connector, "2A", channel + " speaker negative to connector");
        add(connector, "2B", speaker, "NEG", channel + " speaker negative");
        processed.add(connector);
      } else {
        add(amplifier, channel + "OUT+", speaker, "POS", channel + " speaker positive");
        add(amplifier, channel + "OUT-", speaker, "NEG", channel + " speaker negative");
      }
      processed.add(speaker);
    });
    processed.add(amplifier);
  });
  if (speakers.some((speaker) => !processed.has(speaker))) throw new Error("A passive speaker requires a compatible amplifier output.");

  const servoDrivers = idsOf("pca9685");
  const servos = idsOf("servo");
  const servoSupplies = idsOf("servo_power_supply");
  if (servoDrivers.length) {
    const driver = servoDrivers[0]!;
    const supply = servoSupplies[0];
    if (!supply) throw new Error("PCA9685 servo expansion requires a regulated 5V servo power supply.");
    connectBoard(driver, "VCC", ["3V3", "5V"], "PCA9685 logic power");
    connectBoard(driver, "GND", ["GND"], "PCA9685 shared ground", true);
    connectBoard(driver, "SDA", architecture.board === "esp32cam" ? ["GPIO13", ...outputPins] : ["GPIO21", ...outputPins], "I2C data", true);
    connectBoard(driver, "SCL", architecture.board === "esp32cam" ? ["GPIO14", ...outputPins] : ["GPIO22", ...outputPins], "I2C clock", true);
    add(supply, "NEG", "board", "GND", "servo supply shared ground", COLORS.ground);
    add(supply, "POS", driver, "V+", "regulated 5V servo rail", COLORS.power);
    servos.forEach((servo, index) => {
      if (index >= 8) throw new Error("Blueprint currently models eight PCA9685 servo channels.");
      add(driver, "CH" + index, servo, "PWM", "servo " + (index + 1) + " PWM channel");
      add(driver, "V+", servo, "VCC", "servo " + (index + 1) + " regulated 5V power", COLORS.power);
      add("board", "GND", servo, "GND", "servo " + (index + 1) + " shared ground", COLORS.ground);
      processed.add(servo);
    });
    processed.add(driver);
    processed.add(supply);
  }

  // Parallel character LCDs: wire the control/data bus; leave VO (contrast) for a trim pot off-netlist.
  for (const display of [...idsOf("lcd1602"), ...idsOf("lcd2004")]) {
    connectBoard(display, "VDD", ["5V", "VIN", "3V3"], "LCD logic power");
    connectBoard(display, "VSS", ["GND"], "LCD ground", true);
    add(display, "RW", "board", "GND", "LCD write-only", COLORS.ground);
    connectBoard(display, "RS", outputPins, "LCD register select");
    connectBoard(display, "E", outputPins, "LCD enable");
    for (const pin of ["D4", "D5", "D6", "D7"]) connectBoard(display, pin, outputPins, `LCD ${pin}`);
    if ((COMPONENTS[typeOf(display)]?.pins || []).includes("A")) connectBoard(display, "A", ["5V", "VIN", "3V3"], "LCD backlight anode");
    if ((COMPONENTS[typeOf(display)]?.pins || []).includes("K")) connectBoard(display, "K", ["GND"], "LCD backlight cathode", true);
    processed.add(display);
  }

  const analogSensorTypes = new Set(["ntc", "heartbeat", "generic_analog_sensor"]);
  const mixedSensorTypes = new Set(["photoresistor", "flame_sensor", "gas_sensor", "sound_sensor", "small_sound_sensor"]);
  const inputTypes = new Set(["dht22", "pir", "tilt_switch", "ir_receiver", "generic_digital_sensor", ...analogSensorTypes, ...mixedSensorTypes]);
  const powerPins = new Set(["VCC", "VDD"]);
  const groundPins = new Set(["GND", "VSS", "VSS.1", "VSS.2"]);
  for (const component of architecture.components) {
    if (processed.has(component.id)) continue;
    const type = typeOf(component.id);
    const definition = COMPONENTS[component.type || component.id];
    const pins = definition?.pins || component.registry?.pins || [];
    const constraints = definition?.boardPins || component.registry?.boardPins || {};
    if (type === "pushbutton" || type === "pushbutton_6mm") {
      const [first, second] = type === "pushbutton" ? ["1", "2"] : ["1.l", "2.l"];
      add("board", claim(inputPins), component.id, first, "button input");
      add(component.id, second, "board", "GND", "button ground", COLORS.ground);
      continue;
    }
    if (type === "slide_switch") {
      add("board", claim(inputPins), component.id, "2", "switch input");
      add("board", claim(["3V3", "5V"]), component.id, "1", "switch high", COLORS.power);
      add(component.id, "3", "board", "GND", "switch low", COLORS.ground);
      continue;
    }
    if (type === "potentiometer" || type === "slide_potentiometer") {
      connectBoard(component.id, "VCC", ["3V3", "5V"], "control power");
      connectBoard(component.id, "GND", ["GND"], "control ground", true);
      connectBoard(component.id, "SIG", ADC, "analog control input");
      continue;
    }
    if (type === "rotary_encoder") {
      connectBoard(component.id, "VCC", ["3V3", "5V"], "encoder power"); connectBoard(component.id, "GND", ["GND"], "encoder ground", true);
      for (const pin of ["CLK", "DT", "SW"]) connectBoard(component.id, pin, inputPins, `encoder ${pin.toLowerCase()} input`);
      continue;
    }
    if (type === "joystick") {
      connectBoard(component.id, "VCC", ["3V3", "5V"], "joystick power"); connectBoard(component.id, "GND", ["GND"], "joystick ground", true);
      connectBoard(component.id, "VERT", ADC, "vertical analog input"); connectBoard(component.id, "HORZ", ADC, "horizontal analog input"); connectBoard(component.id, "SEL", inputPins, "joystick button input");
      continue;
    }
    for (const pin of pins) {
      if (hasTerminal(component.id, pin)) continue;
      const allowed = constraints[pin];
      if (allowed) {
        if (!allowed.length) continue;
        const preferred = pin === "SDA" ? ["GPIO21", "A4", ...allowed, ...outputPins] : pin === "SCL" ? ["GPIO22", "A5", ...allowed, ...outputPins] : allowed;
        connectBoard(component.id, pin, preferred, /SDA|SCL/.test(pin) ? `I2C ${pin.toLowerCase()}` : `${component.name} ${pin.toLowerCase()}`, /SDA|SCL|GND|VCC|VDD/.test(pin));
        continue;
      }
      if (powerPins.has(pin) || pin === "5V") connectBoard(component.id, pin, [pin === "5V" ? "VIN" : "5V", "VIN", "3V3"], `${component.name} power`);
      else if (groundPins.has(pin)) connectBoard(component.id, pin, ["GND"], `${component.name} ground`, true);
      else if (pin === "SDA") connectBoard(component.id, pin, ["GPIO21", "A4", ...outputPins], "I2C data", true);
      else if (pin === "SCL") connectBoard(component.id, pin, ["GPIO22", "A5", ...outputPins], "I2C clock", true);
      else if ((mixedSensorTypes.has(type) && pin === "AO") || (analogSensorTypes.has(type) && pin === "OUT")) connectBoard(component.id, pin, ADC, `${component.name} analog input`);
      else if (mixedSensorTypes.has(type) && pin === "DOUT") continue;
      else if (["DOUT", "INT", "SQW", "VO", "V0"].includes(pin)) continue;
      else if (pin === "MISO" || inputTypes.has(type) || pin === "TX") connectBoard(component.id, pin, inputPins, `${component.name} input signal`);
      else connectBoard(component.id, pin, outputPins, `${component.name} output signal`);
    }
  }
  const unconnected = architecture.components.filter((component) => !connections.some((wire) => wire.fromComponent === component.id || wire.toComponent === component.id));
  if (unconnected.length) throw new Error(`No deterministic topology is available for: ${unconnected.map((component) => component.name).join(", ")}.`);
  return {
    connections,
    instructions: [
      "Disconnect USB and all external power before wiring.",
      "Connect the power and ground terminals exactly as shown in the validated wiring schedule.",
      "Connect each signal and load terminal to its assigned endpoint without substituting pins.",
      "Inspect polarity, shared grounds, and every passive or driver connection before applying power.",
      "Upload the generated firmware, then power the circuit and test its intended behavior.",
    ],
  };
}
