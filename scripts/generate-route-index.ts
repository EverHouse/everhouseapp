import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const ROUTES_DIR = path.join(ROOT, 'server', 'routes');
const OUTPUT = path.join(ROOT, 'docs', 'ROUTE_INDEX.md');

interface RouteEntry {
  method: string;
  path: string;
  file: string;
  line: number;
  auth: string;
  domain: string;
}

const DOMAIN_MAP: Record<string, string> = {
  'bays/bookings.ts': 'Bookings',
  'bays/approval.ts': 'Bookings',
  'bays/calendar.ts': 'Bookings',
  'bays/resources.ts': 'Bookings',
  'bays/notifications.ts': 'Bookings',
  'bays/staff-conference-booking.ts': 'Bookings',
  'roster.ts': 'Bookings',
  'availability.ts': 'Bookings',
  'staffCheckin.ts': 'Bookings',
  'nfcCheckin.ts': 'Bookings',
  'closures.ts': 'Bookings',
  'stripe/payments.ts': 'Stripe',
  'stripe/member-payments.ts': 'Stripe',
  'stripe/subscriptions.ts': 'Stripe',
  'stripe/invoices.ts': 'Stripe',
  'stripe/admin.ts': 'Stripe',
  'stripe/config.ts': 'Stripe',
  'stripe/coupons.ts': 'Stripe',
  'stripe/terminal.ts': 'Stripe',
  'trackman/webhook-index.ts': 'Trackman',
  'trackman/webhook-handlers.ts': 'Trackman',
  'trackman/webhook-billing.ts': 'Trackman',
  'trackman/import.ts': 'Trackman',
  'trackman/admin.ts': 'Trackman',
  'trackman/reconciliation.ts': 'Trackman',
  'members/dashboard.ts': 'Members',
  'members/profile.ts': 'Members',
  'members/admin-actions.ts': 'Members',
  'members/communications.ts': 'Members',
  'members/notes.ts': 'Members',
  'members/search.ts': 'Members',
  'members/visitors.ts': 'Members',
  'members/applicationPipeline.ts': 'Members',
  'members/onboarding.ts': 'Members',
  'conference/prepayment.ts': 'Conference',
  'staff/manualBooking.ts': 'Staff',
  'auth.ts': 'Auth',
  'auth-google.ts': 'Auth',
  'account.ts': 'Account',
  'checkout.ts': 'Checkout',
  'dayPasses.ts': 'Passes',
  'guestPasses.ts': 'Passes',
  'passes.ts': 'Passes',
  'events.ts': 'Events',
  'wellness.ts': 'Wellness',
  'tours.ts': 'Tours',
  'financials.ts': 'Financials',
  'memberBilling.ts': 'Billing',
  'myBilling.ts': 'Billing',
  'membershipTiers.ts': 'Tiers',
  'tierFeatures.ts': 'Tiers',
  'pricing.ts': 'Pricing',
  'groupBilling.ts': 'Billing',
  'hubspot.ts': 'HubSpot',
  'notifications.ts': 'Notifications',
  'announcements.ts': 'Content',
  'calendar.ts': 'Calendar',
  'cafe.ts': 'Content',
  'gallery.ts': 'Content',
  'faqs.ts': 'Content',
  'notices.ts': 'Content',
  'settings.ts': 'Settings',
  'dataIntegrity.ts': 'Data Tools',
  'dataExport.ts': 'Data Tools',
  'dataTools.ts': 'Data Tools',
  'bugReports.ts': 'Support',
  'inquiries.ts': 'Support',
  'training.ts': 'Staff',
  'push.ts': 'Notifications',
  'waivers.ts': 'Waivers',
  'users.ts': 'Users',
  'imageUpload.ts': 'Media',
  'idScanner.ts': 'Media',
  'resources.ts': 'Resources',
  'resendWebhooks.ts': 'Webhooks',
  'mindbody.ts': 'Data Tools',
  'testAuth.ts': 'Dev',
  'emailTemplates.ts': 'Email',
  'monitoring.ts': 'Monitoring',
};

function getDomain(relPath: string): string {
  return DOMAIN_MAP[relPath] || 'Other';
}

function detectAuth(linesBefore: string[], fullLine: string): string {
  const combined = linesBefore.join(' ') + ' ' + fullLine;
  if (/isAdmin[^O]/.test(combined) && !/isStaffOrAdmin/.test(combined)) return 'Admin';
  if (/isStaffOrAdmin/.test(combined)) return 'Staff';
  if (/isAuthenticated/.test(combined)) return 'Auth';

  if (/getSessionUser/.test(fullLine)) return 'Session';

  const routePathMatch = fullLine.match(/['"`](\/api\/auth\/|\/api\/webhooks\/|\/api\/tours\/book|\/api\/day-passes\/confirm|\/api\/availability\/batch|\/api\/hubspot\/forms)/);
  if (routePathMatch) return 'Public';

  return 'None';
}

function scanFile(filePath: string): RouteEntry[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const relPath = path.relative(ROUTES_DIR, filePath).replace(/\\/g, '/');
  const relFromRoot = path.relative(ROOT, filePath).replace(/\\/g, '/');
  const domain = getDomain(relPath);
  const entries: RouteEntry[] = [];

  const routePattern = /router\.(get|post|put|patch|delete)\s*\(\s*['"`](\/[^'"`]+)['"`]/;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(routePattern);
    if (!match) continue;

    const method = match[1].toUpperCase();
    const routePath = match[2];
    const contextLines = lines.slice(Math.max(0, i - 3), i + 1);
    const auth = detectAuth(contextLines, lines[i]);

    entries.push({
      method,
      path: routePath,
      file: relFromRoot,
      line: i + 1,
      auth,
      domain,
    });
  }

  return entries;
}

function collectRouteFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectRouteFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.startsWith('index') && entry.name !== 'helpers.ts') {
      results.push(full);
    }
  }
  return results.sort();
}

function generateMarkdown(entries: RouteEntry[]): string {
  const grouped = new Map<string, RouteEntry[]>();
  for (const e of entries) {
    const list = grouped.get(e.domain) || [];
    list.push(e);
    grouped.set(e.domain, list);
  }

  const domainOrder = [
    'Auth', 'Account', 'Members', 'Bookings', 'Stripe', 'Billing', 'Checkout',
    'Passes', 'Trackman', 'Events', 'Wellness', 'Tours', 'Calendar', 'Conference',
    'Staff', 'Tiers', 'Pricing', 'Financials', 'HubSpot', 'Notifications',
    'Content', 'Settings', 'Data Tools', 'Support', 'Waivers', 'Users',
    'Resources', 'Media', 'Email', 'Webhooks', 'Monitoring', 'Dev', 'Other',
  ];

  const sortedDomains = [...grouped.keys()].sort((a, b) => {
    const ai = domainOrder.indexOf(a);
    const bi = domainOrder.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  const lines: string[] = [
    '# Route Index',
    '',
    `> Auto-generated by \`npm run docs:routes\` — do not edit manually.`,
    `> Last generated: ${new Date().toISOString().split('T')[0]}`,
    '',
    `Total routes: **${entries.length}**`,
    '',
    '## Auth Legend',
    '',
    '| Tag | Meaning |',
    '|-----|---------|',
    '| Admin | `isAdmin` middleware — admin only |',
    '| Staff | `isStaffOrAdmin` middleware — staff or admin |',
    '| Auth | `isAuthenticated` middleware — any logged-in user |',
    '| Session | Inline `getSessionUser` check — any logged-in user |',
    '| Public | Intentionally unauthenticated |',
    '| None | No auth detected (verify manually) |',
    '',
    '---',
    '',
  ];

  for (const domain of sortedDomains) {
    const routes = grouped.get(domain)!;
    lines.push(`## ${domain}`, '');
    lines.push('| Method | Path | File | Line | Auth |');
    lines.push('|--------|------|------|------|------|');
    for (const r of routes) {
      lines.push(`| ${r.method} | \`${r.path}\` | ${r.file} | ${r.line} | ${r.auth} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

const files = collectRouteFiles(ROUTES_DIR);
const allEntries: RouteEntry[] = [];
for (const f of files) {
  allEntries.push(...scanFile(f));
}

const markdown = generateMarkdown(allEntries);
fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, markdown, 'utf-8');

// eslint-disable-next-line no-console
console.log(`✓ Generated ${OUTPUT} with ${allEntries.length} routes from ${files.length} files.`);
