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
          // store-graphql drops this field: the write targets the session-resolved profile.
          email: payload.sub,
        },
      },
    },
    { headers: { cookie } },
  );

  return updateProfile;
}

export default action;
