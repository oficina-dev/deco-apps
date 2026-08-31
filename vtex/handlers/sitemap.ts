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
 * slash — which would otherwise leak the platform host into the index.
 */
const rewriteHost = (xml: string, publicUrl: string, origin: string) => {
  const { host } = new URL(publicUrl);

  return xml.replace(
    new RegExp(`https?://${escapeRegExp(host)}/?`, "gi"),
    `${origin}/`,
  );
};

/**
 * Builds the very same URLPattern the router builds for a route, so that a URL
 * is kept if and only if the router would have a page for it. Hand-rolling the
 * match instead diverges on case, on trailing slashes and on percent-encoding —
 * see website/handlers/router.ts.
 */
const toRouteMatcher = (pathTemplate: string) => {
  const url = URL.canParse(pathTemplate)
    ? new URL(pathTemplate)
    : new URL(pathTemplate, "http://localhost:8000");

  return new URLPattern({
    pathname: url.pathname,
    ...(url.search ? { search: url.search } : {}),
  });
};

/**
 * Paths of every page that actually exists, as matchers. The catch-all is left
 * out on purpose: it matches every path, so counting it would make the filter
 * below inert and let orphan entries through.
 */
const getPageMatchers = async (ctx: AppContext): Promise<URLPattern[]> => {
  const pages = await ctx.get<Record<string, { path?: string }>>({
    type: "pages",
    __resolveType: "blockSelector",
  });

  return Object.values(pages ?? {})
    .map(({ path }) => path)
    .filter((path): path is string => Boolean(path) && path !== "/*")
    .flatMap((path) => {
      try {
        return [toRouteMatcher(path)];
      } catch {
        return [];
      }
    });
};

/**
 * Drops <url> entries the storefront has no page for. The platform's category
 * tree and the storefront's pages are maintained by different teams, so a
 * category created upstream shows up here before anyone has built its page —
 * and, with no page to serve it, answers 404. Announcing such a URL to crawlers
 * is worse than omitting it; it comes back on its own once the page exists.
 */
const filterEntriesWithoutPage = (
  xml: string,
  matchers: URLPattern[],
): { xml: string; kept: number; dropped: string[] } => {
  const dropped: string[] = [];
  let kept = 0;

  const filtered = xml.replace(
    /<url>\s*<loc>([^<]*)<\/loc>[\s\S]*?<\/url>\s*/gi,
    (block, loc: string) => {
      if (!URL.canParse(loc)) {
        kept += 1;
        return block;
      }

      if (matchers.some((matcher) => matcher.exec(loc) !== null)) {
        kept += 1;
        return block;
      }

      dropped.push(loc);
      return "";
    },
  );

  return { xml: filtered, kept, dropped };
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
   * @description Drops any <url> whose path has no page created, and logs it.
   */
  removeEntriesWithoutPage?: boolean;
}
/**
 * @title Sitemap Proxy
 */
export default function Sitemap(
  { include, excludeSiteMapEntry, removeEntriesWithoutPage }: Props,
  ctx: AppContext,
) {
  const { publicUrl: url, usePortalSitemap, account } = ctx;

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
        const matchers = await getPageMatchers(ctx);
        const result = filterEntriesWithoutPage(filtered, matchers);

        // Dropping every entry is a legitimate outcome of the rules above and
        // an unrecoverable one: an empty sitemap withdraws the whole site from
        // the index, and nothing downstream would notice. It is far likelier to
        // mean the pages could not be read, so the entries are kept and said.
        if (result.dropped.length > 0 && result.kept === 0) {
          const message =
            "Sitemap: refused to remove every entry, keeping the sitemap as is";
          const data = JSON.stringify({
            sitemap: reqUrl.pathname,
            count: result.dropped.length,
            pages: matchers.length,
          });

          console.error(message, data);
          logger.error(message, { data });
        } else {
          filtered = result.xml;

          if (result.dropped.length > 0) {
            const message =
              "Sitemap: entries removed because no page exists for them";
            const data = JSON.stringify({
              sitemap: reqUrl.pathname,
              count: result.dropped.length,
              urls: result.dropped,
            });

            console.warn(message, data);
            logger.warn(message, { data });
          }
        }
      } catch (error) {
        const message = "Sitemap: failed to filter entries without a page";
        const data = JSON.stringify({
          sitemap: reqUrl.pathname,
          error: error instanceof Error ? error.message : String(error),
        });

        console.error(message, data);
        logger.error(message, { data });
      }
    }

    return new Response(
      filtered,
      {
        headers: response.headers,
        status: response.status,
      },
    );
  };
}
