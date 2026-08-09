/** Client-safe board types and pin helpers (no node:fs). */

export type BoardId = string;

export type BoardProfile = {
  name: string;
  platformio: string;
  pins: readonly string[];
  signalPins: readonly string[];
  platform: string;
  family: string;
  logicVoltage: number;
  visual?: string;
  summary: string;
};

export type BoardCard = BoardProfile & {
  id: BoardId;
  aliases: string[];
  source: string;
};

const POWER_ALIASES: Record<string, readonly string[]> = {
  "3V3": ["3V3", "3.3V", "+3.3V"],
  "5V": ["5V", "+5V", "VBUS"],
  VIN: ["VIN", "VSYS", "5V", "+5V"],
  VSYS: ["VSYS", "VIN"],
  GND: ["GND", "GROUND", "0V"],
};

export function normalizeBoardPinForBoard(profile: BoardProfile, pin: unknown) {
  if (typeof pin !== "string") return pin;
  const compact = pin.trim().toUpperCase().replace(/[\s_-]+/g, "");
  for (const candidate of profile.pins) {
    if (candidate.toUpperCase().replace(/[\s_-]+/g, "") === compact) return candidate;
  }
  if (["5V", "+5V", "VBUS"].includes(compact)) {
    if (profile.pins.includes("5V")) return "5V";
    if (profile.pins.includes("VIN")) return "VIN";
    if (profile.pins.includes("VSYS")) return "VSYS";
  }
  if (["VIN", "VSYS"].includes(compact)) {
    if (profile.pins.includes("VIN")) return "VIN";
    if (profile.pins.includes("VSYS")) return "VSYS";
  }
  if (["3.3V", "+3.3V", "3V3", "+3V3"].includes(compact)) {
    if (profile.pins.includes("3V3")) return "3V3";
  }
  if (["GND", "GROUND", "0V"].includes(compact)) return "GND";
  const gpio = compact.match(/^(?:GPIO|IO)(\d+)$/);
  if (gpio && profile.family === "esp32") return `GPIO${gpio[1]}`;
  const digital = compact.match(/^D(\d+)$/);
  if (digital && profile.family === "arduino") return `D${digital[1]}`;
  const gp = compact.match(/^(?:GP|GPIO)(\d+)$/);
  if (gp && (profile.family === "pico" || profile.family === "raspberrypi")) {
    if (profile.family === "raspberrypi" && profile.pins.includes(`BCM${gp[1]}`)) return `BCM${gp[1]}`;
    return `GP${gp[1]}`;
  }
  const bcm = compact.match(/^BCM(\d+)$/);
  if (bcm && profile.pins.includes(`BCM${bcm[1]}`)) return `BCM${bcm[1]}`;
  return pin;
}

const LOGIC_POWER_PINS = new Set(["3V3", "3.3V", "+3.3V", "5V", "+5V", "VBUS", "VIN", "VSYS"]);

function isLogicPowerPin(pin: string) {
  return LOGIC_POWER_PINS.has(pin) || Boolean(POWER_ALIASES[pin] && pin !== "GND");
}

export function boardPinCompatible(profile: BoardProfile, allowed: readonly string[], boardPin: string) {
  if (!allowed.length) return false;
  if (allowed.includes(boardPin)) return true;
  for (const option of allowed) {
    const aliases = POWER_ALIASES[option] || [option];
    if (aliases.includes(boardPin)) return true;
    for (const [canonical, group] of Object.entries(POWER_ALIASES)) {
      if (group.includes(option) && group.includes(boardPin)) return true;
      if (option === canonical && group.includes(boardPin)) return true;
    }
  }
  // Signal pins: ESP GPIO allowlists remap to any signal pin on Arduino/Pico/etc.
  const allowlistIsEspGpio = allowed.some((pin) => pin.startsWith("GPIO"));
  if (profile.family !== "esp32" && allowlistIsEspGpio && profile.signalPins.includes(boardPin)) return true;
  // Power pins: "3V3" in catalog means low-voltage module power, not "ESP 3V3 header only".
  // Widen to other logic rails on this board. Do not widen 5V/VIN-only parts down to 3V3.
  const allowlistHas3V3 = allowed.some((pin) => pin === "3V3" || pin === "3.3V" || pin === "+3.3V");
  if (allowlistHas3V3 && isLogicPowerPin(boardPin) && profile.pins.includes(boardPin)) return true;
  return false;
}

export function isBoardSignalPin(profile: BoardProfile, pin: string) {
  return profile.signalPins.includes(pin);
}

export function isPowerOrGroundPin(pin: string) {
  return Boolean(POWER_ALIASES[pin] || Object.values(POWER_ALIASES).some((aliases) => aliases.includes(pin)));
}

export function toBoardProfile(card: BoardCard): BoardProfile {
  return {
    name: card.name,
    platformio: card.platformio,
    pins: card.pins,
    signalPins: card.signalPins,
    platform: card.platform,
    family: card.family,
    logicVoltage: card.logicVoltage,
    visual: card.visual,
    summary: card.summary,
  };
}
