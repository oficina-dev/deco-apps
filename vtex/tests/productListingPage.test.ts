import { assertEquals } from "@std/assert";
import { stub } from "@std/testing/mock";
import { logger } from "@deco/deco/o11y";
import type { Product, ProductListingPage } from "../../commerce/types.ts";
import {
  type Props,
  shouldCache,
} from "../loaders/intelligentSearch/productListingPage.ts";

const listingWith = (products: Product[]) =>
  ({
    "@type": "ProductListingPage",
    products,
    pageInfo: { records: products.length },
  }) as unknown as ProductListingPage;

const EMPTY = listingWith([]);
const WITH_PRODUCTS = listingWith([
  { "@type": "Product", productID: "1", sku: "1" },
]);

const props: Props = { count: 12 };
const request = (path: string) => new Request(`https://www.example.com${path}`);
const ctx = { cachedSearchTerms: ["camisa"] } as unknown as Parameters<
  typeof shouldCache
>[3];

/** Runs the predicate and reports the warnings it logged. */
const decide = (
  result: ProductListingPage | null,
  props: Props,
  req: Request,
) => {
  const warn = stub(logger, "warn");
  try {
    const cached = shouldCache(result, props, req, ctx);
    return { cached, warnings: warn.calls.length };
  } finally {
    warn.restore();
  }
};

Deno.test("an empty full-text search is not cached", () => {
  assertEquals(decide(EMPTY, props, request("/s?q=camisa")).cached, false);
});

Deno.test("a full-text search with products is cached", () => {
  assertEquals(
    decide(WITH_PRODUCTS, props, request("/s?q=camisa")).cached,
    true,
  );
});

Deno.test("an empty category listing is cached", () => {
  assertEquals(decide(EMPTY, props, request("/camisas")).cached, true);
});

Deno.test("the term set on the block counts as a full-text search", () => {
  const withQuery: Props = { ...props, query: "camisa" };
  assertEquals(decide(EMPTY, withQuery, request("/camisas")).cached, false);
});

Deno.test("the term in pageHref counts as a full-text search", () => {
  // The app invokes the loader with the storefront URL in pageHref.
  const withHref: Props = {
    ...props,
    pageHref: "https://www.example.com/s?q=camisa&page=2",
  };
  assertEquals(decide(EMPTY, withHref, request("/live/invoke")).cached, false);
});

Deno.test("a page that is not a listing is cached", () => {
  assertEquals(decide(null, props, request("/institucional")).cached, true);
});

Deno.test("a cached search term answering empty on its first page warns", () => {
  assertEquals(decide(EMPTY, props, request("/s?q=Camisa")).warnings, 1);
});

Deno.test("a veto where empty is plausible does not warn", () => {
  const filtered = request("/s?q=camisa&filter.tamanho=XXG");
  const pastTheEnd = request("/s?q=camisa&page=40");
  const uncachedTerm: Props = { ...props, query: "camisaa" };

  for (
    const [listingProps, req] of [
      [props, filtered],
      [props, pastTheEnd],
      [uncachedTerm, request("/live/invoke")],
    ] as const
  ) {
    assertEquals(decide(EMPTY, listingProps, req), {
      cached: false,
      warnings: 0,
    });
  }
});

Deno.test("an empty listing that is stored does not warn", () => {
  assertEquals(decide(EMPTY, props, request("/camisa")).warnings, 0);
});
