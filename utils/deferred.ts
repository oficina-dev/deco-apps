export const __DECO_FBT = "__decoFBT";

export const shouldForceRender = <Ctx extends { isBot?: boolean }>(
  { ctx, searchParams }: { ctx: Ctx; searchParams: URLSearchParams },
): boolean => ctx.isBot || searchParams.get(__DECO_FBT) === "0";

/**
 * A section opts out of async rendering by exporting `asyncRender = false`.
 * Lazy then renders it inline even when the admin wrapped it, so a section
 * whose layout depends on being in the first HTML (e.g. a fixed header) can't
 * be broken by a CMS toggle.
 */
export const isAsyncRenderDisabled = (
  sections: Record<string, unknown> | undefined,
  component: string | undefined,
): boolean =>
  component !== undefined &&
  (sections?.[component] as { asyncRender?: unknown } | undefined)
      ?.asyncRender === false;
