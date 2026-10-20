import { AppContext } from "../../mod.ts";
import { AuthResponse } from "../../utils/types.ts";
import { getSetCookies, setCookie } from "std/http/cookie.ts";
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
  currentPassword: string;
  newPassword: string;
}

/**
 * @title Redefine Password
 * @description Redefine password
 */
export default async function action(
  props: Props,
  req: Request,
  ctx: AppContext,
): Promise<AuthResponse> {
  const { vcsDeprecated, account } = ctx;

  if (!props.email || !props.currentPassword || !props.newPassword) {
    throw new Error("Email and/or password is missing");
  }

  // setpassword needs the session from `startlogin` (sent via the _vss cookie);
  // the plain `/start` token is no longer accepted.
  const startLoginBody = new FormData();
  startLoginBody.append("user", props.email);
  startLoginBody.append("scope", account);
  startLoginBody.append("accountName", account);
  startLoginBody.append("returnUrl", "/");
  startLoginBody.append("callbackUrl", "/");
  startLoginBody.append("fingerprint", "");

  let startLoginResponse;
  try {
    startLoginResponse = await vcsDeprecated
      ["POST /api/vtexid/pub/authentication/startlogin"](
        {},
        {
          body: startLoginBody,
          headers: { cookie: req.headers.get("cookie") || "" },
        },
      );
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const body = error instanceof Error ? error.message : String(error);
    logger.error("[vtex/resetPassword] startlogin failed", {
      email: props.email,
      status,
      body,
    });
    throw new HttpError(status, body, { cause: error });
  }

  proxySetCookie(startLoginResponse.headers, ctx.response.headers, req.url);
  const startSetCookies = getSetCookies(ctx.response.headers);
  const { header: cookie } = buildCookieJar(req.headers, startSetCookies);

  const setPasswordBody = new FormData();
  setPasswordBody.append("login", props.email);
  setPasswordBody.append("currentPassword", props.currentPassword);
  setPasswordBody.append("newPassword", props.newPassword);
  setPasswordBody.append("accesskey", "");
  setPasswordBody.append("recaptcha", "");

  let response;
  try {
    response = await vcsDeprecated
      ["POST /api/vtexid/pub/authentication/classic/setpassword"](
        { expireSessions: true },
        {
          body: setPasswordBody,
          headers: { "Accept": "application/json", cookie },
        },
      );
  } catch (error) {
    // A structured VTEX rejection (WrongCredentials, BlockedUser) is a normal result.
    const rejection = authResponseFromHttpError(error);
    if (rejection) return rejection;
    const status = error instanceof HttpError ? error.status : 500;
    const body = error instanceof Error ? error.message : String(error);
    logger.error("[vtex/resetPassword] setpassword failed", {
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
      "[vtex/resetPassword] validateSession failed after password change",
      {
        email: props.email,
        body: error instanceof Error ? error.message : String(error),
      },
    );
  }

  const setCookies = getSetCookies(ctx.response.headers);
  for (const responseCookie of setCookies) {
    if (responseCookie.name === REFRESH_TOKEN_COOKIE) {
      // default path is /api/vtexid/refreshtoken/webstore; rewrite to / so the
      // browser sends it back to the backend.
      setCookie(ctx.response.headers, {
        ...responseCookie,
        path: "/",
      });
    }
  }

  return data;
}
