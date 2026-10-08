import { HttpError } from "../../utils/http.ts";
import { AuthResponse } from "./types.ts";

/**
 * VTEX returns structured auth rejections (WrongCredentials, BlockedUser, ...)
 * as a non-2xx whose body is an AuthResponse JSON; fetchSafe wraps it in an
 * HttpError. Recover the AuthResponse, or return null when the failure is
 * genuinely unexpected (non-JSON body, network error) and should be rethrown.
 */
export function authResponseFromHttpError(error: unknown): AuthResponse | null {
  if (!(error instanceof HttpError)) return null;
  try {
    const body = JSON.parse(error.message);
    return typeof body?.authStatus === "string" ? body as AuthResponse : null;
  } catch {
    return null;
  }
}
