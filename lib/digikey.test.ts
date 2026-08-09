import assert from "node:assert/strict";
import test from "node:test";
import { findDigiKeyPart, selectExactDigiKeyPart } from "./digikey.ts";

const parts = [{
  ManufacturerProductNumber: "BME680",
  Manufacturer: { Name: "Bosch Sensortec" },
  DatasheetUrl: "https://example.com/bme680.pdf",
  ProductVariations: [{ DigiKeyProductNumber: "828-1077-1-ND" }],
  OtherNames: ["BME680-SENSOR"],
  UnusedLargeCatalogField: { ignored: true },
}, {
  ManufacturerProductNumber: "BME688-BREAKOUT",
  DatasheetUrl: "https://example.com/bme688.pdf",
  ProductVariations: [],
}];

test("selects only an exact DigiKey or manufacturer part number", () => {
  assert.equal(selectExactDigiKeyPart("BME680", parts)?.Manufacturer?.Name, "Bosch Sensortec");
  assert.equal(selectExactDigiKeyPart("828-1077-1-ND", parts)?.ManufacturerProductNumber, "BME680");
  assert.equal(selectExactDigiKeyPart("BME680-SENSOR", parts)?.ManufacturerProductNumber, "BME680");
  assert.equal(selectExactDigiKeyPart("BME68", parts), undefined);
});

test("accepts DigiKey's protocol-relative official datasheet links", () => {
  assert.equal(selectExactDigiKeyPart("SEN0248", [{ ManufacturerProductNumber: "SEN0248", DatasheetUrl: "//mm.digikey.com/sen0248.pdf" }])?.ManufacturerProductNumber, "SEN0248");
});

test("authenticates once, searches Product Information V4, and keeps the secret out of search", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), init });
    if (String(input).endsWith("/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "access-token", expires_in: 599, token_type: "Bearer" }), { status: 200 });
    }
    return new Response(JSON.stringify({ Products: parts }), { status: 200 });
  }) as typeof fetch;
  const credentials = { clientId: "test-client", clientSecret: "secret-value" };
  const first = await findDigiKeyPart("BME680", fetcher, credentials);
  const second = await findDigiKeyPart("BME680", fetcher, credentials);

  assert.equal(first.part?.ManufacturerProductNumber, "BME680");
  assert.equal(second.part?.ManufacturerProductNumber, "BME680");
  assert.equal(requests.filter((request) => request.url.endsWith("/oauth2/token")).length, 1);
  assert.equal(requests.filter((request) => request.url.endsWith("/products/v4/search/keyword")).length, 2);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(String(requests[0]!.init?.body))), {
    client_id: "test-client", client_secret: "secret-value", grant_type: "client_credentials",
  });
  assert.equal(new Headers(requests[1]!.init?.headers).get("Authorization"), "Bearer access-token");
  assert.equal(new Headers(requests[1]!.init?.headers).get("X-DIGIKEY-Client-Id"), "test-client");
  assert.deepEqual(JSON.parse(String(requests[1]!.init?.body)), { Keywords: "BME680", Limit: 10, Offset: 0 });
  assert.doesNotMatch(String(requests[1]!.init?.body), /secret-value/);
  assert.equal("UnusedLargeCatalogField" in first.matches[0]!, false);
});

test("fails clearly without DigiKey credentials", async () => {
  const result = await findDigiKeyPart("BME680", fetch, { clientId: "", clientSecret: "" });
  assert.equal(result.part, null);
  assert.match(result.error, /DIGIKEY_CLIENT_ID.*DIGIKEY_CLIENT_SECRET/);
});

test("turns failed authentication and malformed catalog JSON into safe errors", async () => {
  const denied = (async () => new Response("unauthorized", { status: 401 })) as typeof fetch;
  const authResult = await findDigiKeyPart("BME680", denied, { clientId: "denied-client", clientSecret: "secret" });
  assert.match(authResult.error, /authentication failed with HTTP 401/);

  let calls = 0;
  const malformed = (async () => {
    calls += 1;
    return calls === 1
      ? new Response(JSON.stringify({ access_token: "token", expires_in: 599 }), { status: 200 })
      : new Response("", { status: 200 });
  }) as typeof fetch;
  const searchResult = await findDigiKeyPart("BME680", malformed, { clientId: "malformed-client", clientSecret: "secret" });
  assert.match(searchResult.error, /unreadable search response/);
});
