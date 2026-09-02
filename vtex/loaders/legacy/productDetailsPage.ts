import type { ProductDetailsPage } from "../../../commerce/types.ts";
import { STALE } from "../../../utils/fetch.ts";
import type { RequestURLParam } from "../../../website/functions/requestToParam.ts";
import { AppContext } from "../../mod.ts";
import { toSegmentParams } from "../../utils/legacy.ts";
import {
  getSegmentCacheKeyWithoutUTM,
  getSegmentFromBag,
  keyUrlOf,
  withSegmentCookie,
} from "../../utils/segment.ts";
import { withIsSimilarTo } from "../../utils/similars.ts";
import { pickSku, toProductPage } from "../../utils/transform.ts";
import type { AdvancedLoaderConfig, LegacyProduct } from "../../utils/types.ts";
import PDPDefaultPath from "../paths/PDPDefaultPath.ts";

export interface Props {
  slug: RequestURLParam;

  /**
   * @description Include similar products
   * @deprecated Use product extensions instead
   */
  similars?: boolean;
  /**
   * @title Indexing Skus
   * @description Index of product pages with the `skuId` parameter
   */
  indexingSkus?: boolean;
  /**
   * @hide true
   * @description Canonical page URL to key the cache by. Same contract, and the
   * same `@hide`, as intelligentSearch/productListingPage: without it a call
   * through /live/invoke keys by its own URL and can never share the entry the
   * page render produced.
   */
  pageHref?: string;
  /**
   * @title Advanced Configuration
   * @description Further change loader behaviour
   */
  advancedConfigs?: AdvancedLoaderConfig;
}

/**
 * @title Product Details Page Legacy
 * @description List a product details page, with product and SEO data. commonly used for product pages.
 */
async function loader(
  props: Props,
  req: Request,
  ctx: AppContext,
): Promise<ProductDetailsPage | null> {
  const { vcsDeprecated } = ctx;
  const { url: baseUrl } = req;
  const { slug } = props;
  const haveToUseSlug = slug && !slug.startsWith(":slug");
  let defaultPaths;
  if (!haveToUseSlug) {
    defaultPaths = await PDPDefaultPath({ count: 1 }, req, ctx);
  }
  const lowercaseSlug = haveToUseSlug
    ? slug?.toLowerCase()
    : defaultPaths?.possiblePaths[0] || "/";
  const url = new URL(baseUrl);
  const segment = getSegmentFromBag(ctx);
  const params = toSegmentParams(segment);
  const skuId = url.searchParams.get("skuId");

  const response = await vcsDeprecated
    ["GET /api/catalog_system/pub/products/search/:slug/p"](
      { ...params, slug: lowercaseSlug },
      { ...STALE, headers: withSegmentCookie(segment) },
    ).then((res) => res.json());
  if (response && !Array.isArray(response)) {
    throw new Error(
      `Error while fetching VTEX data ${JSON.stringify(response)}`,
    );
  }

  const [product] = response;

  // Product not found, return the 404 status code
  if (!product) {
    return null;
  }

  const sku = pickSku(product, skuId?.toString());

  const kitItems: LegacyProduct[] =
    Array.isArray(sku.kitItems) && sku.kitItems.length > 0
      ? await vcsDeprecated
        ["GET /api/catalog_system/pub/products/search/:term?"](
          {
            ...params,
            _from: 0,
            _to: 49,
            fq: sku.kitItems.map((item) => `skuId:${item.itemId}`),
          },
          STALE,
        ).then((res) => res.json())
      : [];

  const page = toProductPage(product, sku, kitItems, {
    baseUrl,
    priceCurrency: segment?.payload?.currencyCode ?? "BRL",
    includeOriginalAttributes: props.advancedConfigs?.includeOriginalAttributes,
  });

  return {
    ...page,
    product: props.similars
      ? await withIsSimilarTo(req, ctx, page.product)
      : page.product,
    seo: {
      title: product.productTitle || product.productName,
      description: props.advancedConfigs?.preferDescription
        ? product.description
        : product.metaTagDescription,
      canonical: new URL(`/${product.linkText}/p`, url.origin).href,
      noIndexing: props.indexingSkus ? false : !!skuId,
    },
  };
}

export const cache = "stale-while-revalidate";

export const cacheKey = (props: Props, req: Request, ctx: AppContext) => {
  const reqUrl = new URL(req.url);

  if (reqUrl.searchParams.has("ft")) {
    return null;
  }

  // props.pageHref first, like productListingPage does: the page render and a
  // /live/invoke call for the same product have different request URLs, so
  // keying by req.url alone gives each caller its own entry for identical data.
  const url = keyUrlOf(props.pageHref, req);

  const segment = ctx.advancedConfigs?.removeUTMFromCacheKey
    ? getSegmentCacheKeyWithoutUTM(ctx)
    : getSegmentFromBag(ctx)?.token;
  const skuId = reqUrl.searchParams.get("skuId") ?? "";

  // Every prop that changes the payload belongs here. `similars` toggles
  // withIsSimilarTo below, so leaving it out let whoever asked first decide
  // whether isSimilarTo existed for everyone else until the entry expired.
  const params = new URLSearchParams([
    ["slug", props.slug],
    ["segment", segment ?? ""],
    ["skuId", skuId],
    ["similars", String(props.similars ?? false)],
    ["indexingSkus", String(props.indexingSkus ?? false)],
    [
      "preferDescription",
      String(props.advancedConfigs?.preferDescription ?? false),
    ],
    [
      // Stringified, not joined: `["a,b"]` and `["a","b"]` join to the same
      // string and this list decides which attributes the payload carries.
      "originalAttrs",
      JSON.stringify(props.advancedConfigs?.includeOriginalAttributes ?? []),
    ],
  ]);

  params.sort();

  url.search = params.toString();

  return url.href;
};

export default loader;
