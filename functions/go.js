/**
 * Cloudflare Pages Function — Affiliate Link Cloaking
 * Path: /go  (serves as https://[domain]/go)
 *
 * This replaces the go.[domain].com subdomain Worker approach.
 * No separate Worker deploy, no subdomain DNS record — works automatically
 * as a Pages Function for every site using this template.
 *
 * Affiliate URL is read from:
 *   1. KV binding AFFILIATE_CONFIG (key: "affiliate_url") — allows zero-downtime swaps
 *   2. Fallback: hardcoded https://7b86b9sxbbbz7n70kijky7zxet.hop.clickbank.net/ (set by pipeline at build time)
 *
 * Click is logged non-blocking to D1 (binding: DB).
 * Country is extracted from Cloudflare's cf-ipcountry header (automatic, no extra config).
 *
 * Bindings required (set in Cloudflare Pages > Settings > Functions > Bindings):
 *   KV namespace:  AFFILIATE_CONFIG
 *   D1 database:   DB
 *   Variable:      SITE_ID (integer, matches sites.id in D1)
 */

const FALLBACK_URL = "https://7b86b9sxbbbz7n70kijky7zxet.hop.clickbank.net/";

export async function onRequest(context) {
  const { request, env } = context;

  // 1. Resolve affiliate URL (KV first, fallback to build-time URL)
  let affiliateUrl = null;
  try {
    affiliateUrl = await env.AFFILIATE_CONFIG?.get("affiliate_url");
    if (!affiliateUrl) {
      const domain = new URL(request.url).hostname;
      affiliateUrl = await env.AFFILIATE_CONFIG?.get(`affiliate_url:${domain}`);
    }
  } catch (_) {}
  affiliateUrl = affiliateUrl || FALLBACK_URL;

  if (!affiliateUrl) {
    return new Response("Affiliate URL not configured", { status: 500 });
  }

  // 2. Log click non-blocking (don't delay the redirect)
  context.waitUntil(logClick(request, env));

  // 3. 301 redirect
  return Response.redirect(affiliateUrl, 301);
}

async function logClick(request, env) {
  try {
    if (!env.DB) return;
    const siteId = env.SITE_ID ? parseInt(env.SITE_ID) : null;
    await env.DB.prepare(
      `INSERT INTO clicks (site_id, clicked_at, user_agent, referrer, country)
       VALUES (?, datetime('now'), ?, ?, ?)`
    )
      .bind(
        siteId,
        (request.headers.get("user-agent") || "").slice(0, 500),
        (request.headers.get("referer") || "").slice(0, 500),
        request.headers.get("cf-ipcountry") || ""
      )
      .run();
  } catch (err) {
    console.error("Click log error:", err.message);
  }
}
