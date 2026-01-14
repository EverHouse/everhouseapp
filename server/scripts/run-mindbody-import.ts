import { importMembersFromCSV, importSalesFromCSV, importAttendanceFromCSV } from '../core/mindbody/import';
import path from 'path';

async function main() {
  const membersFile = path.resolve('attached_assets/Members_Report_-_as_of_13-Jan-2026_(1)_1768382344940.csv');
  const salesFile = path.resolve('attached_assets/Sales_Report_1-13-2025_-_1-13-2026_1768382344939.csv');
  const attendanceFile = path.resolve('attached_assets/AttendanceAnalysis_Report_1-13-2025_-_1-13-2026_1768382364901.csv');
  
  console.log('=== Starting Mindbody Import ===\n');
  
  // Step 1: Import members
  console.log('Step 1: Importing members...');
  const membersResult = await importMembersFromCSV(membersFile);
  console.log(`  Total: ${membersResult.total}`);
  console.log(`  Matched: ${membersResult.matched}`);
  console.log(`  Updated: ${membersResult.updated}`);
  console.log(`  Skipped: ${membersResult.skipped}`);
  if (membersResult.errors.length > 0) {
    console.log(`  Errors (first 5): ${membersResult.errors.slice(0, 5).join(', ')}`);
  }
  console.log('');
  
  // Step 2: Import sales
  console.log('Step 2: Importing sales...');
  const salesResult = await importSalesFromCSV(salesFile);
  console.log(`  Total: ${salesResult.total}`);
  console.log(`  Imported: ${salesResult.imported}`);
  console.log(`  Skipped: ${salesResult.skipped}`);
  console.log(`  Guest-related: ${salesResult.linked}`);
  if (salesResult.errors.length > 0) {
    console.log(`  Errors (first 5): ${salesResult.errors.slice(0, 5).join(', ')}`);
  }
  console.log('');
  
  // Step 3: Import attendance
  console.log('Step 3: Importing attendance...');
  const attendanceResult = await importAttendanceFromCSV(attendanceFile);
  console.log(`  Total: ${attendanceResult.total}`);
  console.log(`  Updated: ${attendanceResult.updated}`);
  console.log(`  Skipped: ${attendanceResult.skipped}`);
  if (attendanceResult.errors.length > 0) {
    console.log(`  Errors (first 5): ${attendanceResult.errors.slice(0, 5).join(', ')}`);
  }
  console.log('');
  
  console.log('=== Import Complete ===');
}

main().catch(console.error);
