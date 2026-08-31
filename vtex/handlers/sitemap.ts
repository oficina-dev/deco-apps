import { logger } from "@deco/deco/o11y";
import Proxy from "../../website/handlers/proxy.ts";
import { AppContext } from "../mod.ts";

type ConnInfo = Deno.ServeHandlerInfo;
const xmlHeader =
  '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';

const includeSiteMaps = (
  currentXML: string,
  origin: string,
  includes?: string[],
) => {
  const siteMapIncludeTags = [];

  for (const include of (includes ?? [])) {
    siteMapIncludeTags.push(`
  <sitemap>
    <loc>${include.startsWith("/") ? `${origin}${include}` : include}</loc>
    <lastmod>${new Date().toISOString().substring(0, 10)}</lastmod>
  </sitemap>`);
  }
  return siteMapIncludeTags.length > 0
    ? currentXML.replace(
      xmlHeader,
      `${xmlHeader}\n${siteMapIncludeTags.join("\n")}`,
    )
    : currentXML;
};

const excludeSitemapEntries = (
  xml: string,
  exclude?: string[],
): string => {
  if (!exclude?.length) return xml;
  return xml.replace(
    /<sitemap>\s*<loc>([^<]*)<\/loc>[\s\S]*?<\/sitemap>/gi,
    (block, loc) => {
      const shouldExclude = exclude.some(
        (entry) => loc.includes(entry) || loc.endsWith(entry),
      );
      return shouldExclude ? "" : block;
    },
  );
};

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The upstream sitemap is written entirely with the commerce platform's own
 * host, and every <loc> has to be rewritten to the storefront's. Matching the
 * host rather than the configured URL keeps the rewrite working when the
 * platform emits a variation of it — http instead of https, or no trailing
 * slash. The host has to end where the match does, or a neighbour such as
 * "shop.example.com.br" gets rewritten through its prefix.
 */
const rewriteHost = (xml: string, publicUrl: string, origin: string) => {
  const { host } = new URL(publicUrl);

  return xml.replace(
    new RegExp(`https?://${escapeRegExp(host)}(?::\\d+)?(?=[/?#]|$)`, "gi"),
    origin,
  );
};

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

/**
 * A <loc> holds XML, so its URL arrives entity-encoded: the router would be
 * handed "?a=1&b=2" where the document says "?a=1&amp;b=2". Comparing the raw
 * text flags pages whose URL carries more than one query parameter.
 */
const decodeXmlEntities = (value: string) =>
  value.replace(
    /&(?:amp|lt|gt|quot|apos|#(\d+)|#x([0-9a-f]+));/gi,
    (entity, dec: string, hex: string) => {
      if (dec) return String.fromCodePoint(Number(dec));
      if (hex) return String.fromCodePoint(parseInt(hex, 16));
      return XML_ENTITIES[entity.toLowerCase()] ?? entity;
    },
  );

/**
 * What tells a catch-all apart from any other route is that it answers paths of
 * differing depth. Comparing the normalized pathname to "/*" misses the named
 * spellings, "/:path(.*)" and "/:path*", which normalize to themselves; probing
 * a single path instead catches routes of that very shape, since
 * "/:department/:category" does answer two segments of anything. Only a route
 * answering all three of these is one no URL can fail to match.
 */
const CATCH_ALL_PROBES = [
  "http://localhost:8000/9d2f7b1e-probe",
  "http://localhost:8000/9d2f7b1e-probe/a",
  "http://localhost:8000/9d2f7b1e-probe/a/b/c",
];

const isCatchAll = (matcher: URLPattern) =>
  CATCH_ALL_PROBES.every((probe) => matcher.exec(probe) !== null);

const PATTERN_SYNTAX = /[:*(){}+?[\]\\|]/;

/** Builds the very same URLPattern the router builds — see website/handlers/router.ts. */
const toRouteMatcher = (pathTemplate: string) => {
  const url = URL.canParse(pathTemplate)
    ? new URL(pathTemplate)
    : new URL(pathTemplate, "http://localhost:8000");

  return new URLPattern({
    pathname: url.pathname,
    ...(url.search ? { search: url.search } : {}),
  });
};

interface RouteIndex {
  /** Pathnames of routes with no pattern syntax, which are the vast majority. */
  staticPaths: Set<string>;
  /** Only the routes that genuinely need to be matched one by one. */
  patterns: URLPattern[];
  size: number;
}

/**
 * Indexes the routes actually being served — after every transformation the
 * loaders applied, which is what the router matches against, and what reading
 * the page blocks directly would miss.
 *
 * Static paths go to a set so that a sitemap of tens of thousands of URLs does
 * not walk hundreds of routes per entry; the sitemap protocol allows 50k URLs
 * in a single file.
 */
const indexRoutes = (routes: { pathTemplate: string }[]): RouteIndex => {
  const staticPaths = new Set<string>();
  const patterns: URLPattern[] = [];

  for (const { pathTemplate } of routes) {
    if (!pathTemplate) continue;

    try {
      const matcher = toRouteMatcher(pathTemplate);

      if (isCatchAll(matcher)) continue;

      if (PATTERN_SYNTAX.test(pathTemplate)) {
        patterns.push(matcher);
        continue;
      }

      staticPaths.add(new URL(pathTemplate, "http://localhost:8000").pathname);
    } catch {
      // A route the router itself could not compile matches nothing.
    }
  }

  return { staticPaths, patterns, size: staticPaths.size + patterns.length };
};

const isServedByARoute = (
  loc: string,
  { staticPaths, patterns }: RouteIndex,
) => {
  if (!URL.canParse(loc)) return true;

  return staticPaths.has(new URL(loc).pathname) ||
    patterns.some((pattern) => pattern.exec(loc) !== null);
};

/** Enough to act on without letting a large sitemap write megabytes of log. */
const SAMPLE_SIZE = 20;

/**
 * Drops the <url> entries no route answers. The platform's category tree and
 * the storefront's pages are maintained by different teams, so a category
 * created upstream shows up in this sitemap before anyone has built its page —
 * and, with no page to serve it, answers 404. Announcing such a URL to crawlers
 * is worse than omitting it; it comes back on its own once the page exists.
 *
 * Only <url> blocks are considered, never the <sitemap> blocks of an index:
 * those name documents rather than pages, and an external sitemap added
 * through `include` is a valid entry no route of this site answers.
 */
const dropEntriesWithoutPage = (
  xml: string,
  routes: { pathTemplate: string }[],
  sitemap: string,
) => {
  const index = indexRoutes(routes);

  // With no route to compare against, every entry would be reported. That says
  // the routes could not be read, not that the site has no page.
  if (index.size === 0) {
    const message = "Sitemap: no route to check entries against";
    const data = JSON.stringify({ sitemap });

    console.error(message, data);
    logger.error(message, { data });
    return xml;
  }

  let count = 0;
  const sample: string[] = [];

  const filtered = xml.replace(
    /<url>\s*<loc>([^<]*)<\/loc>[\s\S]*?<\/url>\s*/gi,
    (block, loc: string) => {
      const url = decodeXmlEntities(loc);

      if (isServedByARoute(url, index)) return block;

      count += 1;
      if (sample.length < SAMPLE_SIZE) sample.push(url);
      return "";
    },
  );

  if (count === 0) return xml;

  const message = "Sitemap: entries removed because no page answers their path";
  const data = JSON.stringify({
    sitemap,
    count,
    sample,
    truncated: count > sample.length,
  });

  console.warn(message, data);
  logger.warn(message, { data });

  return filtered;
};

export interface Props {
  include?: string[];
  /**
   * @title Sitemap entries to remove from the sitemap index
   * @description URLs or path suffixes to match; any <sitemap> whose <loc> contains or ends with one of these will be removed.
   */
  excludeSiteMapEntry?: string[];
  /**
   * @title Remove URLs without a page
   * @description Drops any <url> whose path no route answers, and logs it.
   */
  removeEntriesWithoutPage?: boolean;
}
/**
 * @title Sitemap Proxy
 */
export default function Sitemap(
  { include, excludeSiteMapEntry, removeEntriesWithoutPage }: Props,
  { publicUrl: url, usePortalSitemap, account }: AppContext,
) {
  return async (
    req: Request,
    connInfo: ConnInfo,
  ) => {
    if (!url) {
      throw new Error("Missing publicUrl");
    }

    const urlFromPublicUrl =
      new URL(url?.startsWith("http") ? url : `https://${url}`).href;

    /**
     * Some stores were having problems with the IO sitemap (missing categories and brands)
     */
    const publicUrl = usePortalSitemap
      ? `https://${account}.vtexcommercestable.com.br/`
      : urlFromPublicUrl;

    const response = await Proxy({
      url: publicUrl,
    })(req, connInfo);

    const reqUrl = new URL(req.url);
    const text = await response.text();

    const withIncludes = includeSiteMaps(
      rewriteHost(text, publicUrl, reqUrl.origin),
      reqUrl.origin,
      include,
    );

    let filtered = excludeSitemapEntries(withIncludes, excludeSiteMapEntry);

    if (removeEntriesWithoutPage) {
      try {
        const { state } = connInfo as ConnInfo & {
          state?: { routes?: { pathTemplate: string }[] };
        };

        filtered = dropEntriesWithoutPage(
          filtered,
          state?.routes ?? [],
          reqUrl.pathname,
        );
      } catch (error) {
        const message = "Sitemap: failed to check entries against the routes";
        const data = JSON.stringify({
          sitemap: reqUrl.pathname,
          error: error instanceof Error ? error.message : String(error),
        });

        console.error(message, data);
        logger.error(message, { data });
      }
    }

    // The body is decoded and rewritten here, so the upstream's own framing and
    // validators stop describing it: its length changes with every <loc>, it is
    // no longer the gzip stream content-encoding announces, and its etag names
    // the document as the platform wrote it, not as it is served.
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("etag");

    return new Response(
      filtered,
      {
        headers,
        status: response.status,
      },
    );
  };
}
