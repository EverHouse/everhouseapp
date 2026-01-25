import { Router, Request, Response } from "express";
import { db } from "../db";
import { pool } from "../core/db";
import { legacyPurchases, users, legacyImportJobs, hubspotDeals, hubspotProductMappings, hubspotLineItems } from "@shared/schema";
import { eq, desc, and, sql, gte, lte } from "drizzle-orm";
import { isStaffOrAdmin, isAdmin } from "../core/middleware";
import { importMembersFromCSV, importSalesFromCSV, importAttendanceFromCSV, importFirstVisitReport, importSalesFromContent, parseFirstVisitReport } from "../core/mindbody/import";
import { createDealForLegacyMember } from "../core/hubspotDeals";
import { getHubSpotClient } from "../core/integrations";
import { retryableHubSpotRequest } from "../core/hubspot/request";
import { listCustomerInvoices } from "../core/stripe/invoices";
import { getStripeClient } from "../core/stripe/client";
import { getSessionUser } from "../types/session";
import path from "path";
import { normalizeTierName as normalizeTierNameUtil, normalizeTierSlug } from '../utils/tierUtils';
import multer from 'multer';
import { logFromRequest } from '../core/auditLog';

// Configure multer for memory storage (CSV files are small)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  }
});

interface UnifiedPurchase {
  id: string;
  type: 'legacy' | 'stripe';
  itemName: string;
  itemCategory: string | null;
  amountCents: number;
  date: string;
  status: string;
  source: string;
  quantity?: number;
}

const router = Router();

// Get purchases for a member (staff view)
router.get("/api/legacy-purchases/member/:email", isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { email } = req.params;
    
    const purchases = await db.select()
      .from(legacyPurchases)
      .where(eq(legacyPurchases.memberEmail, email.toLowerCase()))
      .orderBy(desc(legacyPurchases.saleDate));
    
    // Convert cents to dollars for display
    const formattedPurchases = purchases.map(p => ({
      ...p,
      itemPrice: (p.itemPriceCents / 100).toFixed(2),
      subtotal: (p.subtotalCents / 100).toFixed(2),
      discountAmount: ((p.discountAmountCents || 0) / 100).toFixed(2),
      tax: ((p.taxCents || 0) / 100).toFixed(2),
      itemTotal: (p.itemTotalCents / 100).toFixed(2),
      salePriceCents: p.itemTotalCents,
    }));
    
    res.json(formattedPurchases);
  } catch (error) {
    console.error("[LegacyPurchases] Error fetching purchases:", error);
    res.status(500).json({ error: "Failed to fetch purchases" });
  }
});

// Get purchases for current member (member view)
// Supports ?user_email param for "View As" feature when staff views as another member
router.get("/api/legacy-purchases/my-purchases", async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    const sessionEmail = sessionUser?.email;
    if (!sessionEmail) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    
    // Support "View As" feature: staff can pass user_email param to view as another member
    const requestedEmail = req.query.user_email as string | undefined;
    let targetEmail = sessionEmail;
    
    if (requestedEmail && requestedEmail.toLowerCase() !== sessionEmail.toLowerCase()) {
      // Only staff/admin can view other members' purchases
      const userRole = sessionUser?.role;
      if (userRole === 'admin' || userRole === 'staff') {
        targetEmail = decodeURIComponent(requestedEmail);
      }
    }
    
    const purchases = await db.select()
      .from(legacyPurchases)
      .where(eq(legacyPurchases.memberEmail, targetEmail.toLowerCase()))
      .orderBy(desc(legacyPurchases.saleDate));
    
    // Convert cents to dollars for display and filter sensitive fields
    const formattedPurchases = purchases.map(p => ({
      id: p.id,
      itemName: p.itemName,
      itemCategory: p.itemCategory,
      itemTotal: (p.itemTotalCents / 100).toFixed(2),
      salePriceCents: p.itemTotalCents,
      saleDate: p.saleDate,
      isComp: p.isComp,
      quantity: p.quantity || 1,
      staffName: p.staffName || null,
    }));
    
    console.log(`[LegacyPurchases] my-purchases for ${targetEmail}: found ${formattedPurchases.length} purchases`);
    res.json(formattedPurchases);
  } catch (error) {
    console.error("[LegacyPurchases] Error fetching my purchases:", error);
    res.status(500).json({ error: "Failed to fetch purchases" });
  }
});

// Helper to clean up Stripe descriptions and show user-friendly names
function cleanStripeDescription(description: string | null | undefined, purpose?: string): string {
  if (!description) {
    // Default friendly names based on purpose
    const purposeLabels: Record<string, string> = {
      'guest_fee': 'Guest Fee',
      'overage_fee': 'Simulator Overage Fee',
      'one_time_purchase': 'Purchase',
      'add_funds': 'Account Balance Top-Up',
      'subscription': 'Membership Subscription',
      'invoice': 'Invoice Payment',
    };
    return purposeLabels[purpose || ''] || 'Payment';
  }
  
  // Check for raw Stripe IDs and replace with friendly names
  if (description.startsWith('cs_') || description.startsWith('pi_') || 
      description.startsWith('in_') || description.startsWith('sub_')) {
    const purposeLabels: Record<string, string> = {
      'guest_fee': 'Guest Fee',
      'overage_fee': 'Simulator Overage Fee',
      'one_time_purchase': 'Purchase',
      'add_funds': 'Account Balance Top-Up',
      'subscription': 'Membership Subscription',
    };
    return purposeLabels[purpose || ''] || 'Payment';
  }
  
  // Clean up common patterns
  const lowerDesc = description.toLowerCase();
  if (lowerDesc.includes('top-up') || lowerDesc.includes('topup') || 
      lowerDesc.includes('add funds') || lowerDesc.includes('account balance')) {
    return 'Account Balance Top-Up';
  }
  if (lowerDesc.includes('guest fee')) {
    return 'Guest Fee';
  }
  // Preserve guest pass quantity info (e.g., "3 Guest Passes")
  if (lowerDesc.includes('guest pass')) {
    const match = description.match(/^(\d+)\s*guest\s*pass/i);
    if (match) {
      const qty = parseInt(match[1]);
      return qty > 1 ? `${qty} Guest Passes` : 'Guest Pass';
    }
    return 'Guest Pass';
  }
  if (lowerDesc.includes('overage') || lowerDesc.includes('simulator')) {
    return 'Simulator Overage Fee';
  }
  if (lowerDesc.includes('subscription') || lowerDesc.includes('membership')) {
    return 'Membership Payment';
  }
  
  // Return original if it looks like a real description
  return description;
}

// Helper to safely format dates that may be Date objects or strings
function safeToISOString(value: Date | string | null | undefined): string {
  if (!value) return '';
  if (typeof value === 'string' && value.trim() === '') return '';
  try {
    if (value instanceof Date) {
      return isNaN(value.getTime()) ? '' : value.toISOString();
    }
    const parsed = new Date(value);
    return isNaN(parsed.getTime()) ? '' : parsed.toISOString();
  } catch {
    return '';
  }
}

// Helper function to fetch unified purchases for an email
async function getUnifiedPurchasesForEmail(email: string): Promise<UnifiedPurchase[]> {
  const normalizedEmail = email.toLowerCase();
  
  // Get user info for stripe_customer_id
  const userResult = await db.select({
    id: users.id,
    stripeCustomerId: users.stripeCustomerId
  })
    .from(users)
    .where(eq(users.email, normalizedEmail))
    .limit(1);
  
  const userInfo = userResult[0];
  
  // Get legacy purchases
  const legacyResult = await db.select()
    .from(legacyPurchases)
    .where(eq(legacyPurchases.memberEmail, normalizedEmail))
    .orderBy(desc(legacyPurchases.saleDate));
  
  // Map legacy purchases to unified format
  const unifiedLegacy: UnifiedPurchase[] = legacyResult.map(p => {
    // Determine source - guest passes created in-app should show "Even House"
    const source = p.paymentMethod === 'guest_pass' ? 'Even House' : 'Mindbody';
    
    return {
      id: `legacy-${p.id}`,
      type: 'legacy' as const,
      itemName: p.itemName,
      itemCategory: p.itemCategory,
      amountCents: p.itemTotalCents,
      date: safeToISOString(p.saleDate),
      status: p.isComp ? 'comp' : 'paid',
      source,
      quantity: p.quantity || 1,
    };
  });
  
  // Get Stripe invoices if customer exists
  let unifiedStripeInvoices: UnifiedPurchase[] = [];
  
  if (userInfo?.stripeCustomerId) {
    const invoiceResult = await listCustomerInvoices(userInfo.stripeCustomerId);
    
    if (invoiceResult.success && invoiceResult.invoices) {
      unifiedStripeInvoices = invoiceResult.invoices.map(inv => {
        // Get raw description from invoice or line items
        const rawDescription = inv.description || inv.lines.map(l => l.description).filter(Boolean).join(', ');
        
        return {
          id: `stripe-${inv.id}`,
          type: 'stripe' as const,
          itemName: cleanStripeDescription(rawDescription, 'invoice'),
          itemCategory: 'invoice',
          amountCents: inv.amountPaid || inv.amountDue,
          date: safeToISOString(inv.paidAt) || safeToISOString(inv.created),
          status: inv.status,
          source: 'Stripe',
          hostedInvoiceUrl: inv.hostedInvoiceUrl,
          stripeInvoiceId: inv.id,
        };
      });
    }
  }
  
  // Get Stripe Payment Intents (quick charges, guest fees)
  let unifiedPaymentIntents: UnifiedPurchase[] = [];
  
  if (userInfo?.id) {
    const paymentIntentsResult = await pool.query(
      `SELECT * FROM stripe_payment_intents 
       WHERE (user_id = $1 OR user_id = $2)
       AND status = 'succeeded'
       ORDER BY created_at DESC`,
      [userInfo.id, normalizedEmail]
    );
    
    unifiedPaymentIntents = paymentIntentsResult.rows.map((record: any) => ({
      id: `payment-${record.id}`,
      type: 'stripe' as const,
      itemName: cleanStripeDescription(record.description, record.purpose),
      itemCategory: record.purpose,
      amountCents: record.amount_cents,
      date: safeToISOString(record.created_at),
      status: 'paid',
      source: 'Stripe',
    }));
  }
  
  // Get Cash/Check Payments from billing_audit_log
  let unifiedCashCheckPayments: UnifiedPurchase[] = [];
  
  const cashCheckResult = await pool.query(
    `SELECT * FROM billing_audit_log 
     WHERE member_email = $1 
     AND action_type IN ('cash_payment_recorded', 'check_payment_recorded', 'cash_check_recorded')
     ORDER BY created_at DESC`,
    [normalizedEmail]
  );
  
  unifiedCashCheckPayments = cashCheckResult.rows.map((record: any) => {
    const actionDetails = record.action_details || {};
    const paymentMethod = actionDetails.paymentMethod || actionDetails.payment_method || 'cash';
    
    return {
      id: `cash-${record.id}`,
      type: 'legacy' as const,
      itemName: actionDetails.description || 'Cash/Check Payment',
      itemCategory: 'payment',
      amountCents: actionDetails.amountCents || actionDetails.amount_cents || 0,
      date: safeToISOString(record.created_at),
      status: 'paid',
      source: paymentMethod === 'check' ? 'Check' : 'Cash',
    };
  });
  
  // Get Stripe Balance Transactions (credits from add_funds, etc.)
  let unifiedBalanceTransactions: UnifiedPurchase[] = [];
  
  if (userInfo?.stripeCustomerId) {
    try {
      const stripe = await getStripeClient();
      const balanceTransactions = await stripe.customers.listBalanceTransactions(
        userInfo.stripeCustomerId,
        { limit: 50 }
      );
      
      // Only show credit transactions (negative amounts = credits in Stripe)
      unifiedBalanceTransactions = balanceTransactions.data
        .filter(txn => txn.amount < 0) // Credits have negative amounts
        .map(txn => ({
          id: `balance-${txn.id}`,
          type: 'stripe' as const,
          itemName: cleanStripeDescription(txn.description, 'add_funds'),
          itemCategory: 'add_funds',
          amountCents: Math.abs(txn.amount),
          date: new Date(txn.created * 1000).toISOString(),
          status: 'paid',
          source: 'Stripe',
        }));
    } catch (balanceError) {
      console.error('[UnifiedPurchases] Error fetching balance transactions:', balanceError);
    }
  }
  
  // Combine and sort by date descending (items with invalid/empty dates go to end)
  const combined = [...unifiedLegacy, ...unifiedStripeInvoices, ...unifiedPaymentIntents, ...unifiedCashCheckPayments, ...unifiedBalanceTransactions];
  combined.sort((a, b) => {
    const dateA = a.date ? new Date(a.date).getTime() : 0;
    const dateB = b.date ? new Date(b.date).getTime() : 0;
    // Handle invalid dates (NaN) by pushing them to the end
    const validA = !isNaN(dateA) && dateA > 0;
    const validB = !isNaN(dateB) && dateB > 0;
    if (!validA && !validB) return 0;
    if (!validA) return 1; // a goes after b
    if (!validB) return -1; // b goes after a
    return dateB - dateA; // descending order
  });
  
  return combined;
}

// Get unified purchases for a member (staff view)
router.get("/api/members/:email/unified-purchases", isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { email } = req.params;
    const purchases = await getUnifiedPurchasesForEmail(email);
    
    console.log(`[UnifiedPurchases] staff view for ${email}: found ${purchases.length} purchases`);
    res.json(purchases);
  } catch (error) {
    console.error("[UnifiedPurchases] Error fetching unified purchases:", error);
    res.status(500).json({ error: "Failed to fetch unified purchases" });
  }
});

// Get unified purchases for current member (member view)
// Supports ?user_email param for "View As" feature when staff views as another member
router.get("/api/my-unified-purchases", async (req: Request, res: Response) => {
  try {
    const sessionUser = getSessionUser(req);
    const sessionEmail = sessionUser?.email;
    if (!sessionEmail) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    
    // Support "View As" feature: staff can pass user_email param to view as another member
    const requestedEmail = req.query.user_email as string | undefined;
    let targetEmail = sessionEmail;
    
    if (requestedEmail && requestedEmail.toLowerCase() !== sessionEmail.toLowerCase()) {
      const userRole = sessionUser?.role;
      if (userRole === 'admin' || userRole === 'staff') {
        targetEmail = decodeURIComponent(requestedEmail);
      }
    }
    
    const purchases = await getUnifiedPurchasesForEmail(targetEmail);
    
    console.log(`[UnifiedPurchases] my-unified-purchases for ${targetEmail}: found ${purchases.length} purchases`);
    res.json(purchases);
  } catch (error) {
    console.error("[UnifiedPurchases] Error fetching my unified purchases:", error);
    res.status(500).json({ error: "Failed to fetch unified purchases" });
  }
});

// Get purchase stats for a member
router.get("/api/legacy-purchases/member/:email/stats", isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { email } = req.params;
    
    const stats = await db.select({
      totalPurchases: sql<number>`COUNT(*)`,
      totalSpentCents: sql<number>`COALESCE(SUM(item_total_cents), 0)`,
      guestPasses: sql<number>`COUNT(*) FILTER (WHERE item_category = 'guest_pass')`,
      guestSimFees: sql<number>`COUNT(*) FILTER (WHERE item_category = 'guest_sim_fee')`,
    })
      .from(legacyPurchases)
      .where(eq(legacyPurchases.memberEmail, email.toLowerCase()));
    
    res.json({
      totalPurchases: stats[0]?.totalPurchases || 0,
      totalSpent: ((stats[0]?.totalSpentCents || 0) / 100).toFixed(2),
      guestPasses: stats[0]?.guestPasses || 0,
      guestSimFees: stats[0]?.guestSimFees || 0,
    });
  } catch (error) {
    console.error("[LegacyPurchases] Error fetching stats:", error);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// Admin: Trigger import from uploaded files
router.post("/api/legacy-purchases/admin/import", isAdmin, async (req: Request, res: Response) => {
  try {
    const { membersFile, salesFile, attendanceFile } = req.body;
    
    const results: any = {};
    
    if (membersFile) {
      const membersPath = path.resolve(membersFile);
      results.members = await importMembersFromCSV(membersPath);
    }
    
    if (salesFile) {
      const salesPath = path.resolve(salesFile);
      results.sales = await importSalesFromCSV(salesPath);
    }
    
    if (attendanceFile) {
      const attendancePath = path.resolve(attendanceFile);
      results.attendance = await importAttendanceFromCSV(attendancePath);
    }
    
    res.json({
      success: true,
      results,
    });
  } catch (error) {
    console.error("[LegacyPurchases] Import error:", error);
    res.status(500).json({ 
      error: "Import failed",
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Admin: Get import job history
router.get("/api/legacy-purchases/admin/import-jobs", isAdmin, async (req: Request, res: Response) => {
  try {
    const jobs = await db.select()
      .from(legacyImportJobs)
      .orderBy(desc(legacyImportJobs.createdAt))
      .limit(20);
    
    res.json(jobs);
  } catch (error) {
    console.error("[LegacyPurchases] Error fetching import jobs:", error);
    res.status(500).json({ error: "Failed to fetch import jobs" });
  }
});

// Admin: Upload and import MindBody CSV files
// Accepts: firstVisitFile (optional), salesFile (required)
// The First Visit file helps link MindBody clients to existing users by email/phone
router.post("/api/legacy-purchases/admin/upload-csv", 
  isAdmin, 
  upload.fields([
    { name: 'firstVisitFile', maxCount: 1 },
    { name: 'salesFile', maxCount: 1 }
  ]),
  async (req: Request, res: Response) => {
    try {
      const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
      
      if (!files) {
        return res.status(400).json({ error: "No files uploaded" });
      }
      
      // Server-side validation: salesFile is required
      if (!files.salesFile || !files.salesFile[0]) {
        return res.status(400).json({ error: "Sales Report file is required" });
      }
      
      const sessionUser = getSessionUser(req);
      const batchId = `csv_upload_${Date.now()}`;
      
      // Create import job record - include batchId in fileName for reliable lookup
      const jobFileName = `${batchId}|${Object.keys(files).map(k => files[k][0]?.originalname).filter(Boolean).join(', ')}`;
      
      const [job] = await db.insert(legacyImportJobs).values({
        jobType: 'csv_upload',
        fileName: jobFileName,
        status: 'running',
        startedAt: new Date(),
      }).returning({ id: legacyImportJobs.id });
      
      const results: any = {
        batchId,
        firstVisit: null,
        sales: null,
      };
      
      // Step 1: Process First Visit Report first (if provided) to link clients
      let clientLookup: Map<string, any> | undefined;
      
      if (files.firstVisitFile && files.firstVisitFile[0]) {
        const firstVisitContent = files.firstVisitFile[0].buffer.toString('utf-8');
        console.log(`[CSVUpload] Processing First Visit Report: ${files.firstVisitFile[0].originalname}`);
        
        // Parse to build lookup map
        clientLookup = parseFirstVisitReport(firstVisitContent);
        
        // Also import to link users
        const firstVisitResult = await importFirstVisitReport(firstVisitContent);
        results.firstVisit = firstVisitResult;
        
        console.log(`[CSVUpload] First Visit result: ${JSON.stringify(firstVisitResult)}`);
      }
      
      // Step 2: Process Sales Report with enhanced matching
      if (files.salesFile && files.salesFile[0]) {
        const salesContent = files.salesFile[0].buffer.toString('utf-8');
        console.log(`[CSVUpload] Processing Sales Report: ${files.salesFile[0].originalname}`);
        
        const salesResult = await importSalesFromContent(salesContent, clientLookup, batchId);
        results.sales = salesResult;
        
        console.log(`[CSVUpload] Sales result: ${JSON.stringify(salesResult)}`);
      }
      
      // Log the action
      await logFromRequest(req, {
        actionType: 'mindbody_csv_import',
        resourceType: 'legacy_purchase',
        resourceName: batchId,
        details: {
          firstVisitFile: files.firstVisitFile?.[0]?.originalname,
          salesFile: files.salesFile?.[0]?.originalname,
          results,
        },
      });
      
      // Update job status using the job ID
      await db.update(legacyImportJobs)
        .set({
          status: 'completed',
          completedAt: new Date(),
          results: results,
        })
        .where(eq(legacyImportJobs.id, job.id));
      
      res.json({
        success: true,
        message: 'CSV import completed successfully',
        results,
      });
    } catch (error) {
      console.error("[CSVUpload] Import error:", error);
      res.status(500).json({ 
        error: "CSV import failed",
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
);

// Admin: Get unmatched purchases (purchases without a linked user)
router.get("/api/legacy-purchases/admin/unmatched", isAdmin, async (req: Request, res: Response) => {
  try {
    const unmatched = await db.select()
      .from(legacyPurchases)
      .where(sql`user_id IS NULL`)
      .orderBy(desc(legacyPurchases.saleDate))
      .limit(100);
    
    res.json(unmatched);
  } catch (error) {
    console.error("[LegacyPurchases] Error fetching unmatched:", error);
    res.status(500).json({ error: "Failed to fetch unmatched purchases" });
  }
});

// Link guest fees to Trackman sessions
router.post("/api/legacy-purchases/admin/link-guest-fees", isAdmin, async (req: Request, res: Response) => {
  try {
    // Find guest-related purchases that aren't linked yet
    const guestPurchases = await db.select()
      .from(legacyPurchases)
      .where(and(
        sql`item_category IN ('guest_pass', 'guest_sim_fee')`,
        sql`linked_booking_session_id IS NULL`,
        sql`user_id IS NOT NULL`
      ))
      .orderBy(legacyPurchases.saleDate);
    
    let linked = 0;
    
    for (const purchase of guestPurchases) {
      // Try to find a booking session for this member on the same day
      const saleDate = purchase.saleDate;
      const startOfDay = new Date(saleDate);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(saleDate);
      endOfDay.setHours(23, 59, 59, 999);
      
      // Query booking_sessions for a match
      const sessions = await db.execute(sql`
        SELECT id FROM booking_sessions
        WHERE DATE(start_time) = DATE(${purchase.saleDate})
        AND (
          owner_user_id = ${purchase.userId}
          OR EXISTS (
            SELECT 1 FROM booking_participants bp
            WHERE bp.session_id = booking_sessions.id
            AND bp.user_id = ${purchase.userId}
          )
        )
        LIMIT 1
      `);
      
      if (sessions.rows && sessions.rows.length > 0) {
        await db.update(legacyPurchases)
          .set({
            linkedBookingSessionId: (sessions.rows[0] as any).id,
            linkedAt: new Date(),
          })
          .where(eq(legacyPurchases.id, purchase.id));
        linked++;
      }
    }
    
    res.json({
      success: true,
      processed: guestPurchases.length,
      linked,
    });
  } catch (error) {
    console.error("[LegacyPurchases] Error linking guest fees:", error);
    res.status(500).json({ error: "Failed to link guest fees" });
  }
});

// Helper: Extract tier name from legacy item_name (for membership purchases)
function extractTierFromItemName(itemName: string | null): string | null {
  if (!itemName) return null;
  
  const slug = normalizeTierSlug(itemName);
  if (slug === 'social' && !itemName.toLowerCase().includes('social')) {
    return null;
  }
  return normalizeTierNameUtil(itemName);
}

// Helper: Map item_category and item_name to correct HubSpot product ID
async function getCategoryProductId(itemCategory: string | null, itemName: string | null): Promise<string | null> {
  if (itemCategory === 'membership') {
    const tierName = extractTierFromItemName(itemName);
    
    if (tierName) {
      const products = await db.select()
        .from(hubspotProductMappings)
        .where(and(
          eq(hubspotProductMappings.productType, 'membership'),
          eq(hubspotProductMappings.tierName, tierName),
          eq(hubspotProductMappings.isActive, true)
        ))
        .limit(1);
      
      if (products[0]?.hubspotProductId) {
        return products[0].hubspotProductId;
      }
    }
    
    const coreProduct = await db.select()
      .from(hubspotProductMappings)
      .where(and(
        eq(hubspotProductMappings.productType, 'membership'),
        eq(hubspotProductMappings.tierName, 'Core'),
        eq(hubspotProductMappings.isActive, true)
      ))
      .limit(1);
    
    return coreProduct[0]?.hubspotProductId || null;
  }
  
  const categoryToProductName: Record<string, string> = {
    'guest_pass': 'Guest Pass Fee',
    'guest_sim_fee': 'Guest Pass Fee',
    'sim_walk_in': 'Golf Sim Pass (60min)',
    'sim_add_on': 'Simulator Overage (30 min)',
    'day_pass': 'Workspace Day Pass',
  };
  
  const productName = categoryToProductName[itemCategory || ''];
  if (productName) {
    const products = await db.select()
      .from(hubspotProductMappings)
      .where(and(
        eq(hubspotProductMappings.productName, productName),
        eq(hubspotProductMappings.isActive, true)
      ))
      .limit(1);
    
    return products[0]?.hubspotProductId || null;
  }
  
  return null;
}

// Helper: Create a line item directly with custom amount (for legacy purchases with specific prices)
async function createLegacyLineItem(
  hubspot: any,
  dealId: string,
  purchase: any,
  productId: string | null
): Promise<{ success: boolean; lineItemId?: string; error?: string }> {
  try {
    const amount = (purchase.itemTotalCents / 100).toFixed(2);
    const saleDateStr = purchase.saleDate ? new Date(purchase.saleDate).toISOString().split('T')[0] : '';
    const discountPercent = purchase.discountPercent ? parseFloat(purchase.discountPercent) : 0;
    
    const properties: Record<string, string> = {
      quantity: String(purchase.quantity || 1),
      price: amount,
      name: `${purchase.itemName} (Legacy - ${saleDateStr})`,
    };
    
    if (productId) {
      properties.hs_product_id = productId;
    }
    
    if (discountPercent > 0) {
      properties.hs_discount_percentage = String(discountPercent);
    }
    
    const lineItemResponse = await retryableHubSpotRequest(() =>
      hubspot.crm.lineItems.basicApi.create({ properties })
    );
    
    const lineItemId = lineItemResponse.id;
    
    await retryableHubSpotRequest(() =>
      hubspot.crm.associations.v4.basicApi.create(
        'line_items',
        lineItemId,
        'deals',
        dealId,
        [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 20 }]
      )
    );
    
    await db.insert(hubspotLineItems).values({
      hubspotDealId: dealId,
      hubspotLineItemId: lineItemId,
      hubspotProductId: productId || 'legacy_unmatched',
      productName: properties.name,
      quantity: purchase.quantity || 1,
      unitPrice: amount,
      discountPercent: Math.round(discountPercent),
      discountReason: discountPercent > 0 ? 'Legacy import discount' : null,
      totalAmount: amount,
      status: 'synced',
      createdBy: 'system',
      createdByName: 'Legacy Sync'
    });
    
    return { success: true, lineItemId };
  } catch (error: any) {
    console.error('[LegacyPurchases] Error creating line item:', error);
    return { success: false, error: error.message };
  }
}

// Admin: Sync purchase data to HubSpot for all members (Option 1: One deal per member with line items)
router.post("/api/legacy-purchases/admin/sync-hubspot", isAdmin, async (req: Request, res: Response) => {
  try {
    const hubspot = await getHubSpotClient();
    const BATCH_SIZE = 50;
    
    const results = {
      dealsCreated: 0,
      dealsReused: 0,
      lineItemsCreated: 0,
      purchasesSynced: 0,
      contactsUpdated: 0,
      errors: 0,
      errorDetails: [] as string[],
    };
    
    // Step 1: Get all unique members with unsynced purchases
    const membersWithUnsyncedPurchases = await db.select({
      memberEmail: legacyPurchases.memberEmail,
    })
      .from(legacyPurchases)
      .where(and(
        eq(legacyPurchases.isSynced, false),
        sql`${legacyPurchases.memberEmail} IS NOT NULL`
      ))
      .groupBy(legacyPurchases.memberEmail);
    
    const uniqueEmails = membersWithUnsyncedPurchases
      .map(m => m.memberEmail)
      .filter((email): email is string => !!email);
    
    console.log(`[LegacyPurchases] Found ${uniqueEmails.length} members with unsynced purchases`);
    
    // Step 2: Process members in batches
    for (let i = 0; i < uniqueEmails.length; i += BATCH_SIZE) {
      const batchEmails = uniqueEmails.slice(i, i + BATCH_SIZE);
      console.log(`[LegacyPurchases] Processing batch ${Math.floor(i/BATCH_SIZE) + 1} of ${Math.ceil(uniqueEmails.length/BATCH_SIZE)}`);
      
      for (const memberEmail of batchEmails) {
        try {
          // Step 2a: Find or create a deal for this member
          let dealId: string | null = null;
          
          // Check if member already has a deal in our local database
          const existingDeal = await db.select()
            .from(hubspotDeals)
            .where(eq(hubspotDeals.memberEmail, memberEmail.toLowerCase()))
            .limit(1);
          
          if (existingDeal.length > 0 && existingDeal[0].hubspotDealId) {
            dealId = existingDeal[0].hubspotDealId;
            results.dealsReused++;
          } else {
            // Create a new deal for this legacy member
            const dealResult = await createDealForLegacyMember(
              memberEmail,
              'active',
              'system',
              'Legacy Sync'
            );
            
            if (dealResult.success && dealResult.dealId) {
              dealId = dealResult.dealId;
              results.dealsCreated++;
            } else {
              results.errors++;
              if (results.errorDetails.length < 10) {
                results.errorDetails.push(`${memberEmail}: Failed to create deal - ${dealResult.error}`);
              }
              continue;
            }
          }
          
          if (!dealId) {
            results.errors++;
            if (results.errorDetails.length < 10) {
              results.errorDetails.push(`${memberEmail}: No deal ID available`);
            }
            continue;
          }
          
          // Step 2b: Get all unsynced purchases for this member
          const unsyncedPurchases = await db.select()
            .from(legacyPurchases)
            .where(and(
              eq(legacyPurchases.memberEmail, memberEmail.toLowerCase()),
              eq(legacyPurchases.isSynced, false)
            ))
            .orderBy(legacyPurchases.saleDate);
          
          // Step 2c: Create line items for each unsynced purchase
          for (const purchase of unsyncedPurchases) {
            try {
              const productId = await getCategoryProductId(purchase.itemCategory, purchase.itemName);
              
              const lineItemResult = await createLegacyLineItem(
                hubspot,
                dealId,
                purchase,
                productId
              );
              
              if (lineItemResult.success && lineItemResult.lineItemId) {
                // Mark purchase as synced and store line item ID
                await db.update(legacyPurchases)
                  .set({
                    isSynced: true,
                    hubspotDealId: lineItemResult.lineItemId,
                    updatedAt: new Date(),
                  })
                  .where(eq(legacyPurchases.id, purchase.id));
                
                results.lineItemsCreated++;
                results.purchasesSynced++;
              } else {
                results.errors++;
                if (results.errorDetails.length < 10) {
                  results.errorDetails.push(`Purchase ${purchase.id}: ${lineItemResult.error}`);
                }
              }
            } catch (purchaseErr: any) {
              results.errors++;
              if (results.errorDetails.length < 10) {
                results.errorDetails.push(`Purchase ${purchase.id}: ${purchaseErr.message}`);
              }
            }
          }
          
        } catch (memberErr: any) {
          results.errors++;
          if (results.errorDetails.length < 10) {
            results.errorDetails.push(`${memberEmail}: ${memberErr.message}`);
          }
        }
      }
      
      // Small delay between batches to avoid rate limits
      if (i + BATCH_SIZE < uniqueEmails.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    // Step 3: Also update contact properties (existing logic as fallback/supplement)
    try {
      const memberStats = await db.select({
        email: users.email,
        hubspotId: users.hubspotId,
        totalPurchases: sql<number>`COUNT(${legacyPurchases.id})`,
        totalSpentCents: sql<number>`COALESCE(SUM(${legacyPurchases.itemTotalCents}), 0)`,
        lastPurchaseDate: sql<string>`MAX(${legacyPurchases.saleDate})`,
      })
        .from(users)
        .leftJoin(legacyPurchases, eq(legacyPurchases.userId, users.id))
        .where(sql`${users.hubspotId} IS NOT NULL`)
        .groupBy(users.email, users.hubspotId);
      
      for (const member of memberStats) {
        if (!member.hubspotId) continue;
        
        try {
          const properties: Record<string, string> = {
            eh_total_purchases: String(member.totalPurchases || 0),
            eh_total_spend: ((member.totalSpentCents || 0) / 100).toFixed(2),
          };
          
          if (member.lastPurchaseDate) {
            const date = new Date(member.lastPurchaseDate);
            properties.eh_last_purchase_date = date.toISOString().split('T')[0];
          }
          
          await hubspot.crm.contacts.basicApi.update(member.hubspotId, { properties });
          results.contactsUpdated++;
        } catch (err: any) {
          // Silently skip contact update errors, deals are the main goal
        }
      }
    } catch (contactErr: any) {
      console.warn('[LegacyPurchases] Contact property sync failed:', contactErr.message);
    }
    
    console.log(`[LegacyPurchases] Sync complete:`, results);
    
    res.json({
      success: true,
      ...results,
      errorDetails: results.errorDetails.length > 0 ? results.errorDetails : undefined,
    });
  } catch (error) {
    console.error("[LegacyPurchases] HubSpot sync error:", error);
    res.status(500).json({ 
      error: "HubSpot sync failed",
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Admin: Sync purchase data to HubSpot for a single member
router.post("/api/legacy-purchases/admin/sync-hubspot/:email", isAdmin, async (req: Request, res: Response) => {
  try {
    const { email } = req.params;
    const hubspot = await getHubSpotClient();
    
    // Get the member
    const member = await db.select({
      hubspotId: users.hubspotId,
    })
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);
    
    if (!member[0]?.hubspotId) {
      return res.status(404).json({ error: "Member not found or no HubSpot ID" });
    }
    
    // Get their purchase stats
    const stats = await db.select({
      totalPurchases: sql<number>`COUNT(*)`,
      totalSpentCents: sql<number>`COALESCE(SUM(item_total_cents), 0)`,
      lastPurchaseDate: sql<string>`MAX(sale_date)`,
    })
      .from(legacyPurchases)
      .where(eq(legacyPurchases.memberEmail, email.toLowerCase()));
    
    const properties: Record<string, string> = {
      eh_total_purchases: String(stats[0]?.totalPurchases || 0),
      eh_total_spend: ((stats[0]?.totalSpentCents || 0) / 100).toFixed(2),
    };
    
    if (stats[0]?.lastPurchaseDate) {
      const date = new Date(stats[0].lastPurchaseDate);
      properties.eh_last_purchase_date = date.toISOString().split('T')[0];
    }
    
    await hubspot.crm.contacts.basicApi.update(member[0].hubspotId, { properties });
    
    res.json({
      success: true,
      email,
      properties,
    });
  } catch (error) {
    console.error("[LegacyPurchases] HubSpot sync error:", error);
    res.status(500).json({ 
      error: "HubSpot sync failed",
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
