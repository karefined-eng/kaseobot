/**
 * SEOmator Container Server
 * Matches seomator.com free SEO/GEO audit options — granular categories, configurable
 */

import { createServer } from 'node:http';
import { audit } from '@seomator/seo-audit';

const PORT = process.env.PORT || 3000;

// SEOmator category mapping (matches seomator.com free audit options)
const AUDIT_CATEGORIES = {
  // Core SEO audits
  'technical': 'Technical SEO',
  'content': 'Content Quality',
  'performance': 'Performance / Core Web Vitals',
  'links': 'Links & Authority',
  'images': 'Image Optimization',
  'security': 'Security & Trust',
  'mobile': 'Mobile Usability',
  'accessibility': 'Accessibility (a11y)',
  'structured-data': 'Structured Data / Schema',
  'social': 'Social & Open Graph',
  'eeat': 'E-E-A-T / Trust Signals',
  'url-structure': 'URL Structure',
  'internationalization': 'Internationalization (i18n)',
  'legal': 'Legal Compliance',
  'javascript': 'JavaScript Rendering',
  'redirects': 'Redirects & Canonicals',
  'html-validation': 'HTML Validation',
  'crawlability': 'Crawlability & Indexing',
  'ai-geo': 'AI / GEO Readiness',

  // Special combined audits
  'seo-full': 'Full SEO Audit (all categories)',
  'geo': 'GEO / AI Search Readiness',
  'quick': 'Quick Scan (critical only)',
};

function parseCategories(input) {
  if (!input || input === 'all' || input === 'seo-full') {
    return Object.keys(AUDIT_CATEGORIES).filter(k => !['seo-full', 'geo', 'quick'].includes(k));
  }
  if (input === 'geo') {
    return ['ai-geo', 'structured-data', 'content', 'eeat', 'crawlability'];
  }
  if (input === 'quick') {
    return ['technical', 'content', 'security', 'crawlability'];
  }
  if (Array.isArray(input)) {
    return input.filter(c => AUDIT_CATEGORIES[c]).map(c => c.toLowerCase());
  }
  if (typeof input === 'string') {
    return input.split(',').map(c => c.trim().toLowerCase()).filter(c => AUDIT_CATEGORIES[c]);
  }
  return ['technical', 'content', 'performance', 'links', 'images', 'security', 'mobile'];
}

function buildMarkdownReport(result, url, options) {
  const lines = [
    `# ${options.auditType === 'geo' ? 'GEO / AI Readiness' : 'SEO'} Audit Report`,
    `**Target:** ${url}`,
    `**Audit Type:** ${options.auditType || 'seo-full'}`,
    `**Categories:** ${options.categories?.join(', ') || 'all'}`,
    `**Score:** ${result.score || 'N/A'}/100 (${result.grade || 'N/A'})`,
    `**Pages Crawled:** ${result.pages || 1}`,
    `**Generated:** ${new Date().toISOString()}`,
    '',
    '---',
    ''
  ];

  // Summary table
  if (result.categories) {
    lines.push('## 📊 Category Scores');
    lines.push('');
    lines.push('| Category | Score | Passed | Warnings | Failed | Not Measured |');
    lines.push('|----------|-------|--------|----------|--------|--------------|');

    for (const [cat, data] of Object.entries(result.categories)) {
      const label = AUDIT_CATEGORIES[cat] || cat;
      const score = data.score !== undefined ? data.score : 'N/A';
      const passed = data.passed || 0;
      const warnings = data.warnings || 0;
      const failed = data.failed || 0;
      const notMeasured = data.notMeasured || 0;
      lines.push(`| ${label} | ${score} | ${passed} | ${warnings} | ${failed} | ${notMeasured} |`);
    }
    lines.push('');
  }

  // Failed/Warning findings - grouped by category
  if (result.details) {
    lines.push('## 🔍 Findings Requiring Action');
    lines.push('');

    let hasFindings = false;
    for (const [cat, checks] of Object.entries(result.details)) {
      const relevant = checks.filter(c => c.status === 'fail' || c.status === 'warning');
      if (relevant.length === 0) continue;

      hasFindings = true;
      const label = AUDIT_CATEGORIES[cat] || cat;
      lines.push(`### ${label}`);
      lines.push('');

      for (const check of relevant) {
        const icon = check.status === 'fail' ? '❌' : '⚠️';
        lines.push(`- ${icon} **${check.title}**`);
        if (check.description) lines.push(`  ${check.description}`);
        if (check.recommendation) lines.push(`  💡 **Fix:** ${check.recommendation}`);
        if (check.impact) lines.push(`  📈 **Impact:** ${check.impact}`);
      }
      lines.push('');
    }

    if (!hasFindings) {
      lines.push('*No critical issues found in selected categories.*');
      lines.push('');
    }
  }

  // Priority action plan for agent
  const priorities = [];
  if (result.details) {
    for (const [cat, checks] of Object.entries(result.details)) {
      for (const check of checks) {
        if (check.status === 'fail' && check.recommendation) {
          priorities.push({
            category: AUDIT_CATEGORIES[cat] || cat,
            title: check.title,
            recommendation: check.recommendation,
            impact: check.impact || 'High'
          });
        }
      }
    }
  }

  if (priorities.length > 0) {
    lines.push('## 🎯 Priority Action Plan (for Agent)');
    lines.push('');
    lines.push('*Execute in order. Each item is a discrete, verifiable task.*');
    lines.push('');

    priorities.slice(0, 15).forEach((action, i) => {
      lines.push(`${i + 1}. **[${action.category}]** ${action.title}`);
      lines.push(`   **Impact:** ${action.impact}`);
      lines.push(`   **Action:** ${action.recommendation}`);
      lines.push('');
    });
  }

  // Raw JSON reference (collapsed)
  lines.push('---');
  lines.push('');
  lines.push('<details>');
  lines.push('<summary>🔧 Raw JSON (for debugging)</summary>');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(result, null, 2));
  lines.push('```');
  lines.push('</details>');

  return lines.join('\n');
}

function buildOptions(reqBody) {
  const {
    url,
    auditType = 'seo-full',           // 'seo-full' | 'geo' | 'quick' | 'custom'
    categories,                       // array or comma-separated string
    crawl = false,                    // multi-page crawl
    maxPages = 5,                     // max pages when crawling
    concurrency = 3,                  // concurrent requests
    timeout = 180000,                 // ms (3 min for full audit)
    mobile = false,                   // mobile viewport
    simulateInteraction = false,      // INP measurement
    noCwv = true,                     // skip Core Web Vitals (saves time)
    userAgent,                        // custom UA
    cookies,                          // auth cookies
    headers,                          // custom headers
    javascript = true,                // enable JS rendering
    waitForSelector,                  // wait for specific element
  } = reqBody;

  const selectedCategories = parseCategories(auditType === 'custom' ? categories : auditType);

  return {
    auditType,
    categories: selectedCategories,
    crawl,
    maxPages: Math.min(Math.max(1, maxPages), 50),
    concurrency: Math.min(Math.max(1, concurrency), 10),
    timeout: Math.min(Math.max(30000, timeout), 300000),
    mobile,
    simulateInteraction,
    noCwv,
    javascript,
    userAgent,
    cookies,
    headers,
    waitForSelector,
  };
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'seomator-container', version: '1.0.0' }));
    return;
  }

  // Categories reference
  if (req.method === 'GET' && req.url === '/categories') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      categories: AUDIT_CATEGORIES,
      presets: {
        'seo-full': 'All SEO categories',
        'geo': 'GEO/AI readiness (structured-data, content, eeat, crawlability, ai-geo)',
        'quick': 'Critical only (technical, content, security, crawlability)',
      }
    }));
    return;
  }

  if (req.method !== 'POST' || req.url !== '/audit') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. POST /audit or GET /categories' }));
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    let input;
    try {
      input = JSON.parse(body || '{}');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    if (!input.url || typeof input.url !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or invalid url' }));
      return;
    }

    const options = buildOptions(input);
    const startTime = Date.now();

    try {
      console.log(`[${new Date().toISOString()}] ${options.auditType.toUpperCase()} audit: ${input.url} [${options.categories.join(', ')}]`);

      const result = await audit(input.url, {
        format: 'json',
        categories: options.categories,
        crawl: options.crawl,
        maxPages: options.maxPages,
        concurrency: options.concurrency,
        timeout: options.timeout,
        mobile: options.mobile,
        simulateInteraction: options.simulateInteraction,
        noCwv: options.noCwv,
        javascript: options.javascript,
        userAgent: options.userAgent,
        cookies: options.cookies,
        headers: options.headers,
        waitForSelector: options.waitForSelector,
      });

      const markdown = buildMarkdownReport(result, input.url, options);

      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'X-Audit-Duration-Ms': String(Date.now() - startTime),
        'X-Audit-Type': options.auditType,
        'X-Categories': options.categories.join(','),
      });
      res.end(markdown);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Audit error:`, err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'Audit failed',
        message: err.message,
        stack: err.stack
      }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] SEOmator container listening on port ${PORT}`);
  console.log(`Available categories: ${Object.keys(AUDIT_CATEGORIES).join(', ')}`);
});

process.on('SIGTERM', () => {
  console.log(`[${new Date().toISOString()}] SIGTERM received, shutting down`);
  server.close(() => process.exit(0));
});