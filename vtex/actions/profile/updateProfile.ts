import { getCookies } from "std/http/mod.ts";
import { AppContext } from "../../mod.ts";
import type { Profile, ProfileInput } from "../../utils/types.ts";
import { forwardCookie, parseCookie } from "../../utils/vtexId.ts";

const mutation = `mutation UpdateProfile($input: ProfileInput!) {
  updateProfile(fields: $input) @context(provider: "vtex.store-graphql") {
    cacheId
    firstName
    lastName
    birthDate
    gender
    homePhone
    businessPhone
    document
    email
    tradeName
    corporateName
    corporateDocument
    stateRegistration
    isCorporate
  }
}`;

/**
 * @title Update Profile
 * @description Update the profile
 */
async function action(
  props: Omit<ProfileInput, "email">,
  req: Request,
  ctx: AppContext,
): Promise<Profile> {
  const { io } = ctx;
  const { payload } = parseCookie(req.headers, ctx.account);

  if (!payload?.sub || !payload?.userId) {
    throw new Error("User cookie is invalid");
  }

  const cookie = forwardCookie(req.headers);

  // Under a telesales session payload.sub is the OPERATOR's email, so read the email FIELD
  // from this public, client-writable cookie instead. The write's target stays bounded by the
  // forwarded session (store-graphql's @withCurrentProfile, Televendas-gated), not this cookie.
  const impersonatedEmail =
    getCookies(req.headers)["vtex-impersonated-customer-email"];
  const email = payload.audience === "admin" ? impersonatedEmail : payload.sub;
  if (!email) {
    throw new Error("Could not resolve the target profile email");
  }

  const { updateProfile } = await io.query<
    { updateProfile: Profile },
    { input: ProfileInput }
  >(
    {
      query: mutation,
      operationName: "UpdateProfile",
      variables: {
        input: {
          ...props,
          email,
        },
      },
    },
    { headers: { cookie } },
  );

  return updateProfile;
}

export default action;
