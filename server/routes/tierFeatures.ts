import { Router } from 'express';
import { pool, isProduction } from '../core/db';
import { isAdmin } from '../core/middleware';

const router = Router();

router.get('/api/tier-features', async (req, res) => {
  try {
    const featuresResult = await pool.query(`
      SELECT id, feature_key, display_label, value_type, sort_order, is_active
      FROM tier_features
      ORDER BY sort_order ASC, id ASC
    `);

    const valuesResult = await pool.query(`
      SELECT 
        tfv.feature_id,
        tfv.tier_id,
        tfv.value_boolean,
        tfv.value_number,
        tfv.value_text
      FROM tier_feature_values tfv
    `);

    const valuesByFeature: Record<number, Record<number, { tierId: number; value: any }>> = {};
    for (const row of valuesResult.rows) {
      if (!valuesByFeature[row.feature_id]) {
        valuesByFeature[row.feature_id] = {};
      }
      
      let value: any = null;
      if (row.value_text !== null) {
        value = row.value_text;
      } else if (row.value_number !== null) {
        value = parseFloat(row.value_number);
      } else if (row.value_boolean !== null) {
        value = row.value_boolean;
      }
      
      valuesByFeature[row.feature_id][row.tier_id] = {
        tierId: row.tier_id,
        value
      };
    }

    const features = featuresResult.rows.map(row => ({
      id: row.id,
      featureKey: row.feature_key,
      displayLabel: row.display_label,
      valueType: row.value_type,
      sortOrder: row.sort_order,
      isActive: row.is_active,
      values: valuesByFeature[row.id] || {}
    }));

    res.json({ features });
  } catch (error: any) {
    if (!isProduction) console.error('Tier features fetch error:', error);
    res.status(500).json({ error: 'Failed to fetch tier features' });
  }
});

router.post('/api/tier-features', isAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { featureKey, displayLabel, valueType = 'boolean', sortOrder = 0 } = req.body;

    if (!featureKey || !displayLabel) {
      return res.status(400).json({ error: 'featureKey and displayLabel are required' });
    }

    if (!['boolean', 'number', 'text'].includes(valueType)) {
      return res.status(400).json({ error: 'valueType must be boolean, number, or text' });
    }

    await client.query('BEGIN');

    const featureResult = await client.query(`
      INSERT INTO tier_features (feature_key, display_label, value_type, sort_order)
      VALUES ($1, $2, $3, $4)
      RETURNING id, feature_key, display_label, value_type, sort_order, is_active
    `, [featureKey, displayLabel, valueType, sortOrder]);

    const newFeature = featureResult.rows[0];

    const tiersResult = await client.query('SELECT id FROM membership_tiers');

    for (const tier of tiersResult.rows) {
      let defaultBoolean = null;
      let defaultNumber = null;
      let defaultText = null;

      if (valueType === 'boolean') {
        defaultBoolean = false;
      } else if (valueType === 'number') {
        defaultNumber = 0;
      } else {
        defaultText = '';
      }

      await client.query(`
        INSERT INTO tier_feature_values (feature_id, tier_id, value_boolean, value_number, value_text)
        VALUES ($1, $2, $3, $4, $5)
      `, [newFeature.id, tier.id, defaultBoolean, defaultNumber, defaultText]);
    }

    await client.query('COMMIT');

    res.json({
      id: newFeature.id,
      featureKey: newFeature.feature_key,
      displayLabel: newFeature.display_label,
      valueType: newFeature.value_type,
      sortOrder: newFeature.sort_order,
      isActive: newFeature.is_active,
      values: {}
    });
  } catch (error: any) {
    await client.query('ROLLBACK');
    if (!isProduction) console.error('Create tier feature error:', error);
    
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A feature with this key already exists' });
    }
    res.status(500).json({ error: 'Failed to create tier feature' });
  } finally {
    client.release();
  }
});

router.put('/api/tier-features/:id', isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { displayLabel, valueType, sortOrder, isActive } = req.body;

    if (valueType && !['boolean', 'number', 'text'].includes(valueType)) {
      return res.status(400).json({ error: 'valueType must be boolean, number, or text' });
    }

    const result = await pool.query(`
      UPDATE tier_features SET
        display_label = COALESCE($1, display_label),
        value_type = COALESCE($2, value_type),
        sort_order = COALESCE($3, sort_order),
        is_active = COALESCE($4, is_active),
        updated_at = NOW()
      WHERE id = $5
      RETURNING id, feature_key, display_label, value_type, sort_order, is_active
    `, [displayLabel, valueType, sortOrder, isActive, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Feature not found' });
    }

    const row = result.rows[0];
    res.json({
      id: row.id,
      featureKey: row.feature_key,
      displayLabel: row.display_label,
      valueType: row.value_type,
      sortOrder: row.sort_order,
      isActive: row.is_active
    });
  } catch (error: any) {
    if (!isProduction) console.error('Update tier feature error:', error);
    res.status(500).json({ error: 'Failed to update tier feature' });
  }
});

router.delete('/api/tier-features/:id', isAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(
      'DELETE FROM tier_features WHERE id = $1 RETURNING id',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Feature not found' });
    }

    res.json({ success: true, deleted: result.rows[0].id });
  } catch (error: any) {
    if (!isProduction) console.error('Delete tier feature error:', error);
    res.status(500).json({ error: 'Failed to delete tier feature' });
  }
});

router.put('/api/tier-features/:featureId/values/:tierId', isAdmin, async (req, res) => {
  try {
    const { featureId, tierId } = req.params;
    const { value } = req.body;

    const featureResult = await pool.query(
      'SELECT value_type FROM tier_features WHERE id = $1',
      [featureId]
    );

    if (featureResult.rows.length === 0) {
      return res.status(404).json({ error: 'Feature not found' });
    }

    const valueType = featureResult.rows[0].value_type;

    let valueBoolean = null;
    let valueNumber = null;
    let valueText = null;

    if (valueType === 'boolean') {
      valueBoolean = Boolean(value);
    } else if (valueType === 'number') {
      valueNumber = value !== null && value !== '' ? Number(value) : null;
    } else {
      valueText = value !== null ? String(value) : '';
    }

    const result = await pool.query(`
      INSERT INTO tier_feature_values (feature_id, tier_id, value_boolean, value_number, value_text, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (feature_id, tier_id) 
      DO UPDATE SET
        value_boolean = $3,
        value_number = $4,
        value_text = $5,
        updated_at = NOW()
      RETURNING *
    `, [featureId, tierId, valueBoolean, valueNumber, valueText]);

    const row = result.rows[0];
    let returnValue: any = null;
    if (row.value_text !== null) {
      returnValue = row.value_text;
    } else if (row.value_number !== null) {
      returnValue = parseFloat(row.value_number);
    } else if (row.value_boolean !== null) {
      returnValue = row.value_boolean;
    }

    res.json({
      featureId: row.feature_id,
      tierId: row.tier_id,
      value: returnValue
    });
  } catch (error: any) {
    if (!isProduction) console.error('Update tier feature value error:', error);
    res.status(500).json({ error: 'Failed to update tier feature value' });
  }
});

export default router;
