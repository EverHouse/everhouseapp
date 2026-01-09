import { Router } from 'express';
import { db } from '../db';
import { faqs } from '../../shared/schema';
import { eq, asc, desc } from 'drizzle-orm';
import { isStaffOrAdmin } from '../core/middleware';

const router = Router();

const initialFaqs = [
  { question: "What is included in the membership?", answer: "Membership includes access to our lounge areas, coworking spaces, and the onsite cafe. Core and Premium memberships also include monthly hours for our TrackMan golf simulators and conference room bookings.", category: "Membership", sortOrder: 1 },
  { question: "Can I bring guests?", answer: "Yes, members are welcome to bring guests. Social and Core members have a daily guest limit, while Premium members enjoy enhanced guest privileges. Guests must be accompanied by a member at all times.", category: "Membership", sortOrder: 2 },
  { question: "How do I book a simulator?", answer: "Members can book simulator bays directly through the Ever House app or member portal. Reservations can be made up to 14 days in advance depending on your membership tier.", category: "Booking", sortOrder: 3 },
  { question: "Is there a dress code?", answer: "We encourage a 'smart casual' dress code. Golf attire is always welcome. We ask that members avoid athletic wear that is overly casual (e.g., gym tank tops) in the lounge areas.", category: "Policies", sortOrder: 4 },
  { question: "Are the golf simulators suitable for beginners?", answer: "Absolutely! Our TrackMan 4 simulators are perfect for all skill levels, from beginners looking to learn the basics to professionals analyzing their swing data. We also offer introductory sessions.", category: "Amenities", sortOrder: 5 },
  { question: "Can I host a private event?", answer: "Yes, Ever House offers several spaces for private hire, including the Main Hall and Private Dining Room. Visit our Private Hire page or contact our events team for more details.", category: "Events", sortOrder: 6 },
  { question: "What are the operating hours?", answer: "We are open Tuesday through Thursday from 8:30 AM to 8:00 PM, Friday and Saturday from 8:30 AM to 10:00 PM, and Sunday from 8:30 AM to 6:00 PM. We are closed on Mondays.", category: "General", sortOrder: 7 },
  { question: "Is there parking available?", answer: "Yes, ample complimentary parking is available for all members and guests at our Tustin location.", category: "General", sortOrder: 8 },
];

router.get('/api/faqs', async (req, res) => {
  try {
    const result = await db.select().from(faqs)
      .where(eq(faqs.isActive, true))
      .orderBy(asc(faqs.sortOrder), asc(faqs.id));
    
    res.json(result);
  } catch (error: any) {
    console.error('FAQs fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch FAQs' });
  }
});

router.get('/api/admin/faqs', isStaffOrAdmin, async (req, res) => {
  try {
    const result = await db.select().from(faqs)
      .orderBy(asc(faqs.sortOrder), asc(faqs.id));
    
    res.json(result);
  } catch (error: any) {
    console.error('Admin FAQs fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch FAQs' });
  }
});

router.post('/api/admin/faqs', isStaffOrAdmin, async (req, res) => {
  try {
    const { question, answer, category, sortOrder, isActive } = req.body;
    
    if (!question || !answer) {
      return res.status(400).json({ error: 'Question and answer are required' });
    }
    
    const [newFaq] = await db.insert(faqs).values({
      question,
      answer,
      category: category || null,
      sortOrder: sortOrder ?? 0,
      isActive: isActive ?? true,
    }).returning();
    
    res.status(201).json(newFaq);
  } catch (error: any) {
    console.error('FAQ creation error:', error);
    res.status(500).json({ error: 'Failed to create FAQ' });
  }
});

router.put('/api/admin/faqs/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { question, answer, category, sortOrder, isActive } = req.body;
    
    const [updated] = await db.update(faqs)
      .set({
        ...(question !== undefined && { question }),
        ...(answer !== undefined && { answer }),
        ...(category !== undefined && { category }),
        ...(sortOrder !== undefined && { sortOrder }),
        ...(isActive !== undefined && { isActive }),
        updatedAt: new Date(),
      })
      .where(eq(faqs.id, parseInt(id)))
      .returning();
    
    if (!updated) {
      return res.status(404).json({ error: 'FAQ not found' });
    }
    
    res.json(updated);
  } catch (error: any) {
    console.error('FAQ update error:', error);
    res.status(500).json({ error: 'Failed to update FAQ' });
  }
});

router.delete('/api/admin/faqs/:id', isStaffOrAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    const [deleted] = await db.delete(faqs)
      .where(eq(faqs.id, parseInt(id)))
      .returning();
    
    if (!deleted) {
      return res.status(404).json({ error: 'FAQ not found' });
    }
    
    res.json({ success: true, deleted });
  } catch (error: any) {
    console.error('FAQ deletion error:', error);
    res.status(500).json({ error: 'Failed to delete FAQ' });
  }
});

router.post('/api/admin/faqs/reorder', isStaffOrAdmin, async (req, res) => {
  try {
    const { order } = req.body;
    
    if (!Array.isArray(order) || order.length === 0) {
      return res.status(400).json({ error: 'Order array is required' });
    }
    
    for (const item of order) {
      if (typeof item.id !== 'number' || typeof item.sortOrder !== 'number') {
        return res.status(400).json({ error: 'Each item must have id and sortOrder as numbers' });
      }
    }
    
    await Promise.all(
      order.map(item =>
        db.update(faqs)
          .set({ sortOrder: item.sortOrder, updatedAt: new Date() })
          .where(eq(faqs.id, item.id))
      )
    );
    
    res.json({ success: true, updated: order.length });
  } catch (error: any) {
    console.error('FAQ reorder error:', error);
    res.status(500).json({ error: 'Failed to reorder FAQs' });
  }
});

router.post('/api/admin/faqs/seed', isStaffOrAdmin, async (req, res) => {
  try {
    const existing = await db.select().from(faqs);
    
    if (existing.length > 0) {
      return res.status(400).json({ error: 'FAQs already exist. Delete existing FAQs first to re-seed.' });
    }
    
    const inserted = await db.insert(faqs).values(
      initialFaqs.map(faq => ({
        ...faq,
        isActive: true,
      }))
    ).returning();
    
    res.json({ success: true, count: inserted.length, faqs: inserted });
  } catch (error: any) {
    console.error('FAQ seeding error:', error);
    res.status(500).json({ error: 'Failed to seed FAQs' });
  }
});

export default router;
