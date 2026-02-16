import { describe, it, expect } from 'vitest';
import { TRAINING_SEED_DATA } from '../../server/routes/training';

describe('Training Guide Content Validation', () => {
  it('should not mention Google Calendar for tour sources', () => {
    const toursGuide = TRAINING_SEED_DATA.find(guide => guide.guideId === 'tours');
    expect(toursGuide).toBeDefined();
    expect(toursGuide?.title).toBe('Tours');

    if (toursGuide && toursGuide.steps) {
      const tourSourcesStep = toursGuide.steps.find(step =>
        step.title.toLowerCase().includes('source')
      );
      expect(tourSourcesStep).toBeDefined();
      
      if (tourSourcesStep) {
        // Tours should reference HubSpot, not Google Calendar
        expect(tourSourcesStep.content).not.toMatch(/google calendar/i);
        expect(tourSourcesStep.content).toMatch(/hubspot/i);
      }

      // Verify HubSpot is mentioned elsewhere in tours
      const fullToursContent = toursGuide.steps
        .map(step => step.content)
        .join(' ');
      expect(fullToursContent).toMatch(/hubspot/i);
    }
  });

  it('should not contain deprecated feature references in critical sections', () => {
    const deprecatedPatterns = [
      {
        pattern: /google calendar/i,
        context: 'tours',
        shouldNotMatch: true,
        reason: 'Tours use HubSpot scheduler, not Google Calendar'
      }
    ];

    TRAINING_SEED_DATA.forEach(guide => {
      if (guide.guideId === 'tours') {
        guide.steps?.forEach(step => {
          // Tours section should not mention Google Calendar
          expect(step.content).not.toMatch(/google calendar/i);
        });
      }
    });
  });

  it('should have training sections for all major features', () => {
    const requiredGuideIds = [
      'getting-started',
      'booking-requests',
      'multi-member-bookings',
      'tours',
      'facility-closures',
      'events-wellness',
      'updates-announcements',
      'member-directory'
    ];

    const existingGuideIds = TRAINING_SEED_DATA.map(guide => guide.guideId);

    requiredGuideIds.forEach(guideId => {
      expect(existingGuideIds).toContain(guideId);
    });
  });

  it('should have valid step structures', () => {
    TRAINING_SEED_DATA.forEach(guide => {
      expect(guide.steps).toBeDefined();
      expect(Array.isArray(guide.steps)).toBe(true);
      expect(guide.steps.length).toBeGreaterThan(0);

      guide.steps.forEach((step, stepIndex) => {
        // Verify required fields
        expect(step.title).toBeDefined();
        expect(typeof step.title).toBe('string');
        expect(step.title.length).toBeGreaterThan(0);

        expect(step.content).toBeDefined();
        expect(typeof step.content).toBe('string');
        expect(step.content.length).toBeGreaterThan(0);

        // Verify optional fields have correct types
        if (step.pageIcon !== undefined) {
          expect(typeof step.pageIcon).toBe('string');
        }

        if ((step as any).imageUrl !== undefined) {
          expect(typeof (step as any).imageUrl).toBe('string');
        }
      });
    });
  });

  it('should have valid guide structures', () => {
    TRAINING_SEED_DATA.forEach(guide => {
      // Required fields
      expect(guide.guideId).toBeDefined();
      expect(typeof guide.guideId).toBe('string');
      expect(guide.guideId.length).toBeGreaterThan(0);

      expect(guide.title).toBeDefined();
      expect(typeof guide.title).toBe('string');
      expect(guide.title.length).toBeGreaterThan(0);

      expect(guide.description).toBeDefined();
      expect(typeof guide.description).toBe('string');
      expect(guide.description.length).toBeGreaterThan(0);

      expect(guide.icon).toBeDefined();
      expect(typeof guide.icon).toBe('string');

      expect(guide.sortOrder).toBeDefined();
      expect(typeof guide.sortOrder).toBe('number');
      expect(guide.sortOrder).toBeGreaterThan(0);

      expect(guide.isAdminOnly).toBeDefined();
      expect(typeof guide.isAdminOnly).toBe('boolean');
    });
  });

  it('should have consistent guide ordering', () => {
    const sortOrders = TRAINING_SEED_DATA.map(guide => guide.sortOrder);
    const uniqueSortOrders = new Set(sortOrders);

    // No duplicate sort orders
    expect(uniqueSortOrders.size).toBe(TRAINING_SEED_DATA.length);

    // Sort orders should be consecutive starting from 1
    const sorted = [...sortOrders].sort((a, b) => a - b);
    sorted.forEach((order, index) => {
      expect(order).toBe(index + 1);
    });
  });

  it('should verify tours guide uses HubSpot correctly', () => {
    const toursGuide = TRAINING_SEED_DATA.find(guide => guide.guideId === 'tours');
    expect(toursGuide).toBeDefined();

    if (toursGuide) {
      const fullToursContent = toursGuide.steps
        .map(step => step.content)
        .join(' ');

      // Should mention HubSpot
      expect(fullToursContent).toMatch(/hubspot/i);

      // Should mention HubSpot scheduler specifically
      expect(fullToursContent).toMatch(/hubspot scheduler/i);

      // Should mention HubSpot meetings
      expect(fullToursContent).toMatch(/hubspot meetings/i);
    }
  });

  it('should have unique guide IDs', () => {
    const guideIds = TRAINING_SEED_DATA.map(guide => guide.guideId);
    const uniqueGuideIds = new Set(guideIds);

    expect(uniqueGuideIds.size).toBe(TRAINING_SEED_DATA.length);
  });

  it('should have unique titles', () => {
    const titles = TRAINING_SEED_DATA.map(guide => guide.title);
    const uniqueTitles = new Set(titles);

    expect(uniqueTitles.size).toBe(TRAINING_SEED_DATA.length);
  });

  it('should have non-empty step titles and content', () => {
    TRAINING_SEED_DATA.forEach(guide => {
      guide.steps.forEach(step => {
        expect(step.title.trim().length).toBeGreaterThan(0);
        expect(step.content.trim().length).toBeGreaterThan(0);
      });
    });
  });

  it('should properly segregate admin-only content', () => {
    const adminGuides = TRAINING_SEED_DATA.filter(guide => guide.isAdminOnly);
    const nonAdminGuides = TRAINING_SEED_DATA.filter(guide => !guide.isAdminOnly);

    // Should have both admin and non-admin guides
    expect(adminGuides.length).toBeGreaterThan(0);
    expect(nonAdminGuides.length).toBeGreaterThan(0);

    // Verify some expected admin-only guides
    const expectedAdminGuides = ['inquiries', 'gallery', 'faqs', 'team-access', 'membership-tiers'];
    expectedAdminGuides.forEach(guideId => {
      const guide = TRAINING_SEED_DATA.find(g => g.guideId === guideId);
      expect(guide?.isAdminOnly).toBe(true);
    });

    // Verify some expected non-admin guides
    const expectedNonAdminGuides = ['getting-started', 'booking-requests', 'tours'];
    expectedNonAdminGuides.forEach(guideId => {
      const guide = TRAINING_SEED_DATA.find(g => g.guideId === guideId);
      expect(guide?.isAdminOnly).toBe(false);
    });
  });

  it('should not reference deprecated features across all guides', () => {
    // Define deprecated terms/phrases that should not appear
    const deprecatedReferences = [
      {
        term: 'Google Calendar',
        // Google Calendar is acceptable in generic calendar context (like "Sync with Google Calendar")
        // but NOT when referring to tour scheduling or booking approval mechanisms
        shouldNotAppearIn: ['tours']
      }
    ];

    deprecatedReferences.forEach(ref => {
      const contextGuides = TRAINING_SEED_DATA.filter(guide =>
        ref.shouldNotAppearIn.includes(guide.guideId)
      );

      contextGuides.forEach(guide => {
        const fullContent = guide.steps
          .map(step => step.content)
          .join(' ');

        // Tours guide specifically should NOT use Google Calendar for tour sources
        if (guide.guideId === 'tours') {
          expect(fullContent).not.toMatch(/google calendar.*tour/i);
          expect(fullContent).not.toMatch(/tour.*google calendar/i);
        }
      });
    });
  });

  it('should have all guides return from server routes', () => {
    expect(TRAINING_SEED_DATA).toBeDefined();
    expect(Array.isArray(TRAINING_SEED_DATA)).toBe(true);
    expect(TRAINING_SEED_DATA.length).toBeGreaterThan(0);
  });

  it('should maintain consistency with icon usage', () => {
    TRAINING_SEED_DATA.forEach(guide => {
      // Icons should be valid Material Icons or similar
      expect(guide.icon).toBeDefined();
      expect(guide.icon.length).toBeGreaterThan(0);
      // Icon should not have spaces
      expect(guide.icon).not.toMatch(/\s/);
    });
  });

  it('should have meaningful descriptions for all guides', () => {
    TRAINING_SEED_DATA.forEach(guide => {
      // Descriptions should be substantive
      expect(guide.description).toBeDefined();
      expect(guide.description.length).toBeGreaterThanOrEqual(10);
      // Should not be just placeholder text
      expect(guide.description.toLowerCase()).not.toMatch(/^(todo|tbd|fix|placeholder)/);
    });
  });
});
