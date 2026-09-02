import type { Product } from "../../../commerce/types.ts";
import { STALE } from "../../../utils/fetch.ts";
import { AppContext } from "../../mod.ts";
import {
  isFilterParam,
  toPath,
  withDefaultFacets,
  withDefaultParams,
} from "../../utils/intelligentSearch.ts";
import {
  getSegmentCacheKeyWithoutUTM,
  getSegmentFromBag,
  keyUrlOf,
  withSegmentCookie,
} from "../../utils/segment.ts";
import { withIsSimilarTo } from "../../utils/similars.ts";
import { sortProducts, toProduct } from "../../utils/transform.ts";
import type {
  Item,
  ProductID,
  SimulationBehavior,
  Sort,
} from "../../utils/types.ts";
import { getFirstItemAvailable } from "../legacy/productListingPage.ts";
import {
  LabelledFuzzy,
  mapLabelledFuzzyToFuzzy,
} from "./productListingPage.ts";

/**
 * @title Collection ID
 */
export interface CollectionProps extends CommonProps {
  // TODO: pattern property isn't being handled by RJSF
  /**
   * @title Collection ID
   * @description (e.g.: 150)
   * @pattern \d*
   * @format dynamic-options
   * @options vtex/loaders/collections/list.ts
   */
  collection: string;
  /**
   * @description search sort parameter
   */
  sort?: Sort;
  /** @description total number of items to display. Required for collection */
  count: number;
}

/**
 * @title Advanced Facets
 */
export interface FacetsProps extends CommonProps {
  /**
   * @description query to use on search
   * @examples "shoes"\n"blue shoes"
   */
  query?: string;
  /**
   * @title Facets string
   * @description (e.g.: 'catergory-1/moda-feminina/category-2/calcados')
   * @pattern \d*
   */
  facets: string;
  /**
   * @description search sort parameter
   */
  sort?: Sort;
  /** @description total number of items to display. Required for collection */
  count: number;
}

/**
 * @title Keyword Search
 */
export interface QueryProps extends CommonProps {
  /**
   * @description query to use on search
   * @examples "shoes"\n"blue shoes"
   */
  query: string;
  /**
   * @description search sort parameter
   * @examples "price:asc"
   */
  sort?: Sort;
  /**
   * @description total number of items to display. Required for query
   * @examples 1\n2
   */
  count: number;

  /**
   * @title Fuzzy
   */
  fuzzy?: LabelledFuzzy;
}

/**
 * @title Product IDs
 */
export interface ProductIDProps extends CommonProps {
  /**
   * @description SKU ids to retrieve
   */
  ids: ProductID[];
}

export interface CommonProps {
  /**
   * @title Hide Unavailable Items
   * @description Do not return out of stock items
   */
  hideUnavailableItems?: boolean;
  /**
   * @description Include similar products
   * @deprecated Use product extensions instead
   */
  similars?: boolean;
  /**
   * @title Simulation Behavior
   * @description Defines the simulation behavior.
   */
  simulationBehavior?: SimulationBehavior;
  /**
   * @hide true
   * @description The URL of the page, used to override URL from request
   */
  pageHref?: string;
}

/**
 * @title Select products by
 */
export interface Props {
  /**
   * @title Select products by
   */
  props: CollectionProps | QueryProps | ProductIDProps | FacetsProps;
}

// deno-lint-ignore no-explicit-any
const isCollectionList = (p: any): p is CollectionProps =>
  typeof p.collection === "string" && typeof p.count === "number";
// deno-lint-ignore no-explicit-any
const isFacetsList = (p: any): p is FacetsProps =>
  typeof p.facets === "string" && typeof p.count === "number";
// deno-lint-ignore no-explicit-any
const isQueryList = (p: any): p is QueryProps =>
  typeof p.query === "string" && typeof p.count === "number";
// deno-lint-ignore no-explicit-any
const isProductIDList = (p: any): p is ProductIDProps =>
  Array.isArray(p.ids) && p.ids.length > 0;

const fromProps = ({ props }: Props, ctx: AppContext) => {
  const hideUnavailableItems = (p: CommonProps) =>
    p.hideUnavailableItems ?? ctx.advancedConfigs?.hideUnavailableItems;

  if (isFacetsList(props)) {
    return {
      query: props.query,
      count: props.count || 12,
      sort: props.sort || "",
      selectedFacets: [{ key: "", value: props.facets }],
      hideUnavailableItems: hideUnavailableItems(props),
      simulationBehavior: props.simulationBehavior || "default",
    } as const;
  }

  if (isProductIDList(props)) {
    return {
      query: `sku:${props.ids.join(";")}`,
      count: props.ids.length || 12,
      sort: "",
      selectedFacets: [],
      hideUnavailableItems: hideUnavailableItems(props),
      simulationBehavior: props.simulationBehavior || "default",
    } as const;
  }

  if (isQueryList(props)) {
    return {
      query: props.query || "",
      count: props.count || 12,
      sort: props.sort || "",
      fuzzy: mapLabelledFuzzyToFuzzy(props.fuzzy),
      selectedFacets: [],
      hideUnavailableItems: hideUnavailableItems(props),
      simulationBehavior: props.simulationBehavior || "default",
    } as const;
  }

  if (isCollectionList(props)) {
    return {
      query: "",
      count: props.count || 12,
      sort: props.sort || "",
      selectedFacets: [{ key: "productClusterIds", value: props.collection }],
      hideUnavailableItems: hideUnavailableItems(props),
      simulationBehavior: props.simulationBehavior || "default",
    } as const;
  }

  throw new Error(`Unknown props: ${JSON.stringify(props)}`);
};

const preferredSKU = (items: Item[], { props }: Props) => {
  const fetchedSkus = new Set((props as ProductIDProps).ids ?? []);
  if (fetchedSkus.size > 0) {
    return items.find((item) => fetchedSkus.has(item.itemId)) || items[0];
  }
  return items.find(getFirstItemAvailable) || items[0];
};

/**
 * @title Product List Intelligent Search
 * @description List a product list, commonly used for product shelves
 */
const loader = async (
  expandedProps: Props,
  req: Request,
  ctx: AppContext,
): Promise<Product[] | null> => {
  const props = expandedProps.props ??
    (expandedProps as unknown as Props["props"]);
  const { vcsDeprecated } = ctx;
  // `pageHref` over `req.url`, same as the sibling productListingPage loader: it
  // is what lets a caller that is not the page itself — a nested loader, a
  // /live/invoke from the mobile app — land on the entry the storefront's own
  // render produced. It also decides the base of every product URL in the
  // payload below, so a shared entry must not be written with the caller's URL.
  const url = keyUrlOf(props.pageHref, req).href;
  const segment = getSegmentFromBag(ctx);
  const locale = segment?.payload?.cultureInfo ??
    ctx.defaultSegment?.cultureInfo ?? "pt-BR";

  const { selectedFacets, ...args } = fromProps({ props }, ctx);
  const params = withDefaultParams({ ...args, locale });
  const facets = withDefaultFacets(selectedFacets, ctx);

  const { products: vtexProducts } = await vcsDeprecated
    ["GET /api/io/_v/api/intelligent-search/product_search/*facets"]({
      ...params,
      facets: toPath(facets),
    }, { ...STALE, headers: withSegmentCookie(segment) })
    .then((res) => res.json());

  const options = {
    baseUrl: url,
    priceCurrency: segment?.payload?.currencyCode ?? "BRL",
  };

  // Transform VTEX product format into schema.org's compatible format
  // If a property is missing from the final `products` array you can add
  // it in here
  let products = vtexProducts?.map((p) =>
    toProduct(p, preferredSKU(p.items, { props }), 0, options)
  );

  if (isProductIDList(props)) {
    products = sortProducts(products, props.ids || [], "sku");
  }

  return Promise.all(
    products.map((product) =>
      props.similars ? withIsSimilarTo(req, ctx, product) : product
    ),
  );
};

type Entry = [string, string];

const getSearchParams = (
  props: Props["props"],
  searchParams: URLSearchParams,
  ctx: AppContext,
): Entry[] => {
  if (isFacetsList(props)) {
    return [
      ["query", props?.query || searchParams.get("q") || ""],
      ["count", (props.count || searchParams.get("count") || 12).toString()],
      ["sort", props.sort || searchParams.get("sort") || ""],
      ["selectedFacets", props.facets],
      [
        "hideUnavailableItems",
        (props.hideUnavailableItems ??
          ctx.advancedConfigs?.hideUnavailableItems ?? false)
          .toString(),
      ],
      ["simulationBehavior", props.simulationBehavior || "default"],
    ];
  }

  if (isQueryList(props)) {
    return [
      ["query", props.query ?? searchParams.get("q")],
      ["count", (props.count || searchParams.get("count") || 12).toString()],
      ["sort", props.sort || searchParams.get("sort") || ""],
      ["fuzzy", mapLabelledFuzzyToFuzzy(props.fuzzy) ?? ""],
      [
        "hideUnavailableItems",
        (props.hideUnavailableItems ??
          ctx.advancedConfigs?.hideUnavailableItems ?? false)
          .toString(),
      ],
      ["simulationBehavior", props.simulationBehavior || "default"],
    ];
  }

  if (isCollectionList(props)) {
    return [
      ["count", (props.count || searchParams.get("count") || 12).toString()],
      ["sort", props.sort || searchParams.get("sort") || ""],
      ["collection", props.collection],
      [
        "hideUnavailableItems",
        (props.hideUnavailableItems ??
          ctx.advancedConfigs?.hideUnavailableItems ?? false)
          .toString(),
      ],
      ["simulationBehavior", props.simulationBehavior || "default"],
    ];
  }

  return [];
};

export const cache = "stale-while-revalidate";

export const cacheKey = (
  expandedProps: Props,
  req: Request,
  ctx: AppContext,
) => {
  const props = expandedProps.props ??
    (expandedProps as unknown as Props["props"]);

  const url = keyUrlOf(props.pageHref, req);

  // A facets list is decided entirely by its props — fromProps reads nothing
  // from the URL for it — so its key must not read the URL either. When the two
  // disagree the key is finer than the fetch: the same payload gets one entry
  // per `?q=`, and the caller's own path (a PDP, /deco/render, /live/invoke)
  // splits it again. Narrow it here and the entry is shared by construction.
  const keyedEntirelyByProps = isFacetsList(props);
  const keyParams = keyedEntirelyByProps
    ? new URLSearchParams()
    : url.searchParams;

  const searchTerm = url.searchParams.get("q");
  const cachedSearchTerms = ctx.cachedSearchTerms ?? [];
  if (
    // Avoid cache on search pages whose term is not whitelisted. This stays in
    // force for props-keyed lists too: an arbitrary term must never mint an entry.
    (!isQueryList(props) && searchTerm &&
      !cachedSearchTerms.includes(searchTerm.toLowerCase()))
  ) {
    return null;
  }

  // Loader-over-loader and /live/invoke are exactly the calls this cache is worth
  // the most to — the PDP backfill pays three of them — so the blanket
  // `ctx.isInvoke` veto only survives where the URL still decides the search.
  if (ctx.isInvoke && !keyedEntirelyByProps) {
    return null;
  }

  // A facets list carries a free-text `query` of its own, and the whitelist above
  // never sees it — `keyParams` is empty by design. Ungated on purpose: a
  // top-level POST /live/invoke arrives with `ctx.isInvoke` false, so gating this
  // on it would leave the public endpoint minting an entry, and an IS search, per
  // arbitrary phrase.
  const propsQuery = isFacetsList(props) ? props.query : undefined;
  if (propsQuery && !cachedSearchTerms.includes(propsQuery.toLowerCase())) {
    return null;
  }

  if (
    url.search.includes("filter.")
  ) {
    return null;
  }

  const segmentCacheKey = ctx.advancedConfigs?.removeUTMFromCacheKey
    ? getSegmentCacheKeyWithoutUTM(ctx)
    : getSegmentFromBag(ctx)?.token;
  const params = new URLSearchParams([
    ...getSearchParams(props, keyParams, ctx),
    ["segment", segmentCacheKey],
    // Attaches isSimilarTo to every product and is not reachable from the URL.
    // With the loader cache keyed by module, this key is the only thing keeping
    // two callers of this loader apart.
    ["similars", (props.similars ?? false).toString()],
  ]);

  if (
    isProductIDList(props)
  ) {
    const productIds = [props.ids ?? []].sort();
    params.append("productids", productIds.join(","));
  }

  url.searchParams.forEach((value, key) => {
    // Add filter filter.category-1, filter.category-2, filter.colors, filter.price, filter.size
    if (!isFilterParam(key)) return;
    params.append(key, value);
  });

  params.sort();

  url.search = params.toString();

  return url.href;
};

export default loader;
