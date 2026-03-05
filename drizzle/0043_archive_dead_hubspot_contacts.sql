UPDATE users u
SET archived_at = NOW(),
    archived_by = 'system-sync-cleanup'
WHERE u.archived_at IS NULL
  AND u.membership_status IN ('non-member', 'archived', 'cancelled', 'expired', 'terminated')
  AND u.hubspot_id IS NOT NULL
  AND u.stripe_customer_id IS NULL
  AND u.mindbody_client_id IS NULL
  AND u.role = 'member'
  AND NOT EXISTS (SELECT 1 FROM booking_participants bp WHERE bp.user_id = u.id)
  AND NOT EXISTS (SELECT 1 FROM day_pass_purchases dpp WHERE LOWER(dpp.email) = LOWER(u.email));
