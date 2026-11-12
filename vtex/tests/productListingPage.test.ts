import { assertEquals } from "@std/assert";
import type { Product, ProductListingPage } from "../../commerce/types.ts";
import {
  type Props,
  shouldCache,
} from "../loaders/intelligentSearch/productListingPage.ts";

const listingWith = (products: Product[]) =>
  ({
    "@type": "ProductListingPage",
    products,
  }) as unknown as ProductListingPage;

const EMPTY = listingWith([]);
const WITH_PRODUCTS = listingWith([
  { "@type": "Product", productID: "1", sku: "1" },
]);

const props: Props = { count: 12 };
const request = (path: string) => new Request(`https://www.example.com${path}`);

Deno.test("an empty full-text search is not cached", () => {
  assertEquals(shouldCache(EMPTY, props, request("/s?q=camisa")), false);
});

Deno.test("a full-text search with products is cached", () => {
  assertEquals(shouldCache(WITH_PRODUCTS, props, request("/s?q=camisa")), true);
});

Deno.test("an empty category listing is cached", () => {
  assertEquals(shouldCache(EMPTY, props, request("/camisas")), true);
});

Deno.test("the term set on the block counts as a full-text search", () => {
  const withQuery: Props = { ...props, query: "camisa" };
  assertEquals(shouldCache(EMPTY, withQuery, request("/camisas")), false);
});

Deno.test("the term in pageHref counts as a full-text search", () => {
  // The app invokes the loader with the storefront URL in pageHref.
  const withHref: Props = {
    ...props,
    pageHref: "https://www.example.com/s?q=camisa&page=2",
  };
  assertEquals(shouldCache(EMPTY, withHref, request("/live/invoke")), false);
});

Deno.test("a page that is not a listing is cached", () => {
  assertEquals(shouldCache(null, props, request("/institucional")), true);
});
