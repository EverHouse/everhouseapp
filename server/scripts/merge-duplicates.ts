import { executeMerge, previewMerge } from '../core/userMerge';

const MERGE_PAIRS = [
  { primary: 'ef297e66-0864-4f48-b6f2-46651d30bdc6', secondary: 'be7bfbbb-05a0-4862-81a5-6d941d47984b', label: 'Justin Cheng (jcheng@stark.health <- justincheng625@gmail.com)' },
  { primary: '46d84f04-0781-444b-bca9-fa0bcead4f1b', secondary: 'bcc4fe23-1f52-4e03-a7ec-b17dd94baaf4', label: 'Daniel David (daniel@mlylendd.com <- daniel@mylenderdd.com)' },
  { primary: '4c7617ac-5fd6-4f0e-94ad-b76f62ce30c5', secondary: 'ec3df2a0-6d88-4d24-8f66-9220f4947408', label: 'Tyler Keil (tylerwkeil54@gmail.com <- tyler.keil@yourfavoritelenders.com)' },
  { primary: '00b1d91c-c878-4b18-ac5a-76982af28c08', secondary: '6f279166-16d8-4798-9281-54355df0ea1c', label: 'Cole Vandee (vandewoestynecole@gmail.com <- cole@colevandee.com)' },
  { primary: '8e7496b9-566c-46f0-ae73-dc020206bb4e', secondary: '6ddad6a7-4fed-4a8b-81bb-87dda1002d59', label: 'Dana Reston (danareston@gmail.com <- ky8rzqbbsn@privaterelay.appleid.com)' },
  { primary: '25468edb-a5bf-4c35-8295-a10e41d3d9a3', secondary: '6c2e8907-c6cb-480e-a380-474ca9bb5a78', label: 'Ollie Linton (ollie.linton@caa.com <- ollie.linton@gmail.com)' },
  { primary: '14e3d97a-859a-43bf-b4e6-8909a9e80f96', secondary: '368c2c02-d329-4fd7-be05-90da89f220e0', label: 'Amit Patel (amit@a-intra.com <- amit@kreohospitality.com)' },
  { primary: 'f49bf100-00ac-4826-be19-b01316580e60', secondary: 'c36faf70-7a02-46fb-98bd-3eb41cecf0f4', label: 'Rebecca Lee-Bentham (rleebentham@hotmail.com <- rebecca@evenhouse.club)' },
  { primary: 'cc57db68-1f82-488b-b608-82a0fd11ae03', secondary: 'ec18296a-7e3f-4c6b-bd9c-29930fbd0d24', label: 'David Parsons (davidhparsons2003@yahoo.com <- dhparsons007@gmail.com)' },
  { primary: 'e0ecb6ab-d113-4ff2-8aed-58ba386d2129', secondary: 'd37c4ea1-deef-4a81-81a3-2ebfb7e9bd1c', label: 'Eric Foster (efoster@gmail.com <- eric.foster.mba@gmail.com)' },
  { primary: '4300a163-df8d-4941-80e8-cc3916cc3321', secondary: '5c98675c-87e9-4abf-bb35-71325a80d296', label: 'Sammy Cemo (sammycemo@yahoo.com <- sammy.cemo@cbre.com)' },
  { primary: 'df79b4c6-8f61-4d65-8cb7-6d03e70c3d34', secondary: 'a3a97dda-62ec-43c8-b67d-3605ac251969', label: 'Bobby Dysart (bdysart@gmail.com <- bobby@compa.ai)' },
];

async function run() {
  console.log(`\n=== Starting merge of ${MERGE_PAIRS.length} duplicate pairs ===\n`);
  
  let succeeded = 0;
  let failed = 0;
  const results: Array<{ label: string; success: boolean; error?: string; records?: any }> = [];

  for (const pair of MERGE_PAIRS) {
    console.log(`\n--- ${pair.label} ---`);
    
    try {
      const preview = await previewMerge(pair.primary, pair.secondary);
      console.log(`Preview: ${JSON.stringify(preview.recordsToMerge)}`);
      if (preview.conflicts.length > 0) {
        console.log(`Conflicts: ${preview.conflicts.join(', ')}`);
      }
      
      const result = await executeMerge(pair.primary, pair.secondary, 'system-dedup-script');
      console.log(`SUCCESS: merged ${JSON.stringify(result.recordsMerged)}`);
      succeeded++;
      results.push({ label: pair.label, success: true, records: result.recordsMerged });
    } catch (error: any) {
      console.error(`FAILED: ${error.message}`);
      failed++;
      results.push({ label: pair.label, success: false, error: error.message });
    }
  }

  console.log(`\n=== Merge complete: ${succeeded} succeeded, ${failed} failed ===`);
  console.log('\nResults:');
  for (const r of results) {
    console.log(`  ${r.success ? '✓' : '✗'} ${r.label}${r.error ? ` - ${r.error}` : ''}`);
  }
  
  process.exit(0);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
