import { assertEquals } from "@std/assert";
import { context } from "@deco/deco";
import { loader } from "./Lazy.tsx";
import type { AppContext } from "../../mod.ts";

const EAGER_ONLY = "site/sections/EagerOnly.tsx";
const PLAIN = "site/sections/Plain.tsx";

const Component = () => null;
const LoadingFallback = () => null;

// A deferred section, the shape Lazy receives from `asResolved(..., true)`.
const deferredSection = (component: string) =>
  Object.assign(
    () =>
      Promise.resolve({
        Component,
        LoadingFallback,
        metadata: { component },
        props: { rendered: true },
      }),
    { _deferred: true as const },
  );

const withManifest = async (fn: () => Promise<void>) => {
  const previous = context.runtime;
  context.runtime = Promise.resolve(
    {
      manifest: {
        sections: {
          [EAGER_ONLY]: { default: Component, asyncRender: false },
          [PLAIN]: { default: Component },
        },
      },
    } as unknown as NonNullable<typeof context.runtime> extends Promise<infer R>
      ? R
      : never,
  );
  try {
    await fn();
  } finally {
    context.runtime = previous;
  }
};

const run = (component: string) =>
  loader(
    // deno-lint-ignore no-explicit-any
    { section: deferredSection(component) as any },
    new Request("https://example.com/"),
    { isBot: false } as AppContext,
  );

Deno.test("Lazy renders inline a section that exports asyncRender = false", () =>
  withManifest(async () => {
    const result = await run(EAGER_ONLY);
    assertEquals(result.loading, "eager");
    assertEquals(result.section?.props, { rendered: true });
  }));

Deno.test("Lazy still defers a section without the export", () =>
  withManifest(async () => {
    const result = await run(PLAIN);
    assertEquals(result.loading, "lazy");
    assertEquals(result.section?.Component, LoadingFallback);
    assertEquals(result.section?.props, {});
  }));

Deno.test("Lazy defers a component missing from the manifest (dangling)", () =>
  withManifest(async () => {
    const result = await run("resolved");
    assertEquals(result.loading, "lazy");
  }));

Deno.test("Lazy defers when the runtime is not available", async () => {
  const previous = context.runtime;
  context.runtime = undefined;
  try {
    const result = await run(EAGER_ONLY);
    assertEquals(result.loading, "lazy");
  } finally {
    context.runtime = previous;
  }
});
