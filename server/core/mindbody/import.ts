import { db } from "../../db";
import { users, legacyPurchases, legacyImportJobs } from "@shared/schema";
import { eq, sql, and } from "drizzle-orm";
import fs from "fs";
import path from "path";

const isProduction = process.env.NODE_ENV === 'production';

// Tier name mapping: Mindbody tier names → normalized tier names
const TIER_MAPPING: Record<string, string | null> = {
  'core membership': 'core',
  'core membership founding members': 'core',
  'premium membership': 'premium',
  'premium membership founding members': 'premium',
  'social membership': 'social',
  'social membership founding members': 'social',
  'vip membership': 'vip',
  'corporate membership': 'corporate',
  'group lessons membership': 'group_lessons',
  'approved pre sale clients': null, // No tier - these should be null
};

// Item category mapping: Mindbody item names → categories
const ITEM_CATEGORY_MAPPING: Record<string, string> = {
  'guest day pass': 'guest_pass',
  'guest simulator fee': 'guest_sim_fee',
  'simulator walk-in': 'sim_walk_in',
  'simulator add-on 30 minutes': 'sim_add_on',
  'core membership': 'membership',
  'core membership founding members': 'membership',
  'premium membership': 'membership',
  'premium membership founding members': 'membership',
  'social membership': 'membership',
  'social membership founding members': 'membership',
  'vip membership': 'membership',
  'corporate membership': 'membership',
  'group lessons membership': 'lesson',
  'daily 30/60 min golf simulator booking': 'sim_booking',
  'daily 30/60/90 min golf simulator booking': 'sim_booking',
  'daily 60 min conference room booking': 'conf_room',
  'daily 30 min conference room booking': 'conf_room',
  'priority access and booking': 'membership_perk',
  'approved pre sale clients': 'presale',
  'private tour of even house': 'tour',
  '30 minute member assessment': 'assessment',
};

// Payment method normalization
function normalizePaymentMethod(method: string | undefined): string {
  if (!method) return 'unknown';
  const lower = method.toLowerCase();
  if (lower.includes('amex')) return 'amex';
  if (lower.includes('visa') || lower.includes('mc') || lower.includes('mastercard')) return 'credit_card';
  if (lower.includes('cash')) return 'cash';
  if (lower.includes('comp') || lower.includes('misc')) return 'comp';
  return 'other';
}

// Normalize tier name from Mindbody
function normalizeTierName(mbTier: string | undefined): string | null {
  if (!mbTier) return null;
  const lower = mbTier.toLowerCase().trim();
  return TIER_MAPPING[lower] !== undefined ? TIER_MAPPING[lower] : mbTier.toLowerCase();
}

// Get item category from item name
function getItemCategory(itemName: string): string {
  const lower = itemName.toLowerCase().trim();
  for (const [pattern, category] of Object.entries(ITEM_CATEGORY_MAPPING)) {
    if (lower.includes(pattern)) {
      return category;
    }
  }
  return 'other';
}

// Parse dollar amount to cents
function dollarsToCents(dollarStr: string | undefined): number {
  if (!dollarStr) return 0;
  const cleaned = dollarStr.replace(/[$,()]/g, '').trim();
  if (!cleaned || cleaned === '---') return 0;
  const amount = parseFloat(cleaned);
  return isNaN(amount) ? 0 : Math.round(amount * 100);
}

// Parse date string to Date object
function parseDate(dateStr: string | undefined): Date | null {
  if (!dateStr) return null;
  // Handle MM/DD/YYYY format
  const parts = dateStr.split('/');
  if (parts.length === 3) {
    const month = parseInt(parts[0]) - 1;
    const day = parseInt(parts[1]);
    const year = parseInt(parts[2]);
    return new Date(year, month, day);
  }
  return new Date(dateStr);
}

// Parse CSV line handling quoted fields
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

interface MemberImportRow {
  barcodeId: string;
  clientName: string;
  status: string;
  membershipTier: string;
  phone: string;
  email: string;
  joinedOn: string;
  lifetimeSales: string;
}

interface SalesImportRow {
  saleDate: string;
  clientId: string;
  client: string;
  saleId: string;
  itemName: string;
  itemPrice: string;
  quantity: string;
  subtotal: string;
  discountPercent: string;
  discountAmount: string;
  tax: string;
  itemTotal: string;
  paymentMethod: string;
}

interface AttendanceImportRow {
  client: string;
  id: string;
  totalVisits: string;
}

// Import members from CSV
export async function importMembersFromCSV(csvPath: string): Promise<{
  total: number;
  matched: number;
  updated: number;
  skipped: number;
  errors: string[];
}> {
  const result = { total: 0, matched: 0, updated: 0, skipped: 0, errors: [] as string[] };
  
  const content = fs.readFileSync(csvPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  
  // Skip header row
  const header = parseCSVLine(lines[0]);
  const headerMap: Record<string, number> = {};
  header.forEach((h, i) => headerMap[h.toLowerCase().replace(/\s+/g, '')] = i);
  
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    result.total++;
    
    try {
      const row: MemberImportRow = {
        barcodeId: fields[headerMap['barcodeid']] || '',
        clientName: fields[headerMap['clientname']] || '',
        status: fields[headerMap['status']] || '',
        membershipTier: fields[headerMap['membershiptier']] || '',
        phone: fields[headerMap['phone']] || '',
        email: fields[headerMap['emailaddress']] || '',
        joinedOn: fields[headerMap['joinedon']] || '',
        lifetimeSales: fields[headerMap['lifetimesales']] || '',
      };
      
      if (!row.barcodeId) {
        result.skipped++;
        continue;
      }
      
      // Find existing user by mindbody_client_id
      const existingUsers = await db.select().from(users)
        .where(eq(users.mindbodyClientId, row.barcodeId))
        .limit(1);
      
      const normalizedTier = normalizeTierName(row.membershipTier);
      const joinDate = parseDate(row.joinedOn);
      
      if (existingUsers.length > 0) {
        result.matched++;
        
        // Update existing user with Mindbody data
        await db.update(users)
          .set({
            memberSince: joinDate,
            legacySource: 'mindbody_import',
            tier: normalizedTier || existingUsers[0].tier,
            membershipStatus: row.status.toLowerCase() || existingUsers[0].membershipStatus,
            updatedAt: new Date(),
          })
          .where(eq(users.mindbodyClientId, row.barcodeId));
        
        result.updated++;
      } else {
        // Try matching by email
        if (row.email) {
          const emailMatch = await db.select().from(users)
            .where(eq(users.email, row.email.toLowerCase()))
            .limit(1);
          
          if (emailMatch.length > 0) {
            result.matched++;
            
            await db.update(users)
              .set({
                mindbodyClientId: row.barcodeId,
                memberSince: joinDate,
                legacySource: 'mindbody_import',
                tier: normalizedTier || emailMatch[0].tier,
                membershipStatus: row.status.toLowerCase() || emailMatch[0].membershipStatus,
                updatedAt: new Date(),
              })
              .where(eq(users.email, row.email.toLowerCase()));
            
            result.updated++;
          } else {
            result.skipped++;
            if (!isProduction) {
              result.errors.push(`No match for: ${row.clientName} (${row.barcodeId}, ${row.email})`);
            }
          }
        } else {
          result.skipped++;
        }
      }
    } catch (error) {
      result.errors.push(`Row ${i}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  return result;
}

// Import sales from CSV
export async function importSalesFromCSV(csvPath: string, batchId?: string): Promise<{
  total: number;
  imported: number;
  skipped: number;
  linked: number;
  errors: string[];
}> {
  const result = { total: 0, imported: 0, skipped: 0, linked: 0, errors: [] as string[] };
  const importBatchId = batchId || `import_${Date.now()}`;
  
  const content = fs.readFileSync(csvPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  
  // Parse header
  const header = parseCSVLine(lines[0]);
  const headerMap: Record<string, number> = {};
  header.forEach((h, i) => headerMap[h.toLowerCase().replace(/\s+/g, '')] = i);
  
  // Track line numbers per sale_id for unique constraint
  const saleLineNumbers: Map<string, number> = new Map();
  
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    result.total++;
    
    try {
      const saleId = fields[headerMap['saleid']] || '';
      const clientId = fields[headerMap['clientid']] || '';
      const itemName = fields[headerMap['itemname']] || '';
      
      if (!saleId || !clientId || !itemName) {
        result.skipped++;
        continue;
      }
      
      // Get next line number for this sale
      const currentLineNum = (saleLineNumbers.get(saleId) || 0) + 1;
      saleLineNumbers.set(saleId, currentLineNum);
      
      // Find member by mindbody_client_id
      const member = await db.select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.mindbodyClientId, clientId))
        .limit(1);
      
      const itemPriceCents = dollarsToCents(fields[headerMap['itemprice']]);
      const quantity = parseInt(fields[headerMap['quantity']] || '1') || 1;
      const subtotalCents = dollarsToCents(fields[headerMap['subtotal']]);
      const discountPercent = parseFloat(fields[headerMap['discount%']] || '0') || 0;
      const discountAmountCents = dollarsToCents(fields[headerMap['discountamount']]);
      const taxCents = dollarsToCents(fields[headerMap['tax']]);
      const itemTotalCents = dollarsToCents(fields[headerMap['itemtotal']]);
      const saleDate = parseDate(fields[headerMap['saledate']]);
      const paymentMethod = normalizePaymentMethod(fields[headerMap['paymentmethod']]);
      
      if (!saleDate) {
        result.skipped++;
        result.errors.push(`Row ${i}: Invalid sale date`);
        continue;
      }
      
      // Check for duplicate
      const existing = await db.select({ id: legacyPurchases.id })
        .from(legacyPurchases)
        .where(and(
          eq(legacyPurchases.mindbodySaleId, saleId),
          eq(legacyPurchases.lineNumber, currentLineNum)
        ))
        .limit(1);
      
      if (existing.length > 0) {
        result.skipped++;
        continue;
      }
      
      // Insert purchase
      await db.insert(legacyPurchases).values({
        userId: member[0]?.id || null,
        mindbodyClientId: clientId,
        memberEmail: member[0]?.email || null,
        mindbodySaleId: saleId,
        lineNumber: currentLineNum,
        itemName,
        itemCategory: getItemCategory(itemName),
        itemPriceCents,
        quantity,
        subtotalCents,
        discountPercent: discountPercent.toString(),
        discountAmountCents,
        taxCents,
        itemTotalCents,
        paymentMethod,
        saleDate,
        isComp: itemTotalCents === 0,
        importBatchId,
      });
      
      result.imported++;
      
      // If this is a guest-related charge, try to link to a booking session
      const category = getItemCategory(itemName);
      if (['guest_pass', 'guest_sim_fee'].includes(category) && member[0]?.id) {
        result.linked++;
      }
    } catch (error) {
      result.errors.push(`Row ${i}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  return result;
}

// Import attendance from CSV
export async function importAttendanceFromCSV(csvPath: string): Promise<{
  total: number;
  updated: number;
  skipped: number;
  errors: string[];
}> {
  const result = { total: 0, updated: 0, skipped: 0, errors: [] as string[] };
  
  const content = fs.readFileSync(csvPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  
  // Parse header
  const header = parseCSVLine(lines[0]);
  const headerMap: Record<string, number> = {};
  header.forEach((h, i) => headerMap[h.toLowerCase().replace(/\s+/g, '')] = i);
  
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    result.total++;
    
    try {
      const clientId = fields[headerMap['id']] || '';
      const totalVisits = parseInt(fields[headerMap['totalvisits']] || '0') || 0;
      
      if (!clientId) {
        result.skipped++;
        continue;
      }
      
      // Update user's lifetime visits
      const updated = await db.update(users)
        .set({
          lifetimeVisits: totalVisits,
          updatedAt: new Date(),
        })
        .where(eq(users.mindbodyClientId, clientId));
      
      result.updated++;
    } catch (error) {
      result.errors.push(`Row ${i}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  return result;
}

// Full import orchestrator
export async function runFullMindbodyImport(
  membersCSV: string,
  salesCSV: string,
  attendanceCSV: string
): Promise<{
  members: Awaited<ReturnType<typeof importMembersFromCSV>>;
  sales: Awaited<ReturnType<typeof importSalesFromCSV>>;
  attendance: Awaited<ReturnType<typeof importAttendanceFromCSV>>;
}> {
  console.log('[MindbodyImport] Starting full import...');
  
  const batchId = `full_import_${Date.now()}`;
  
  // Create import job record
  await db.insert(legacyImportJobs).values({
    jobType: 'full_import',
    fileName: `${membersCSV}, ${salesCSV}, ${attendanceCSV}`,
    status: 'running',
    startedAt: new Date(),
  });
  
  // Step 1: Import members first (to establish mindbody_client_id links)
  console.log('[MindbodyImport] Importing members...');
  const membersResult = await importMembersFromCSV(membersCSV);
  console.log(`[MindbodyImport] Members: ${membersResult.matched} matched, ${membersResult.updated} updated, ${membersResult.skipped} skipped`);
  
  // Step 2: Import sales
  console.log('[MindbodyImport] Importing sales...');
  const salesResult = await importSalesFromCSV(salesCSV, batchId);
  console.log(`[MindbodyImport] Sales: ${salesResult.imported} imported, ${salesResult.skipped} skipped, ${salesResult.linked} guest-related`);
  
  // Step 3: Import attendance
  console.log('[MindbodyImport] Importing attendance...');
  const attendanceResult = await importAttendanceFromCSV(attendanceCSV);
  console.log(`[MindbodyImport] Attendance: ${attendanceResult.updated} updated, ${attendanceResult.skipped} skipped`);
  
  console.log('[MindbodyImport] Import complete!');
  
  return {
    members: membersResult,
    sales: salesResult,
    attendance: attendanceResult,
  };
}
