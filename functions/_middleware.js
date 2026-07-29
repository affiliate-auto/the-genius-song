/**
 * CF Pages Functions — Global Middleware
 *
 * 1. Countdown cookie  — sets af_start on first HTML visit so the 15-min
 *    timer is server-authoritative and survives page refreshes.
 *
 * 2. A/B test routing  — tracks page views in KV (binding: AF_AB).
 *    Before 50 views: always Variant A (control).
 *    After  50 views: 50/50 random split, sticky per visitor cookie.
 *    Injects data-ab="A|B" onto <body> so CSS/JS can show the right copy.
 *
 * Required KV binding (set in CF Pages → Settings → Functions → Bindings):
 *   KV namespace name: AF_AB
 *   Variable name:     AF_AB
 * If binding is absent the middleware still runs — A/B test just stays on A.
 */

export async function onRequest({ request, next, env }) {
  const url = new URL(request.url);

  // Skip the affiliate redirect and all static assets
  if (
    url.pathname === '/go' ||
    /\.(js|css|png|jpg|jpeg|webp|avif|svg|ico|woff2?|ttf|txt|xml|json|md)$/i.test(url.pathname)
  ) {
    return next();
  }

  const response = await next();
  if (!(response.headers.get('content-type') || '').includes('text/html')) {
    return response;
  }

  const cookies = request.headers.get('cookie') || '';
  const now = Math.floor(Date.now() / 1000);
  const newHeaders = new Headers(response.headers);

  // ── 1. Countdown cookie ────────────────────────────────────────────────────
  // Set once per visitor; expires when the 15-min window closes.
  if (!cookies.includes('af_start=')) {
    newHeaders.append(
      'Set-Cookie',
      `af_start=${now}; Path=/; Max-Age=900; SameSite=Lax; Secure`
    );
  }

  // ── 2. A/B test ───────────────────────────────────────────────────────────
  let variant = 'A';

  if (env.AF_AB) {
    try {
      const existingVariant = cookies.match(/af_ab=([AB])/);
      if (existingVariant) {
        variant = existingVariant[1];
      } else {
        // Increment view counter (keyed by hostname)
        const slug = url.hostname.replace(/[^a-z0-9]/gi, '-');
        const viewKey = 'views:' + slug;
        const currentViews = parseInt((await env.AF_AB.get(viewKey)) || '0', 10);
        const newViews = currentViews + 1;
        await env.AF_AB.put(viewKey, String(newViews), { expirationTtl: 86400 * 30 });

        // Activate split only after 50 views
        variant = newViews >= 50 ? (Math.random() < 0.5 ? 'B' : 'A') : 'A';

        newHeaders.append(
          'Set-Cookie',
          `af_ab=${variant}; Path=/; Max-Age=86400; SameSite=Lax; Secure`
        );
      }
    } catch (_) {
      // KV unavailable — default to A, no error surfaced to visitor
    }
  }

  // ── 3. Inject data-ab onto <body> ─────────────────────────────────────────
  let html = await response.text();
  html = html.replace(/(<body\b[^>]*)>/i, `$1 data-ab="${variant}">`);

  return new Response(html, { status: response.status, headers: newHeaders });
}
