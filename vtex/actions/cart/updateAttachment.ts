import { AppContext } from "../../mod.ts";
import { proxySetCookie } from "../../utils/cookies.ts";
import { parseCookie } from "../../utils/orderForm.ts";
import type { OrderForm } from "../../utils/types.ts";
import { DEFAULT_EXPECTED_SECTIONS } from "./updateItemAttachment.ts";
import { getSegmentFromBag } from "../../utils/segment.ts";

export interface Props {
  attachment: string;
  expectedOrderFormSections?: string[];
  // deno-lint-ignore no-explicit-any
  body: any;
  /**
   * Client-supplied orderFormId fallback for when the checkout.vtex.com cookie
   * is absent on the request (e.g. in-app WebViews with partitioned/ephemeral
   * cookies). VTEX addresses the orderForm by the URL path param, so the cookie
   * is optional for the write.
   */
  orderFormId?: string;
}

/**
 * @title Update Attachment
 * @description Update an attachment in the cart
 */
const action = async (
  props: Props,
  req: Request,
  ctx: AppContext,
): Promise<OrderForm> => {
  const { vcsDeprecated } = ctx;
  const {
    attachment,
    body,
    expectedOrderFormSections = DEFAULT_EXPECTED_SECTIONS,
  } = props;
  // VTEX addresses the orderForm by the URL path param, so the checkout.vtex.com
  // cookie is optional for the write. In-app WebViews (Instagram iOS) often drop
  // that HttpOnly cookie while the client still holds a valid orderFormId, so fall
  // back to the client-supplied props.orderFormId. Keep the throw: a genuinely
  // missing id must still error (never no-op — the cart queue would otherwise
  // overwrite the local cart signal with an empty orderForm).
  const { orderFormId: cookieOrderFormId } = parseCookie(req.headers);
  const orderFormId = cookieOrderFormId || props.orderFormId;

  if (!orderFormId || orderFormId === "") {
    throw new Error("Order form ID is required");
  }

  const cookie = req.headers.get("cookie") ?? "";
  const segment = getSegmentFromBag(ctx);

  const response = await vcsDeprecated
    ["POST /api/checkout/pub/orderForm/:orderFormId/attachments/:attachment"]({
      orderFormId,
      attachment,
      sc: segment?.payload.channel,
    }, {
      body: { expectedOrderFormSections, ...body },
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        cookie,
      },
    });

  proxySetCookie(response.headers, ctx.response.headers, req.url);

  return response.json();
};

export default action;
