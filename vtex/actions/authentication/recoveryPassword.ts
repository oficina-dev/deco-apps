import { getCookies, getSetCookies, setCookie } from "std/http/cookie.ts";
import { AppContext } from "../../mod.ts";
import { getSegmentFromBag } from "../../utils/segment.ts";
import { AuthResponse } from "../../utils/types.ts";
import {
  buildCookieJar,
  proxySetCookie,
  REFRESH_TOKEN_COOKIE,
} from "../../utils/cookies.ts";
import { HttpError } from "../../../utils/http.ts";
import { logger } from "@deco/deco/o11y";
import { authResponseFromHttpError } from "../../utils/authResponse.ts";

export interface Props {
  email: string;
  newPassword: string;
  accessKey: string;
}

/**
 * @title Recovery Password
 * @description Recovery password
 */
export default async function action(
  props: Props,
  req: Request,
  ctx: AppContext,
): Promise<AuthResponse> {
  const { vcsDeprecated, account } = ctx;
  const segment = getSegmentFromBag(ctx);

  if (!props.email || !props.accessKey || !props.newPassword) {
    throw new Error("Email, accessKey and/or newPassword is missing");
  }

  const cookies = getCookies(req.headers);
  const startSetCookies = getSetCookies(ctx.response.headers);
  const { header: cookie } = buildCookieJar(req.headers, startSetCookies);
  const VtexSessionToken = cookies?.["VtexSessionToken"] ?? null;

  if (!VtexSessionToken) {
    throw new Error('"VtexSessionToken" cookie is missing');
  }

  const urlencoded = new URLSearchParams();
  urlencoded.append("login", props.email);
  urlencoded.append("accessKey", props.accessKey);
  urlencoded.append("newPassword", props.newPassword);
  urlencoded.append("authenticationToken", VtexSessionToken);

  let response;
  try {
    response = await vcsDeprecated
      ["POST /api/vtexid/pub/authentication/classic/setpassword"](
        {
          locale: segment?.payload.cultureInfo || "pt-BR",
          scope: account,
        },
        {
          body: urlencoded,
          headers: {
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            cookie,
          },
        },
      );
  } catch (error) {
    // A structured VTEX rejection (wrong access key, WrongCredentials) is a normal result.
    const rejection = authResponseFromHttpError(error);
    if (rejection) return rejection;
    const status = error instanceof HttpError ? error.status : 500;
    const body = error instanceof Error ? error.message : String(error);
    logger.error("[vtex/recoveryPassword] setpassword failed", {
      email: props.email,
      status,
      body,
    });
    throw new HttpError(status, body, { cause: error });
  }

  const data: AuthResponse = await response.json();
  proxySetCookie(response.headers, ctx.response.headers, req.url);
  try {
    await ctx.invoke.vtex.actions.session.validateSession();
  } catch (error) {
    // setpassword already succeeded — a session hiccup must not look like a failure.
    logger.error(
      "[vtex/recoveryPassword] validateSession failed after password change",
      {
        email: props.email,
        body: error instanceof Error ? error.message : String(error),
      },
    );
  }

  // TODO: REMOVE THIS AFTER TESTING AND VALIDATE IF NEEDED
  const setCookies = getSetCookies(ctx.response.headers);
  for (const cookie of setCookies) {
    if (cookie.name === REFRESH_TOKEN_COOKIE) {
      setCookie(ctx.response.headers, {
        ...cookie,
        path: "/", // default path is /api/vtexid/refreshtoken/webstore, but browser dont send to backend headers
      });
    }
  }

  return data;
}
