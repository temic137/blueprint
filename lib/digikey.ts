import { z } from "zod";
import { ingestDatasheet } from "./datasheet-registry.ts";

const DigiKeyPartSchema = z.object({
  ManufacturerProductNumber: z.string().nullish(),
  Manufacturer: z.object({ Name: z.string().nullish() }).nullish(),
  DatasheetUrl: z.string().nullish(),
  ProductUrl: z.string().nullish(),
  OtherNames: z.array(z.string()).nullish(),
  Description: z.object({ ProductDescription: z.string().nullish(), DetailedDescription: z.string().nullish() }).nullish(),
  ProductVariations: z.array(z.object({ DigiKeyProductNumber: z.string().nullish() })).nullish(),
});

const SearchResponseSchema = z.object({ Products: z.array(DigiKeyPartSchema).nullish() }).passthrough();
const TokenResponseSchema = z.object({ access_token: z.string().min(1), expires_in: z.coerce.number().positive() }).passthrough();

export type DigiKeyPart = z.infer<typeof DigiKeyPartSchema>;
export type DigiKeyCredentials = { clientId: string; clientSecret: string };

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function identity(value: unknown) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

async function json(response: Response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return null; }
}

export function digiKeyCredentials(): DigiKeyCredentials {
  return {
    clientId: (process.env.DIGIKEY_CLIENT_ID || "").trim(),
    clientSecret: (process.env.DIGIKEY_CLIENT_SECRET || "").trim(),
  };
}

export function hasDigiKeyCredentials(credentials = digiKeyCredentials()) {
  return Boolean(credentials.clientId && credentials.clientSecret);
}

export function selectExactDigiKeyPart(query: string, parts: DigiKeyPart[]) {
  const needle = identity(query);
  return parts.find((part) => {
    const numbers = [part.ManufacturerProductNumber, ...(part.ProductVariations || []).map((variation) => variation.DigiKeyProductNumber), ...(part.OtherNames || [])];
    return numbers.some((value) => identity(value) === needle) && /^(?:https?:)?\/\//i.test(part.DatasheetUrl || "");
  });
}

async function accessToken(fetcher: typeof fetch, credentials: DigiKeyCredentials) {
  const cached = tokenCache.get(credentials.clientId);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

  const response = await fetcher("https://api.digikey.com/v1/oauth2/token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: credentials.clientId, client_secret: credentials.clientSecret, grant_type: "client_credentials" }),
    signal: AbortSignal.timeout(10_000),
  });
  const parsed = TokenResponseSchema.safeParse(await json(response));
  if (!response.ok || !parsed.success) throw new Error(`DigiKey authentication failed with HTTP ${response.status}. Check the client ID, client secret, and API subscription.`);
  tokenCache.set(credentials.clientId, { token: parsed.data.access_token, expiresAt: Date.now() + parsed.data.expires_in * 1000 });
  return parsed.data.access_token;
}

export async function findDigiKeyPart(query: string, fetcher: typeof fetch = fetch, credentials = digiKeyCredentials()) {
  if (!hasDigiKeyCredentials(credentials)) {
    return { part: null, matches: [] as DigiKeyPart[], error: "DigiKey discovery is not configured. Add DIGIKEY_CLIENT_ID and DIGIKEY_CLIENT_SECRET to .env." };
  }
  try {
    const token = await accessToken(fetcher, credentials);
    const response = await fetcher("https://api.digikey.com/products/v4/search/keyword", {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-DIGIKEY-Client-Id": credentials.clientId,
        "X-DIGIKEY-Locale-Site": "US",
        "X-DIGIKEY-Locale-Language": "en",
        "X-DIGIKEY-Locale-Currency": "USD",
      },
      body: JSON.stringify({ Keywords: query.slice(0, 100), Limit: 10, Offset: 0 }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return { part: null, matches: [] as DigiKeyPart[], error: `DigiKey search failed with HTTP ${response.status}.` };
    const parsed = SearchResponseSchema.safeParse(await json(response));
    if (!parsed.success) return { part: null, matches: [] as DigiKeyPart[], error: "DigiKey returned an unreadable search response." };
    const matches = parsed.data.Products || [];
    return { part: selectExactDigiKeyPart(query, matches) || null, matches, error: "" };
  } catch (error) {
    return { part: null, matches: [] as DigiKeyPart[], error: error instanceof Error ? error.message : "DigiKey lookup failed." };
  }
}

export async function discoverAndIngestDigiKeyPart(query: string, deadlineAt?: number) {
  const found = await findDigiKeyPart(query);
  if (!found.part) return { record: null, alternatives: found.matches.slice(0, 5), error: found.error || `DigiKey found no exact datasheet-backed match for ${query}.` };
  const url = new URL(found.part.DatasheetUrl!, "https://www.digikey.com");
  url.protocol = "https:";
  return ingestDatasheet(url.toString(), found.part.ManufacturerProductNumber || query, deadlineAt);
}
