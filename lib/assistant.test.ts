import assert from "node:assert/strict";
import test from "node:test";
import { interpretAssistantMessage } from "./assistant.ts";
import type { AssistantMessage } from "./db.ts";
import type { ProjectSpec } from "./project.ts";

const project = {
  title: "Hands-free doorbell", summary: "A PIR sensor triggers a buzzer and status LED.", board: "esp32dev",
  components: [
    { id: "pir", type: "pir_sensor", name: "PIR Motion Sensor", quantity: 1 },
    { id: "buzzer", type: "buzzer", name: "Doorbell Buzzer", quantity: 1 },
    { id: "led", type: "led", name: "Status LED", quantity: 1 },
  ],
  connections: [
    { fromComponent: "board", fromPin: "GPIO4", toComponent: "pir", toPin: "OUT", color: "#3b82f6", purpose: "motion input" },
    { fromComponent: "board", fromPin: "GPIO13", toComponent: "buzzer", toPin: "POS", color: "#f59e0b", purpose: "doorbell output" },
  ],
  parts: ["ESP32", "PIR sensor", "Buzzer", "LED"], instructions: ["Disconnect power.", "Connect the sensor.", "Upload firmware."], pins: [],
  files: { platformioIni: "[env:esp32dev]\nplatform=espressif32\nboard=esp32dev\nframework=arduino", mainCpp: "void setup() {}\nvoid loop() { /* ring on motion */ }" },
} as ProjectSpec;

const proposalHistory: AssistantMessage[] = [
  { id: "1", role: "user", kind: "message", content: "Can the trigger distance be adjustable?", metadata: null, createdAt: "2026-01-01" },
  { id: "2", role: "assistant", kind: "answer", content: "Replacing the PIR with an HC-SR04 would provide a configurable distance threshold. Its 5 V ECHO output needs a two-resistor voltage divider for the ESP32, while the buzzer and LED can remain.", metadata: null, createdAt: "2026-01-01" },
];

test("supplies the complete project and conversation to semantic intent resolution", async () => {
  let suppliedContext = "";
  const fakeComplete = async (_stage: unknown, messages: Array<{ content: string }>) => {
    suppliedContext = messages.map((item) => item.content).join("\n");
    return { intent: "answer", reply: "The PIR currently provides the motion input on GPIO4, which triggers the buzzer and status LED." };
  };
  const result = await interpretAssistantMessage(project, "Create a hands-free doorbell", "What currently triggers it?", proposalHistory, fakeComplete as never);
  assert.equal(result.intent, "answer");
  assert.match(suppliedContext, /GPIO4/);
  assert.match(suppliedContext, /two-resistor voltage divider/);
  assert.match(suppliedContext, /whole conversation, not from keywords or fixed phrases/);
  assert.match(suppliedContext, /endpoint-to-endpoint connections/);
  assert.match(suppliedContext, /Do not ask them to choose GPIO pins/);
  assert.match(suppliedContext, /choose the best sensible default/);
});

test("keeps ordinary chat context compact and excludes previous failures", async () => {
  let suppliedContext = "";
  let suppliedMaxTokens = 0;
  const history: AssistantMessage[] = Array.from({ length: 12 }, (_, index) => ({
    id: `compact-${index}`,
    role: index === 10 ? "assistant" as const : index === 11 || index % 2 === 0 ? "user" as const : "assistant" as const,
    kind: index === 10 ? "error" : index === 11 || index % 2 === 0 ? "message" : "answer",
    content: index === 10 ? "Groq is temporarily rate-limited." : index === 11 ? "Which board would you recommend?" : `Conversation item ${index}`,
    metadata: index === 9 ? { debugMarker: "large-preview-metadata-must-not-be-sent" } : null,
    createdAt: "2026-01-01",
  }));
  await interpretAssistantMessage(project, "Create a hands-free doorbell", "Which board would you recommend?", history, (async (_stage: unknown, messages: Array<{ content: string }>, maxTokens: number) => {
    suppliedContext = messages.map((item) => item.content).join("\n");
    suppliedMaxTokens = maxTokens;
    return { intent: "answer", reply: "Use the ESP32 when wireless connectivity matters; otherwise the simpler board is sufficient." };
  }) as never);
  assert.equal(suppliedMaxTokens, 600);
  assert.doesNotMatch(suppliedContext, /temporarily rate-limited/);
  assert.doesNotMatch(suppliedContext, /Conversation item 0/);
  assert.match(suppliedContext, /Conversation item 9/);
  assert.equal(suppliedContext.match(/Which board would you recommend\?/g)?.length, 1);
  assert.doesNotMatch(suppliedContext, /large-preview-metadata-must-not-be-sent/);
  assert.match(suppliedContext, /Not loaded because this question does not require component discovery/);
  assert.doesNotMatch(suppliedContext, /Disconnect power/);
});

test("turns approval of a camera-board proposal into a standalone migration", async () => {
  const history: AssistantMessage[] = [
    { id: "camera-1", role: "user", kind: "message", content: "The motion-tracking camera has no camera.", metadata: null, createdAt: "2026-01-01" },
    { id: "camera-2", role: "assistant", kind: "answer", content: "The straightforward fix is to replace the ESP32 DevKit with an ESP32-CAM and reassign the PIR and servo to camera-safe pins.", metadata: null, createdAt: "2026-01-01" },
  ];
  const result = await interpretAssistantMessage(project, "Build a motion-tracking camera", "Yes, I am open to it.", history, (async () => ({ intent: "change", reply: "I’ll prepare the complete controller migration.", changeRequest: "Replace the ESP32 DevKit V1 with an AI Thinker ESP32-CAM using its built-in OV2640 camera. Preserve motion detection and servo tracking behavior, and reassign all external signals to safe ESP32-CAM pins without asking the user to choose pins." })) as never);
  assert.equal(result.intent, "change");
  assert.match(result.changeRequest, /reassign all external signals/);
});

test("accepts a context-resolved change without requiring a magic confirmation phrase", async () => {
  const fakeComplete = async () => ({
    intent: "change",
    reply: "I’ll prepare that as a validated preview before anything is applied.",
    changeRequest: "Replace the existing PIR Motion Sensor with an HC-SR04 ultrasonic distance sensor. Add the required two-resistor voltage divider on ECHO for ESP32 input safety, make the trigger distance configurable in firmware, and preserve the existing buzzer and status LED behavior.",
  });
  const result = await interpretAssistantMessage(project, "Create a hands-free doorbell", "That approach fits what I had in mind—use it here.", proposalHistory, fakeComplete as never);
  assert.equal(result.intent, "change");
  assert.match(result.changeRequest, /HC-SR04/);
  assert.match(result.changeRequest, /preserve the existing buzzer and status LED/);
});

test("allows rejection, questions, and ambiguity to remain non-mutating", async () => {
  const cases = [
    { message: "On second thought, leave the sensor as it is.", output: { intent: "answer", reply: "Understood. I will leave the PIR sensor and the current project unchanged." } },
    { message: "Before deciding, how would that affect the wiring?", output: { intent: "answer", reply: "It would add TRIG and ECHO signal wiring plus a voltage divider on ECHO; nothing has been changed." } },
    { message: "I want it improved.", output: { intent: "clarify", reply: "Which result should improve: detection distance, false-trigger resistance, sound, or power use?" } },
  ] as const;
  for (const item of cases) {
    const result = await interpretAssistantMessage(project, "Create a hands-free doorbell", item.message, proposalHistory, (async () => item.output) as never);
    assert.equal(result.intent, item.output.intent);
    assert.notEqual(result.intent, "change");
  }
});

test("retries malformed provider output", async () => {
  let calls = 0;
  const fakeComplete = async () => {
    calls++;
    if (calls === 1) throw new Error("Model returned invalid JSON");
    return { intent: "answer", reply: "The ESP32 reads the project sensor and controls the buzzer and status LED." };
  };
  const result = await interpretAssistantMessage(project, "Create a hands-free doorbell", "What does the ESP32 do?", [], fakeComplete as never);
  assert.equal(calls, 2);
  assert.equal(result.intent, "answer");
});

test("rejects obsolete full-architecture assistant responses and retries compactly", async () => {
  let calls = 0;
  const fakeComplete = async () => {
    calls++;
    if (calls === 1) return { intent: "change", reply: "I changed it.", changeRequest: "Replace the sensor safely.", components: [] };
    return { intent: "clarify", reply: "Which replacement sensor do you want to use?" };
  };
  const result = await interpretAssistantMessage(project, "Create a hands-free doorbell", "Replace the sensor.", [], fakeComplete as never);
  assert.equal(calls, 2);
  assert.equal(result.intent, "clarify");
});

test("supplies a structured pending decision when resolving a short follow-up", async () => {
  let supplied = "";
  const history: AssistantMessage[] = [{
    id: "pending-1", role: "assistant", kind: "clarify", content: "Should both servos move together or independently?",
    metadata: { pendingDecision: { originalRequest: "Add a forearm servo", question: "Should both servos move together or independently?", source: "assistant" } }, createdAt: "2026-01-01",
  }];
  const result = await interpretAssistantMessage(project, "Build a moving hand", "Use the sensible default.", history, (async (_stage: unknown, messages: Array<{ content: string }>) => {
    supplied = messages.map((item) => item.content).join("\n");
    return { intent: "change", reply: "I’ll prepare the additional servo with independent control.", changeRequest: "Add one SG90 servo for the forearm with independently controlled movement; preserve the existing project and let Blueprint select safe wiring and pins." };
  }) as never);
  assert.equal(result.intent, "change");
  assert.match(supplied, /Pending decision to resolve/);
  assert.match(supplied, /Add a forearm servo/);
});

test("normalizes a structured change request instead of rejecting the model response", async () => {
  const result = await interpretAssistantMessage(project, "Create a hands-free doorbell", "Use that approach.", proposalHistory, (async () => ({
    intent: "change",
    reply: "I’ll prepare the sensor replacement.",
    change_request: {
      request: "Replace the PIR with an HC-SR04 ultrasonic sensor and trigger the buzzer at 5 inches.",
    },
  })) as never);
  assert.equal(result.intent, "change");
  assert.match(result.changeRequest, /HC-SR04/);
  assert.match(result.changeRequest, /5 inches/);
});

test("recovers an authorized change from pending context when changeRequest is malformed", async () => {
  const history: AssistantMessage[] = [
    { id: "1", role: "user", kind: "message", content: "Can we replace the PIR with an ultrasonic sensor and detect at 5 inches?", metadata: null, createdAt: "2026-01-01" },
    {
      id: "2", role: "assistant", kind: "clarify", content: "Should the buzzer trigger when an object reaches 5 inches?",
      metadata: { pendingDecision: { originalRequest: "Replace the PIR sensor with an HC-SR04 ultrasonic sensor and trigger at 5 inches.", question: "Should it trigger at the threshold?", source: "assistant" } },
      createdAt: "2026-01-01",
    },
    { id: "3", role: "user", kind: "message", content: "Yes, trigger the doorbell when an object reaches 5 inches.", metadata: null, createdAt: "2026-01-01" },
    { id: "4", role: "assistant", kind: "answer", content: "The HC-SR04 can replace the PIR while the existing buzzer remains.", metadata: null, createdAt: "2026-01-01" },
  ];
  const result = await interpretAssistantMessage(project, "Create a hands-free doorbell", "Yes, go ahead and do that.", history, (async () => ({
    intent: "change",
    reply: "I’ll prepare that replacement.",
    changeRequest: null,
  })) as never);
  assert.equal(result.intent, "change");
  assert.match(result.changeRequest, /Replace the PIR sensor with an HC-SR04/);
  assert.match(result.changeRequest, /trigger the doorbell when an object reaches 5 inches/);
  assert.match(result.changeRequest, /Preserve every current project behavior/);
});

test("turns a model's deferred action promise into the pending project change", async () => {
  const history: AssistantMessage[] = [{
    id: "pending-ultrasonic",
    role: "assistant",
    kind: "clarify",
    content: "Should the doorbell trigger when an object reaches 5 inches?",
    metadata: {
      pendingDecision: {
        originalRequest: "Replace the PIR sensor with an HC-SR04 ultrasonic sensor and trigger the doorbell at 5 inches.",
        question: "Should it trigger at the threshold?",
        source: "assistant",
      },
    },
    createdAt: "2026-01-01",
  }];
  let calls = 0;
  const result = await interpretAssistantMessage(project, "Create a hands-free doorbell", "Build the agreed replacement now.", history, (async () => {
    calls++;
    return { intent: "answer", reply: "I will build the validated preview for the agreed sensor replacement now." };
  }) as never);
  assert.equal(calls, 1);
  assert.equal(result.intent, "change");
  assert.match(result.changeRequest, /HC-SR04/);
  assert.match(result.changeRequest, /5 inches/);
});

test("omits full firmware from ordinary chat context but includes it for code questions", async () => {
  const contexts: string[] = [];
  const complete = async (_stage: unknown, messages: Array<{ content: string }>) => {
    contexts.push(messages.at(-1)?.content || "");
    return { intent: "answer", reply: "The stored project context supports this answer without changing anything." };
  };
  await interpretAssistantMessage(project, "Create a doorbell", "What sensor does this use?", [], complete as never);
  await interpretAssistantMessage(project, "Create a doorbell", "What does the firmware code do?", [], complete as never);
  assert.doesNotMatch(contexts[0], /ring on motion/);
  assert.match(contexts[1], /ring on motion/);
});
