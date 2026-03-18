# Ever Club Public Pages Audit Summary

**Date:** 2026-03-17
**Tool:** squirrelscan v0.0.38
**Target:** https://www.everclub.app
**Coverage:** Surface (15 pages crawled)
**Overall Score:** 72/100 (Grade C)
**Results:** 1,155 passed | 112 warnings | 16 errors

## Category Scores

| Category | Score | Grade |
|---|---|---|
| E-E-A-T | 100 | A+ |
| Internationalization | 100 | A+ |
| Legal Compliance | 100 | A+ |
| Links | 100 | A+ |
| Local SEO | 100 | A+ |
| Mobile | 100 | A+ |
| Structured Data | 100 | A+ |
| URL Structure | 100 | A+ |
| Core SEO | 99 | A+ |
| Accessibility | 94 | A |
| Content | 93 | A |
| Performance | 93 | A |
| Crawlability | 91 | A |
| Security | 82 | B |
| Social Media | 77 | C |
| Images | 73 | C |

## Top Issues by Severity

### Errors (16 total)

1. **Invalid Sitemaps** (`crawl/sitemap-valid`) — 7 sitemap URLs return "Unknown sitemap format" errors (`/sitemap_index.xml`, `/sitemap-index.xml`, `/sitemaps.xml`, `/sitemap1.xml`, `/post-sitemap.xml`, etc.)
2. **Missing Image Alt Text** (`images/alt-text`) — 1 image (Facebook pixel `<noscript>` tracker) missing alt text across all 15 pages

### Warnings (112 total)

3. **Thin Content** (`content/word-count`) — All 15 pages report fewer than 300 words. This is likely a false positive from the SPA rendering (content loaded via JS may not be fully visible to the crawler).
4. **No `<main>` Landmark** (`a11y/landmark-one-main`) — All 15 pages lack a `<main>` HTML element, reducing accessibility for screen readers.
5. **No Skip Navigation Link** (`a11y/skip-link`) — No bypass mechanism for repetitive content (header/nav) on any page.
6. **Missing Landmark Regions** (`a11y/landmark-regions`) — Related to the missing `<main>` element above.
7. **og:url Mismatch** (`social/og-url-match`) — Open Graph `og:url` does not match canonical URL on 14 pages.
8. **Short Meta Descriptions** (`core/meta-description`) — `/privacy` (93 chars) and `/terms` (89 chars) have descriptions below recommended length.
9. **LCP Image Without Preload** (`perf/lcp-hints`) — Potential Largest Contentful Paint image lacks `<link rel="preload">` hint.
10. **Critical Request Chains** (`perf/critical-request-chains`) — 2 render-blocking chains: Google Fonts CSS and main stylesheet.
11. **CSP Policy Issues** (`security/csp`) — Content Security Policy allows `unsafe-inline` and `unsafe-eval`; script-src uses wildcard.
12. **Supabase Anon Key Detected** (`security/leaked-secrets`) — Supabase anonymous key found in bundled JavaScript (expected for client-side Supabase usage, not a true secret leak).
13. **HTTP to HTTPS Redirects** (`security/http-to-https`) — All 15 HTTP URLs redirect to HTTPS (301). Redirects are working correctly.
14. **Sitemap Coverage Gap** (`crawl/sitemap-coverage`) — 100% of indexable pages are missing from the sitemap; 15 sitemap URLs were not crawled.

## Prioritized Recommendations

### High Priority
1. **Create a valid sitemap.xml** — Generate and serve a proper XML sitemap at `/sitemap.xml` listing all public pages. Submit to Google Search Console.
2. **Add `<main>` landmark** — Wrap page content in a `<main>` element for accessibility compliance.
3. **Add skip navigation link** — Add a "Skip to content" link at the top of each page for keyboard/screen reader users.
4. **Fix og:url tags** — Ensure `og:url` meta tags match the canonical URL on each page.

### Medium Priority
5. **Extend meta descriptions** — Update `/privacy` and `/terms` meta descriptions to 120-160 characters.
6. **Preload LCP image** — Add `<link rel="preload">` for the hero/LCP image to improve perceived load time.
7. **Self-host Google Fonts** — Eliminate render-blocking external font request by self-hosting or using `font-display: swap` with preconnect.
8. **Tighten CSP policy** — Remove `unsafe-inline` and `unsafe-eval` from Content-Security-Policy; replace wildcard in script-src with specific domains.

### Low Priority
9. **Add alt text to Facebook pixel** — Add `alt=""` to the Facebook pixel `<noscript>` image tag (decorative image).
10. **Review thin content warnings** — Verify whether the SPA renders enough content for crawlers; consider server-side rendering or pre-rendering for SEO-critical pages.

## Audit Provenance

- **CLI:** squirrelscan v0.0.38
- **Timestamp:** 2026-03-17T23:40:31.059Z
- **Command:** `squirrel audit https://www.everclub.app -C surface --format llm -o everclub-audit-report.txt`
- **Config:** `squirrel.toml` (domains: `www.everclub.app`, coverage: surface, format: llm)

## Notes

- The "thin content" warnings on all 15 pages (< 300 words) are likely false positives caused by SPA client-side rendering. The crawler may not execute JavaScript fully, so it sees minimal server-rendered HTML. Consider server-side rendering or pre-rendering for SEO-critical pages if this is confirmed.
- The "Supabase Anon Key Detected" finding is expected behavior. Supabase anonymous keys are designed to be public (they provide row-level-security-gated access), so this is not a true secret leak.

## Full Report

See `everclub-audit-report.txt` for the complete LLM-format audit output.

## Re-running the Audit

```bash
squirrel audit https://www.everclub.app -C surface --format llm -o everclub-audit-report.txt
```
