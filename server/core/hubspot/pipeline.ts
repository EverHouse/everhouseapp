import { getHubSpotClient } from '../integrations';
import { getErrorMessage } from '../../utils/errorUtils';
import { HUBSPOT_STAGE_IDS, MEMBERSHIP_PIPELINE_ID } from './constants';
import { retryableHubSpotRequest } from './request';

import { logger } from '../logger';
let pipelineValidationCache: { 
  validated: boolean; 
  pipelineExists: boolean;
  validStages: string[];
  lastChecked: Date | null;
} = { validated: false, pipelineExists: false, validStages: [], lastChecked: null };

export function getPipelineValidationCache() {
  return pipelineValidationCache;
}

export async function validateMembershipPipeline(): Promise<{ 
  valid: boolean; 
  pipelineExists: boolean; 
  missingStages: string[];
  error?: string;
}> {
  try {
    const cacheAge = pipelineValidationCache.lastChecked 
      ? Date.now() - pipelineValidationCache.lastChecked.getTime() 
      : Infinity;
    
    if (pipelineValidationCache.validated && cacheAge < 3600000) {
      const requiredStages = Object.values(HUBSPOT_STAGE_IDS);
      const missingStages = requiredStages.filter(s => !pipelineValidationCache.validStages.includes(s));
      return {
        valid: pipelineValidationCache.pipelineExists && missingStages.length === 0,
        pipelineExists: pipelineValidationCache.pipelineExists,
        missingStages
      };
    }
    
    const hubspot = await getHubSpotClient();
    
    const pipelinesResponse = await retryableHubSpotRequest(() =>
      hubspot.crm.pipelines.pipelinesApi.getAll('deals')
    );
    
    const membershipPipeline = pipelinesResponse.results.find(
      (p: Record<string, unknown>) => p.id === MEMBERSHIP_PIPELINE_ID || (p.label as string)?.toLowerCase().includes('membership')
    );
    
    if (!membershipPipeline) {
      pipelineValidationCache = { validated: true, pipelineExists: false, validStages: [], lastChecked: new Date() };
      return {
        valid: false,
        pipelineExists: false,
        missingStages: Object.values(HUBSPOT_STAGE_IDS),
        error: `Membership Pipeline (${MEMBERSHIP_PIPELINE_ID}) not found in HubSpot`
      };
    }
    
    const validStages = membershipPipeline.stages?.map((s: any) => s.id as string) || [];
    
    const requiredStages = Object.values(HUBSPOT_STAGE_IDS);
    const missingStages = requiredStages.filter(s => !validStages.includes(s));
    
    pipelineValidationCache = { 
      validated: true, 
      pipelineExists: true, 
      validStages,
      lastChecked: new Date()
    };
    
    if (missingStages.length > 0) {
      logger.warn(`[HubSpotDeals] Missing stages in Membership Pipeline: ${missingStages.join(', ')}`);
    }
    
    return {
      valid: missingStages.length === 0,
      pipelineExists: true,
      missingStages
    };
  } catch (error: unknown) {
    logger.error('[HubSpotDeals] Error validating membership pipeline:', { error: error });
    return {
      valid: false,
      pipelineExists: false,
      missingStages: [],
      error: getErrorMessage(error) || 'Failed to validate pipeline'
    };
  }
}

export function isValidStage(stageId: string): boolean {
  if (!pipelineValidationCache.validated) return true;
  return pipelineValidationCache.validStages.includes(stageId);
}
