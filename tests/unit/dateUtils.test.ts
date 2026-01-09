import { describe, it, expect } from 'vitest';
import {
  CLUB_TIMEZONE,
  getTodayPacific,
  addDaysToPacificDate,
  parseLocalDate,
  formatDatePacific,
  getPacificISOString,
  createPacificDate
} from '../../server/utils/dateUtils';

describe('Date Utilities - Production Code Tests', () => {
  
  describe('CLUB_TIMEZONE constant', () => {
    it('should be set to America/Los_Angeles', () => {
      expect(CLUB_TIMEZONE).toBe('America/Los_Angeles');
    });
  });
  
  describe('getTodayPacific', () => {
    it('should return a valid YYYY-MM-DD format', () => {
      const today = getTodayPacific();
      expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
    
    it('should return a parseable date string', () => {
      const today = getTodayPacific();
      const [year, month, day] = today.split('-').map(Number);
      expect(year).toBeGreaterThanOrEqual(2024);
      expect(month).toBeGreaterThanOrEqual(1);
      expect(month).toBeLessThanOrEqual(12);
      expect(day).toBeGreaterThanOrEqual(1);
      expect(day).toBeLessThanOrEqual(31);
    });
  });
  
  describe('addDaysToPacificDate', () => {
    it('should add days correctly', () => {
      const result = addDaysToPacificDate('2026-01-15', 5);
      expect(result).toBe('2026-01-20');
    });
    
    it('should handle month rollover', () => {
      const result = addDaysToPacificDate('2026-01-30', 5);
      expect(result).toBe('2026-02-04');
    });
    
    it('should handle year rollover', () => {
      const result = addDaysToPacificDate('2025-12-30', 5);
      expect(result).toBe('2026-01-04');
    });
    
    it('should handle negative days', () => {
      const result = addDaysToPacificDate('2026-01-15', -5);
      expect(result).toBe('2026-01-10');
    });
    
    it('should handle zero days', () => {
      const result = addDaysToPacificDate('2026-01-15', 0);
      expect(result).toBe('2026-01-15');
    });
  });
  
  describe('parseLocalDate', () => {
    it('should parse YYYY-MM-DD string to Date object', () => {
      const date = parseLocalDate('2026-01-15');
      expect(date.getFullYear()).toBe(2026);
      expect(date.getMonth()).toBe(0);
      expect(date.getDate()).toBe(15);
    });
    
    it('should set time to midnight local time', () => {
      const date = parseLocalDate('2026-01-15');
      expect(date.getHours()).toBe(0);
      expect(date.getMinutes()).toBe(0);
    });
  });
  
  describe('formatDatePacific', () => {
    it('should format Date to YYYY-MM-DD in Pacific timezone', () => {
      const date = new Date('2026-01-15T12:00:00-08:00');
      const formatted = formatDatePacific(date);
      expect(formatted).toBe('2026-01-15');
    });
  });
  
  describe('getPacificISOString', () => {
    it('should create ISO string with Pacific timezone offset', () => {
      const iso = getPacificISOString('2026-01-15', '14:30');
      expect(iso).toContain('2026-01-15T14:30:00');
      expect(iso).toMatch(/[-+]\d{2}:00$/);
    });
    
    it('should handle time with seconds', () => {
      const iso = getPacificISOString('2026-01-15', '14:30:45');
      expect(iso).toContain('2026-01-15T14:30:45');
    });
    
    it('should add seconds when not provided', () => {
      const iso = getPacificISOString('2026-01-15', '14:30');
      expect(iso).toContain(':00');
    });
  });
  
  describe('createPacificDate', () => {
    it('should create Date object from Pacific date and time', () => {
      const date = createPacificDate('2026-01-15', '14:30');
      expect(date instanceof Date).toBe(true);
      expect(date.getTime()).toBeGreaterThan(0);
    });
    
    it('should create correct Date for known values', () => {
      const date = createPacificDate('2026-01-15', '14:30');
      expect(date.toISOString()).toContain('2026-01-15');
    });
  });
});
