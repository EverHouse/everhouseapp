import { Router, Request, Response } from "express";
import { db } from "../db";
import { legacyPurchases, users, legacyImportJobs } from "@shared/schema";
import { eq, desc, and, sql, gte, lte } from "drizzle-orm";
import { isStaffOrAdmin, isAdmin } from "../core/middleware";
import { importMembersFromCSV, importSalesFromCSV, importAttendanceFromCSV } from "../core/mindbody/import";
import path from "path";

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
router.get("/api/legacy-purchases/my-purchases", async (req: Request, res: Response) => {
  try {
    const userEmail = (req as any).user?.email;
    if (!userEmail) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    
    const purchases = await db.select()
      .from(legacyPurchases)
      .where(eq(legacyPurchases.memberEmail, userEmail.toLowerCase()))
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
    }));
    
    res.json(formattedPurchases);
  } catch (error) {
    console.error("[LegacyPurchases] Error fetching my purchases:", error);
    res.status(500).json({ error: "Failed to fetch purchases" });
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

// Admin: Sync purchase data to HubSpot for all members
router.post("/api/legacy-purchases/admin/sync-hubspot", isAdmin, async (req: Request, res: Response) => {
  try {
    const { getHubSpotClient } = await import("../core/hubspot/client");
    const hubspot = await getHubSpotClient();
    
    // Get all members with purchases and their HubSpot IDs
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
    
    let updated = 0;
    let errors = 0;
    const errorDetails: string[] = [];
    
    for (const member of memberStats) {
      if (!member.hubspotId) continue;
      
      try {
        const properties: Record<string, string> = {
          eh_total_purchases: String(member.totalPurchases || 0),
          eh_total_spend: ((member.totalSpentCents || 0) / 100).toFixed(2),
        };
        
        if (member.lastPurchaseDate) {
          // Format date as YYYY-MM-DD for HubSpot
          const date = new Date(member.lastPurchaseDate);
          properties.eh_last_purchase_date = date.toISOString().split('T')[0];
        }
        
        await hubspot.crm.contacts.basicApi.update(member.hubspotId, { properties });
        updated++;
      } catch (err: any) {
        errors++;
        if (errorDetails.length < 5) {
          errorDetails.push(`${member.email}: ${err.message}`);
        }
      }
    }
    
    res.json({
      success: true,
      totalMembers: memberStats.length,
      updated,
      errors,
      errorDetails: errorDetails.length > 0 ? errorDetails : undefined,
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
    const { getHubSpotClient } = await import("../core/hubspot/client");
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
