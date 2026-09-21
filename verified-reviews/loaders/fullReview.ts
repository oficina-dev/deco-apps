import { logger } from "@deco/deco/o11y";
import { AppContext } from "../mod.ts";
import { createClient, PaginationOptions } from "../utils/client.ts";
import { VerifiedReviewsFullReview } from "../utils/types.ts";

export type Props = PaginationOptions & {
  productId: string | string[];
};

export default async function loader(
  props: Props,
  _req: Request,
  ctx: AppContext,
): Promise<VerifiedReviewsFullReview> {
  try {
    const client = createClient({ ...ctx });
    if (!client) {
      return {
        aggregateRating: undefined,
        review: [],
      };
    }

    const data = await client.fullReview(props);
    return data;
  } catch (error) {
    // Deliberately not swallowed. This loader is stale-while-revalidate, so a
    // handler that resolves is what gets written to the cache: returning an
    // empty review on a failed call blanks the rating for the whole TTL and
    // then serves that blank as stale. Throwing leaves the last good value in
    // place, and callers that can render without a rating catch it themselves.
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Error getting full review - ${message}`);
    throw error;
  }
}

export const cache = "stale-while-revalidate";

export const cacheKey = (props: Props) => {
  const normalized = {
    productId: Array.isArray(props.productId)
      ? [...props.productId].sort().join(",")
      : props.productId,
    count: props.count ?? 10,
    offset: props.offset ?? 0,
    order: props.order ?? "date_desc",
    customizeOrder: props.customizeOrder ?? false,
  };

  return `${normalized.productId}-${normalized.count}-${normalized.offset}-${normalized.order}-${normalized.customizeOrder}`;
};
