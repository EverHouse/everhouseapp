import { Router, Request, Response } from "express";
import { db } from "../db";
import { legacyPurchases, users, billingAuditLog } from "@shared/schema";
import { eq, desc, sql, isNull, and, or, ilike } from "drizzle-orm";
import { isStaffOrAdmin, isAdmin } from "../core/middleware";

const router = Router();

router.get("/api/admin/mindbody/unmatched", isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    const search = (req.query.search as string)?.trim();

    const baseConditions = [
      isNull(legacyPurchases.userId),
      isNull(legacyPurchases.memberEmail)
    ];

    const unmatchedQuery = db
      .selectDistinctOn([legacyPurchases.mindbodyClientId], {
        mindbodyClientId: legacyPurchases.mindbodyClientId,
        itemName: legacyPurchases.itemName,
        itemCategory: legacyPurchases.itemCategory,
        saleDate: legacyPurchases.saleDate,
        purchaseCount: sql<number>`COUNT(*) OVER (PARTITION BY ${legacyPurchases.mindbodyClientId})`.as('purchase_count'),
        totalSpentCents: sql<number>`SUM(${legacyPurchases.itemTotalCents}) OVER (PARTITION BY ${legacyPurchases.mindbodyClientId})`.as('total_spent_cents'),
        lastPurchaseDate: sql<string>`MAX(${legacyPurchases.saleDate}) OVER (PARTITION BY ${legacyPurchases.mindbodyClientId})`.as('last_purchase_date'),
      })
      .from(legacyPurchases)
      .where(and(...baseConditions))
      .orderBy(legacyPurchases.mindbodyClientId, desc(legacyPurchases.saleDate));

    const unmatched = await unmatchedQuery;

    let filteredUnmatched = unmatched;
    if (search) {
      const searchLower = search.toLowerCase();
      filteredUnmatched = unmatched.filter(u => 
        u.mindbodyClientId.toLowerCase().includes(searchLower) ||
        (u.itemName && u.itemName.toLowerCase().includes(searchLower))
      );
    }

    const totalCount = filteredUnmatched.length;
    const paginatedData = filteredUnmatched.slice(offset, offset + limit);

    const formattedData = paginatedData.map(u => ({
      mindbodyClientId: u.mindbodyClientId,
      lastItemName: u.itemName,
      lastItemCategory: u.itemCategory,
      lastPurchaseDate: u.lastPurchaseDate,
      purchaseCount: u.purchaseCount,
      totalSpent: ((u.totalSpentCents || 0) / 100).toFixed(2),
    }));

    res.json({
      data: formattedData,
      totalCount,
      limit,
      offset,
    });
  } catch (error) {
    console.error("[Mindbody] Error fetching unmatched:", error);
    res.status(500).json({ error: "Failed to fetch unmatched records" });
  }
});

router.post("/api/admin/mindbody/link", isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const { mindbodyClientId, memberEmail } = req.body;
    
    if (!mindbodyClientId || !memberEmail) {
      return res.status(400).json({ error: "Missing mindbodyClientId or memberEmail" });
    }

    const normalizedEmail = memberEmail.toLowerCase().trim();

    const member = await db.select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
    })
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);

    if (member.length === 0) {
      return res.status(404).json({ error: "Member not found with that email" });
    }

    const targetMember = member[0];

    const purchasesToUpdate = await db.select({ id: legacyPurchases.id })
      .from(legacyPurchases)
      .where(and(
        eq(legacyPurchases.mindbodyClientId, mindbodyClientId),
        isNull(legacyPurchases.memberEmail)
      ));

    if (purchasesToUpdate.length === 0) {
      return res.status(404).json({ error: "No unlinked purchases found for this Mindbody client ID" });
    }

    await db.update(legacyPurchases)
      .set({
        memberEmail: normalizedEmail,
        userId: targetMember.id,
        updatedAt: new Date(),
      })
      .where(and(
        eq(legacyPurchases.mindbodyClientId, mindbodyClientId),
        isNull(legacyPurchases.memberEmail)
      ));

    await db.update(users)
      .set({
        mindbodyClientId: mindbodyClientId,
        updatedAt: new Date(),
      })
      .where(eq(users.id, targetMember.id));

    const performingUser = (req as any).user;
    await db.insert(billingAuditLog).values({
      memberEmail: normalizedEmail,
      actionType: 'mindbody_link',
      actionDetails: {
        mindbodyClientId,
        purchasesLinked: purchasesToUpdate.length,
        linkedTo: {
          email: targetMember.email,
          name: `${targetMember.firstName || ''} ${targetMember.lastName || ''}`.trim(),
        },
      },
      previousValue: null,
      newValue: `Linked ${purchasesToUpdate.length} purchases to ${normalizedEmail}`,
      performedBy: performingUser?.email || 'system',
      performedByName: performingUser?.name || `${performingUser?.firstName || ''} ${performingUser?.lastName || ''}`.trim() || 'System',
    });

    res.json({
      success: true,
      linkedCount: purchasesToUpdate.length,
      memberEmail: normalizedEmail,
      memberName: `${targetMember.firstName || ''} ${targetMember.lastName || ''}`.trim(),
    });
  } catch (error) {
    console.error("[Mindbody] Error linking member:", error);
    res.status(500).json({ error: "Failed to link member" });
  }
});

router.get("/api/admin/mindbody/link-history", isStaffOrAdmin, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);

    const history = await db.select({
      id: billingAuditLog.id,
      memberEmail: billingAuditLog.memberEmail,
      actionDetails: billingAuditLog.actionDetails,
      newValue: billingAuditLog.newValue,
      performedBy: billingAuditLog.performedBy,
      performedByName: billingAuditLog.performedByName,
      createdAt: billingAuditLog.createdAt,
    })
      .from(billingAuditLog)
      .where(eq(billingAuditLog.actionType, 'mindbody_link'))
      .orderBy(desc(billingAuditLog.createdAt))
      .limit(limit);

    res.json(history);
  } catch (error) {
    console.error("[Mindbody] Error fetching link history:", error);
    res.status(500).json({ error: "Failed to fetch link history" });
  }
});

export default router;
