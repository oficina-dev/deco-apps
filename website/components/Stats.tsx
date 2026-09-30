import { Head } from "$fresh/runtime.ts";

/**
 * Deco Analytics — the first-party collector.
 *
 * Replaces `<OneDollarStats />`, and the difference that matters is not the vendor. It is
 * WHERE THE LOGIC LIVES.
 *
 * OneDollarStats ships roughly sixty lines of tracking code inside the site bundle: the
 * pushState patch, the flag reading, the event mapping, the truncation. Every one of those
 * is a decision that can be wrong, and fixing any of them means redeploying every site
 * that embeds it — across ~500 storefronts that is not a fix, it is a campaign.
 *
 * This component is a script tag and nothing else. The runtime, the commerce mapping, the
 * deco adapter and the per-site module composition are all served from the edge and
 * versioned there, so a correction ships with a cache purge instead of a fleet deploy.
 * That is also why there is deliberately NO npm package: a package would put a copy of the
 * runtime back inside every site bundle, which is the problem this shape exists to avoid.
 *
 * It also does not stringify money. OneDollarStats flattens every param through
 * `JSON.stringify` into a 990-byte string prop, so a purchase value arrives as text and
 * revenue cannot be summed without parsing it back. Ours lands in typed columns.
 *
 * NOTE ON NAMING: `analytics/loaders/DecoAnalyticsScript.ts` already exists in this repo
 * and is a **Plausible** loader despite the name. This is unrelated to it.
 */
export interface Props {
  /**
   * Where the script is served from and where events are sent.
   *
   * EMPTY IS THE RIGHT ANSWER for a site behind our CDN: a relative path keeps the request
   * first-party, which is not a detail — a first-party request is not blocked by tracking
   * protection, and the `Host` header then identifies the site. `Host` cannot be forged,
   * which is why it is the only source billing may trust.
   */
  origin?: string;

  /**
   * Only for a site NOT served through our CDN.
   *
   * A declared key rides in a public script attribute, so anyone can read it and post with
   * someone else's. Events carrying one are recorded as tag-sourced and are never used for
   * billing — the key identifies, it does not authenticate.
   */
  siteKey?: string;

  /**
   * Off by default. The script is already `async` and nothing renders from it, so deferring
   * only delays the first pageview — which is the one event a realtime view needs.
   */
  defer?: boolean;
}

export default function Stats({ origin = "", siteKey, defer }: Props) {
  const src = `${origin}/_dq/a.js${
    siteKey ? `?k=${encodeURIComponent(siteKey)}` : ""
  }`;
  return (
    <Head>
      {/* Only when the collector is on another origin. Preconnecting to our own is noise. */}
      {origin ? <link rel="preconnect" href={origin} /> : null}
      {
        /*
        `async`, and nothing on the page waits on it. A failure here has to degrade to
        "analytics stopped", never to "the page broke" — no island awaits this and no
        rendering path reads from it.
      */
      }
      <script async={!defer} defer={defer} src={src} />
    </Head>
  );
}
