import { formatDateDisplayWithDay } from '../../../../utils/dateUtils';
import type { BookingRequest, Resource, CalendarClosure, AvailabilityBlock } from './simulatorTypes';

export function estimateFeeByTier(
    tier: string | null | undefined, 
    durationMinutes: number,
    declaredPlayerCount: number = 1,
    guestFeeRate: number = 25,
    overageRate: number = 25
): number {
    if (durationMinutes <= 0) return 0;
    
    const playerCount = Math.max(1, declaredPlayerCount);
    const guestCount = Math.max(0, playerCount - 1);
    
    const guestFees = guestCount * guestFeeRate;
    
    if (!tier) return guestFees;
    
    const tierLower = tier.toLowerCase();
    
    if (tierLower === 'vip') {
        return guestFees;
    }
    
    let includedMinutes = 0;
    if (tierLower === 'corporate' || tierLower === 'premium') {
        includedMinutes = 90;
    } else if (tierLower === 'core') {
        includedMinutes = 60;
    }
    
    const ownerOverageMinutes = Math.max(0, durationMinutes - includedMinutes);
    
    const ownerOverageBlocks = ownerOverageMinutes > 0 ? Math.ceil(ownerOverageMinutes / 30) : 0;
    const ownerOverageFee = ownerOverageBlocks * overageRate;
    
    return ownerOverageFee + guestFees;
}

export const formatDateShortAdmin = (dateStr: string): string => {
    if (!dateStr) return 'No Date';
    const datePart = dateStr.includes('T') ? dateStr.split('T')[0] : dateStr;
    return formatDateDisplayWithDay(datePart);
};

export const groupBookingsByDate = (bookings: BookingRequest[]): Map<string, BookingRequest[]> => {
    const grouped = new Map<string, BookingRequest[]>();
    for (const booking of bookings) {
        const date = booking.request_date;
        if (!grouped.has(date)) {
            grouped.set(date, []);
        }
        grouped.get(date)!.push(booking);
    }
    return grouped;
};

export const parseAffectedBayIds = (affectedAreas: string, resources: Resource[]): number[] => {
    if (affectedAreas === 'entire_facility') {
        return resources.map(r => r.id);
    }
    
    if (affectedAreas === 'all_bays') {
        return resources.filter(r => r.type === 'simulator').map(r => r.id);
    }
    
    if (affectedAreas === 'conference_room') {
        return [11];
    }
    
    if (affectedAreas.startsWith('bay_') && !affectedAreas.includes(',') && !affectedAreas.includes('[')) {
        const areaId = parseInt(affectedAreas.replace('bay_', ''));
        return isNaN(areaId) ? [] : [areaId];
    }
    
    if (affectedAreas.includes(',') && !affectedAreas.startsWith('[')) {
        const ids: number[] = [];
        for (const item of affectedAreas.split(',')) {
            const trimmed = item.trim();
            if (trimmed.startsWith('bay_')) {
                const areaId = parseInt(trimmed.replace('bay_', ''));
                if (!isNaN(areaId)) ids.push(areaId);
            } else {
                const areaId = parseInt(trimmed);
                if (!isNaN(areaId)) ids.push(areaId);
            }
        }
        return ids;
    }
    
    try {
        const parsed = JSON.parse(affectedAreas);
        if (Array.isArray(parsed)) {
            const ids: number[] = [];
            for (const item of parsed) {
                if (typeof item === 'number') {
                    ids.push(item);
                } else if (typeof item === 'string') {
                    if (item.startsWith('bay_')) {
                        const areaId = parseInt(item.replace('bay_', ''));
                        if (!isNaN(areaId)) ids.push(areaId);
                    } else {
                        const areaId = parseInt(item);
                        if (!isNaN(areaId)) ids.push(areaId);
                    }
                }
            }
            return ids;
        }
    } catch {}
    
    return [];
};

export const getClosureForSlot = (
    resourceId: number, 
    date: string, 
    slotStart: number, 
    slotEnd: number,
    closures: CalendarClosure[],
    resources: Resource[]
): CalendarClosure | null => {
    for (const closure of closures) {
        if (closure.startDate > date || closure.endDate < date) continue;
        
        const affectedBayIds = parseAffectedBayIds(closure.affectedAreas, resources);
        if (!affectedBayIds.includes(resourceId)) continue;
        
        if (!closure.startTime && !closure.endTime) {
            return closure;
        }
        
        const closureStartMinutes = closure.startTime 
            ? parseInt(closure.startTime.split(':')[0]) * 60 + parseInt(closure.startTime.split(':')[1] || '0') 
            : 0;
        const closureEndMinutes = closure.endTime 
            ? parseInt(closure.endTime.split(':')[0]) * 60 + parseInt(closure.endTime.split(':')[1] || '0') 
            : 24 * 60;
        
        if (slotStart < closureEndMinutes && slotEnd > closureStartMinutes) {
            return closure;
        }
    }
    return null;
};

export const getBlockForSlot = (
    resourceId: number, 
    date: string, 
    slotStart: number, 
    slotEnd: number,
    availabilityBlocks: AvailabilityBlock[]
): AvailabilityBlock | null => {
    for (const block of availabilityBlocks) {
        if (block.blockDate !== date) continue;
        if (block.resourceId !== resourceId) continue;
        
        const blockStartMinutes = block.startTime 
            ? parseInt(block.startTime.split(':')[0]) * 60 + parseInt(block.startTime.split(':')[1] || '0') 
            : 0;
        const blockEndMinutes = block.endTime 
            ? parseInt(block.endTime.split(':')[0]) * 60 + parseInt(block.endTime.split(':')[1] || '0') 
            : 24 * 60;
        
        if (slotStart < blockEndMinutes && slotEnd > blockStartMinutes) {
            return block;
        }
    }
    return null;
};
