# Good First Issues

These issues are perfect for first-time contributors. They're well-scoped, have clear acceptance criteria, and include implementation hints.

## 🎯 Good First Issues

### 1. Add `/sitemap` command to fetch and validate XML sitemap
**Labels**: `good first issue`, `feature`, `seo`
**Difficulty**: ⭐ Easy

**Description**: Add a new command `/sitemap <url>` that fetches `sitemap.xml`, validates it, and reports:
- Number of URLs
- Last modified dates
- Priority/changefreq distribution
- Invalid/malformed entries

**Files to touch**: `src/index.ts`, `src/audits/`, `test/`
**Hint**: Use existing `validateAndNormalizeUrl` and HTTP fetch patterns.

---

### 2. Add OpenGraph / Twitter Card validation to static audit
**Labels**: `good first issue`, `feature`, `seo`, `social`
**Difficulty**: ⭐ Easy

**Description**: Extend the static HTML audit engine to check for:
- `og:title`, `og:description`, `og:image`, `og:url`
- `twitter:card`, `twitter:title`, `twitter:description`, `twitter:image`
- Validate image URLs are accessible

**Files to touch**: `src/audits/static-html-engine.ts`, `test/audits.test.ts`

---

### 3. Add hreflang validation for international SEO
**Labels**: `good first issue`, `feature`, `seo`, `i18n`
**Difficulty**: ⭐⭐ Medium

**Description**: Check `<link rel="alternate" hreflang="x">` tags:
- Valid language/region codes (ISO 639-1 / ISO 3166-1)
- Self-referencing canonical
- Return tags (bidirectional)
- X-default presence

**Files to touch**: `src/audits/static-html-engine.ts`, `test/audits.test.ts`

---

### 4. Add Core Web Vitals thresholds configuration
**Labels**: `good first issue`, `feature`, `performance`, `container`
**Difficulty**: ⭐ Easy

**Description**: Make CWV thresholds configurable via `/deepaudit` options:
```bash
/deepaudit https://example.com --lcp-threshold=2500 --inp-threshold=200 --cls-threshold=0.1
```

**Files to touch**: `container-seomator/server.js`, `src/index.ts`

---

### 5. Add `/robots` command to fetch and analyze robots.txt
**Labels**: `good first issue`, `feature`, `seo`
**Difficulty**: ⭐ Easy

**Description**: Fetch `/robots.txt` and report:
- User-agent directives
- Disallow/Allow rules
- Sitemap declarations
- Crawl-delay
- Host directive

---

### 6. Add JSON output format for `/deepaudit`
**Labels**: `good first issue`, `feature`, `container`, `api`
**Difficulty**: ⭐ Easy

**Description**: Add `--format=json` option to `/deepaudit` for programmatic use:
```bash
/deepaudit https://example.com --format=json
```

**Files to touch**: `container-seomator/server.js`, `src/index.ts`

---

### 7. Add sitemap discovery to `/geo` crawl
**Labels**: `good first issue`, `feature`, `geo`, `seo`
**Difficulty**: ⭐⭐ Medium

**Description**: When crawling in `/geo`, also check `sitemap.xml` for additional same-origin URLs to crawl.

**Files to touch**: `src/audits/geo-links.ts`, `src/audits/geo.ts`

---

### 8. Add structured data (JSON-LD) validation details
**Labels**: `good first issue`, `feature`, `seo`, `schema`
**Difficulty**: ⭐⭐ Medium

**Description**: Extend structured data check to validate:
- Required properties per schema type
- Nested entity validity
- `@id` uniqueness
- Google Rich Results compatibility hints

**Files to touch**: `src/audits/static-html-engine.ts`

---

### 9. Add response time / TTFB measurement to static audit
**Labels**: `good first issue`, `feature`, `performance`
**Difficulty**: ⭐ Easy

**Description**: Measure and report:
- DNS lookup time
- TCP connection time
- TLS handshake time
- TTFB (Time to First Byte)
- Content download time

**Files to touch**: `src/audits/static-html-engine.ts`, `src/url-validation.ts`

---

### 10. Add Docker health check to Container
**Labels**: `good first issue`, `devops`, `container`
**Difficulty**: ⭐ Easy

**Description**: Add `HEALTHCHECK` to `container-seomator/Dockerfile`:
```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s \
  CMD curl -f http://localhost:3000/health || exit 1
```

---

## How to Claim an Issue

1. Comment on the issue: "I'll take this one!"
2. Fork the repo, create a branch: `git checkout -b feat/issue-XX-description`
3. Make changes, run `npm run check`
4. Open PR referencing the issue: `Closes #XX`

---

**Want more?** Check the [issue tracker](https://github.com/karefined-eng/kaseobot/issues) or start a [Discussion](https://github.com/karefined-eng/kaseobot/discussions) for new ideas.