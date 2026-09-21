import { AppContext } from "../mod.ts";
import { ProductDetailsPage } from "../../commerce/types.ts";
import { ExtensionOf } from "../../website/loaders/extension.ts";
import {
  createClient,
  getProductId,
  PaginationOptions,
} from "../utils/client.ts";

export type Props = PaginationOptions & {
  aggregateSimilarProducts?: boolean;
};

/**
 * @title Opiniões verificadas - Full Review for Product (Ratings and Reviews)
 */
export default function productDetailsPage(
  config: Props,
  _req: Request,
  ctx: AppContext,
): ExtensionOf<ProductDetailsPage | null> {
  const client = createClient({ ...ctx });

  return async (productDetailsPage: ProductDetailsPage | null) => {
    if (!productDetailsPage || !client) {
      return null;
    }

    const productId = getProductId(productDetailsPage.product);
    let productsToGetReviews = [productId];

    if (config.aggregateSimilarProducts) {
      productsToGetReviews = [
        productId,
        ...productDetailsPage.product.isSimilarTo?.map(getProductId) ?? [],
      ];
    }

    // The invoke throws when the reviews API fails, and an extension that
    // throws takes the product page down with it. A page without a rating is
    // the degradation this component already renders — the button and the
    // sheet hide themselves, and the JSON-LD drops the aggregateRating.
    let fullReview;
    try {
      fullReview = await ctx.invoke["verified-reviews"].loaders.fullReview({
        productId: productsToGetReviews,
        count: config?.count,
        offset: config?.offset,
        order: config?.order,
      });
    } catch {
      return productDetailsPage;
    }

    return {
      ...productDetailsPage,
      product: {
        ...productDetailsPage.product,
        ...fullReview,
      },
    };
  };
}

export const cache = "no-cache";
