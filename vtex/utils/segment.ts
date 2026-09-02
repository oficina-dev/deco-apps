import { setCookie } from "std/http/mod.ts";
import { AppContext } from "../mod.ts";
import type { Segment } from "./types.ts";
import { removeNonLatin1Chars } from "../../utils/normalize.ts";
// import { parseCookie } from "./vtexId.ts";

export const SEGMENT_COOKIE_NAME = "vtex_segment";
const SALES_CHANNEL_COOKIE = "VTEXSC";
const SEGMENT = Symbol("segment");
const ORDER_FORM_ID = Symbol("orderFormId");

export interface WrappedSegment {
  payload: Partial<Segment>;
  token: string;
}

/**
 * by default segment starts with null values
 */
const DEFAULT_SEGMENT: Partial<Segment> = {
  utmi_campaign: null,
  utmi_page: null,
  utmi_part: null,
  utm_campaign: null,
  utm_source: null,
  utm_medium: null,
  channel: "1",
  cultureInfo: "pt-BR",
  currencyCode: "BRL",
  currencySymbol: "R$",
  countryCode: "BRA",
};

const isDefautSalesChannel = (ctx: AppContext, channel?: string) => {
  return channel ===
    (ctx.salesChannel || DEFAULT_SEGMENT.channel ||
      ctx.defaultSegment?.channel);
};

export const isAnonymous = (
  ctx: AppContext,
) => {
  const payload = getSegmentFromBag(ctx)?.payload;
  if (!payload) {
    return true;
  }
  const {
    campaigns,
    utm_campaign,
    utm_source,
    utmi_campaign,
    channel,
    priceTables,
    regionId,
  } = payload;
  return !campaigns &&
    !utm_campaign &&
    !utm_source &&
    !utmi_campaign &&
    (!channel || isDefautSalesChannel(ctx, channel)) &&
    !priceTables &&
    !regionId;
};

export const isCacheableSegment = (ctx: AppContext) => {
  const payload = getSegmentFromBag(ctx)?.payload;
  if (payload?.channelPrivacy === "private") return false;

  if (!payload) return true;
  const { campaigns, priceTables, regionId } = payload;
  return !campaigns && !priceTables && !regionId;
};

const setSegmentInBag = (ctx: AppContext, data: WrappedSegment) =>
  ctx?.bag?.set(SEGMENT, data);

export const getSegmentFromBag = (
  ctx: AppContext,
): WrappedSegment => ctx?.bag?.get(SEGMENT);

export const getOrderFormIdFromBag = (
  ctx: AppContext,
): Promise<string | undefined> | undefined => ctx?.bag?.get(ORDER_FORM_ID);

export const setOrderFormIdInBag = (
  ctx: AppContext,
  orderFormId: Promise<string | undefined>,
) => ctx?.bag?.set(ORDER_FORM_ID, orderFormId);

/**
 * btoa only accepts latin1 and THROWS on anything above it. The segment reaches
 * it from an attacker-controlled cookie: a `\uXXXX` escape in the cookie's JSON
 * survives atob + JSON.parse as a real code point above 0xFF and reaches btoa
 * from there. (The `?sc=` query param is fenced off at the source instead — see
 * buildSegmentFromRequest — because it also feeds the VTEXSC cookie.)
 *
 * That matters because `serialize` runs in the app middleware, on every request,
 * and `getSegmentCacheKeyWithoutUTM` runs inside `cacheKey`, which the runtime
 * calls outside its try — so a throw in either is a 500.
 *
 * Escaping back to ASCII keeps btoa in range without touching the value: the
 * round-trip through atob + JSON.parse yields the exact same string.
 */
const toBase64 = (value: unknown) =>
  btoa(
    JSON.stringify(value).replace(
      /[\u0080-\uffff]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    ),
  );

/**
 * The URL the cache key is built from.
 *
 * `pageHref` is a prop, so it arrives from a public POST /live/invoke like any
 * other, and `cacheKey` runs outside the runtime's try — a malformed value in
 * `new URL` is a 500 the caller hands itself. An unparseable one falls back to
 * the request, which is what the loader did before the prop existed.
 */
export const keyUrlOf = (pageHref: string | undefined, req: Request) =>
  new URL(pageHref && URL.canParse(pageHref) ? pageHref : req.url);

/**
 * Creates a stable cache key from segment that only includes business-critical fields.
 * Excludes marketing/tracking parameters (UTM, UTMI) to prevent cache fragmentation.
 *
 * Use this for cacheKey generation instead of the full segment token.
 */
export const getSegmentCacheKeyWithoutUTM = (ctx: AppContext): string => {
  const segment = getSegmentFromBag(ctx)?.payload;

  if (!segment) {
    return "";
  }

  // Only include fields that affect pricing, inventory, or content
  //
  // `channel` is deliberately absent. This storefront serves the website on
  // trade policy 1 and the mobile app on policy 5, and the two mirror each
  // other, so keying by the channel split one entry in two for byte-identical
  // payloads — and the app reaches these loaders over /live/invoke carrying its
  // own vtex_segment, so every shared path paid the fetch twice.
  const cacheRelevantSegment = {
    campaigns: segment.campaigns, // VTEX campaigns (can affect pricing)
    priceTables: segment.priceTables, // Price tables (affects pricing)
    regionId: segment.regionId, // Region (can affect pricing/inventory)
    currencyCode: segment.currencyCode, // Currency
    cultureInfo: segment.cultureInfo, // Locale/language
    countryCode: segment.countryCode, // Country
    // Privacy settings. The default arrives spelled out — VTEX mints
    // `"public"` while DEFAULT_SEGMENT omits the field — so only `"private"`
    // earns an entry of its own.
    channelPrivacy: segment.channelPrivacy === "public"
      ? undefined
      : segment.channelPrivacy,
    // EXCLUDED: utm_campaign, utm_source, utm_medium (marketing only)
    // EXCLUDED: utmi_campaign, utmi_page, utmi_part (VTEX tracking only)
  };

  // Absent, null and "" are one state, so they have to serialize as one.
  // DEFAULT_SEGMENT carries no campaigns, priceTables, regionId or
  // channelPrivacy, so the anonymous bag omits them entirely, while a shopper
  // carrying a VTEX-minted vtex_segment sends them as null — same truth, two
  // keys. The mobile app always carries that cookie, so every entry it shares
  // with the anonymous SSR of the website depended on it. Same predicate the
  // storefront applies on its own half of the key.
  return toBase64(
    Object.fromEntries(
      Object.entries(cacheRelevantSegment).filter(([, value]) =>
        Boolean(value)
      ),
    ),
  );
};
/**
 * Stable serialization.
 *
 * This means that even if the attributes are in a different order, the final segment
 * value will be the same. This improves cache hits
 */
const serialize = ({
  campaigns,
  channel,
  priceTables,
  regionId,
  utm_campaign,
  utm_source,
  utm_medium,
  utmi_campaign,
  utmi_page,
  utmi_part,
  currencyCode,
  currencySymbol,
  countryCode,
  cultureInfo,
  channelPrivacy,
}: Partial<Segment>) => {
  const seg = {
    campaigns,
    channel,
    priceTables,
    regionId,
    utm_campaign: utm_campaign &&
      removeNonLatin1Chars(utm_campaign).replace(/[\/\[\]{}()<>.]/g, ""),
    utm_source: utm_source &&
      removeNonLatin1Chars(utm_source).replace(/[\/\[\]{}()<>.]/g, ""),
    utm_medium: utm_medium &&
      removeNonLatin1Chars(utm_medium).replace(/[\/\[\]{}()<>.]/g, ""),
    utmi_campaign: utmi_campaign && removeNonLatin1Chars(utmi_campaign),
    utmi_page: utmi_page && removeNonLatin1Chars(utmi_page),
    utmi_part: utmi_part && removeNonLatin1Chars(utmi_part),
    currencyCode,
    currencySymbol,
    countryCode,
    cultureInfo,
    channelPrivacy,
  };
  return toBase64(seg);
};

const parse = (cookie: string) => {
  try {
    return JSON.parse(atob(cookie));
  } catch {
    return null;
  }
};

const SEGMENT_QUERY_PARAMS = [
  "utmi_campaign" as const,
  "utmi_page" as const,
  "utmi_part" as const,
  "utm_campaign" as const,
  "utm_source" as const,
  "utm_medium" as const,
];

export const buildSegmentFromRequest = (req: Request): Partial<Segment> => {
  const url = new URL(req.url);
  const partialSegment: Partial<Segment> = {};
  for (const qs of SEGMENT_QUERY_PARAMS) {
    const param = url.searchParams.get(qs);
    if (param) {
      partialSegment[qs] = param;
    }
  }

  // A sales channel is a VTEX integer id. Take it only in that shape: the raw
  // query value ends up in the VTEXSC cookie below, and setCookie rejects
  // anything outside US-ASCII by throwing — in the app middleware, which runs on
  // every request, so `?sc=<emoji>` on any URL would 500 the whole page.
  const sc = url.searchParams.get("sc");
  if (sc && /^\d+$/.test(sc)) {
    partialSegment.channel = sc;
  }

  return partialSegment;
};

export const withSegmentCookie = (
  segment: WrappedSegment,
  headers?: Headers,
) => {
  const h = new Headers(headers);
  if (!segment) {
    return h;
  }

  const { token } = segment;

  h.set("cookie", `${SEGMENT_COOKIE_NAME}=${token}`);

  return h;
};

export const setSegmentBag = (
  cookies: Record<string, string>,
  req: Request,
  ctx: AppContext,
) => {
  const vtex_segment = cookies[SEGMENT_COOKIE_NAME];
  const segmentFromCookie = vtex_segment ? parse(vtex_segment) : null;

  const segmentFromSalesChannelCookie = cookies[SALES_CHANNEL_COOKIE]
    ? { channel: cookies[SALES_CHANNEL_COOKIE]?.split("=")[1] }
    : {};

  const segmentFromRequest = buildSegmentFromRequest(req);

  const locale = {
    ...(ctx.defaultSegment?.countryCode && {
      countryCode: ctx.defaultSegment.countryCode,
    }),
    ...(ctx.defaultSegment?.cultureInfo && {
      cultureInfo: ctx.defaultSegment.cultureInfo,
    }),
  };

  const segment = {
    channel: ctx.salesChannel,
    ...DEFAULT_SEGMENT,
    ...ctx.defaultSegment,
    ...segmentFromCookie,
    ...segmentFromSalesChannelCookie,
    ...segmentFromRequest,
    ...locale,
  };

  const token = serialize(segment);
  setSegmentInBag(ctx, { payload: segment, token });

  // Always persist sales channel when it comes from request params so the
  // browser carries it across navigation. The CDN varies its cache key by
  // VTEXSC, so setting this cookie does not prevent CDN caching.
  if (segmentFromRequest.channel) {
    setCookie(ctx.response.headers, {
      value: `sc=${segmentFromRequest.channel}`,
      name: SALES_CHANNEL_COOKIE,
      path: "/",
      secure: true,
    });
  }

  // Only set vtex_segment when the channel is non-default so that default-SC
  // responses remain cacheable by the CDN without a Set-Cookie header.
  if (vtex_segment !== token && !isAnonymous(ctx)) {
    setCookie(ctx.response.headers, {
      value: token,
      name: SEGMENT_COOKIE_NAME,
      path: "/",
      secure: true,
      httpOnly: true,
    });
  }
};
