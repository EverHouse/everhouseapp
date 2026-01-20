import * as fs from 'fs';
import * as path from 'path';

const JULES_API_BASE = 'https://jules.googleapis.com/v1alpha';

interface JulesSession {
  name: string;
  title: string;
  state: string;
  createTime: string;
}

interface JulesActivity {
  name: string;
  createTime: string;
  originator: string;
  planGenerated?: {
    plan: {
      steps: Array<{ title: string; description: string }>;
    };
  };
  messageAdded?: {
    text: string;
  };
}

interface SchemaFile {
  filename: string;
  tables: string[];
  content: string;
}

function getApiKey(): string {
  const apiKey = process.env.JULES_API_KEY;
  if (!apiKey) {
    throw new Error('JULES_API_KEY environment variable is required. Add it to your secrets.');
  }
  return apiKey;
}

function extractTableNames(content: string): string[] {
  const tableRegex = /pgTable\s*\(\s*["']([^"']+)["']/g;
  const tables: string[] = [];
  let match;
  while ((match = tableRegex.exec(content)) !== null) {
    tables.push(match[1]);
  }
  return tables;
}

async function extractDrizzleSchema(): Promise<SchemaFile[]> {
  const modelsDir = path.join(process.cwd(), 'shared', 'models');
  const schemaFiles: SchemaFile[] = [];

  if (!fs.existsSync(modelsDir)) {
    throw new Error(`Models directory not found: ${modelsDir}`);
  }

  const files = fs.readdirSync(modelsDir).filter(f => f.endsWith('.ts'));

  for (const file of files) {
    const filePath = path.join(modelsDir, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    const tables = extractTableNames(content);

    if (tables.length > 0) {
      schemaFiles.push({
        filename: file,
        tables,
        content
      });
    }
  }

  return schemaFiles;
}

function extractColumnInfo(content: string): string {
  const lines = content.split('\n');
  const relevantLines: string[] = [];
  let inTable = false;
  let braceCount = 0;
  
  for (const line of lines) {
    if (line.includes('pgTable(')) {
      inTable = true;
      braceCount = 0;
    }
    
    if (inTable) {
      relevantLines.push(line);
      braceCount += (line.match(/\{/g) || []).length;
      braceCount -= (line.match(/\}/g) || []).length;
      
      if (braceCount <= 0 && relevantLines.length > 1) {
        inTable = false;
        relevantLines.push('');
      }
    }
  }
  
  return relevantLines.join('\n').trim();
}

function buildAnalysisPrompt(schemaFiles: SchemaFile[]): string {
  const allTables = schemaFiles.flatMap(s => s.tables);
  const tableList = allTables.map(t => `  - ${t}`).join('\n');
  
  const schemaDetails = schemaFiles.map(file => {
    const columnInfo = extractColumnInfo(file.content);
    const truncated = columnInfo.length > 3000 
      ? columnInfo.substring(0, 3000) + '\n... [truncated]' 
      : columnInfo;
    return `### ${file.filename}\nTables: ${file.tables.join(', ')}\n\n\`\`\`typescript\n${truncated}\n\`\`\``;
  }).join('\n\n');

  return `Analyze the Drizzle ORM schema in this repository and check for any inconsistencies with Supabase/PostgreSQL tables.

## Current Drizzle Schema Tables Found

The following tables are defined in shared/models/:

${tableList}

## Schema Definitions

${schemaDetails}

## Analysis Tasks

1. **Schema Consistency Check**: Review each table definition in shared/models/*.ts and verify:
   - Column types match PostgreSQL/Supabase conventions
   - All required indexes are defined
   - Foreign key relationships are properly configured
   - Default values and constraints are appropriate

2. **Migration Alignment**: Check drizzle/ directory for:
   - Pending migrations that haven't been applied
   - Schema drift between Drizzle definitions and migration files
   - Any orphaned or conflicting migrations

3. **Supabase Compatibility**: Verify:
   - RLS (Row Level Security) considerations
   - Timestamp handling (created_at, updated_at patterns)
   - UUID vs serial ID usage consistency
   - JSONB column usage patterns

4. **Code Quality**: Check for:
   - Consistent naming conventions (snake_case for DB columns)
   - Proper TypeScript type exports
   - Missing table relationships or junction tables

Please provide a detailed report of any inconsistencies, potential issues, or recommended improvements.`;
}

async function getRepoSource(apiKey: string): Promise<string | null> {
  console.log('[Jules] Fetching connected repositories...');

  const response = await fetch(`${JULES_API_BASE}/sources`, {
    method: 'GET',
    headers: {
      'X-Goog-Api-Key': apiKey,
      'Content-Type': 'application/json'
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to fetch sources: ${response.status} - ${errorText}`);
  }

  const data = await response.json();

  if (!data.sources || data.sources.length === 0) {
    console.log('[Jules] No connected repositories found.');
    console.log('[Jules] Please connect your GitHub repository at https://jules.google.com');
    return null;
  }

  console.log(`[Jules] Found ${data.sources.length} connected repository(ies):`);
  data.sources.forEach((source: any, i: number) => {
    console.log(`  ${i + 1}. ${source.name}`);
  });

  return data.sources[0].name;
}

async function createAnalysisSession(
  apiKey: string,
  sourceId: string,
  prompt: string
): Promise<JulesSession> {
  console.log('\n[Jules] Creating schema analysis session...');

  const response = await fetch(`${JULES_API_BASE}/sessions`, {
    method: 'POST',
    headers: {
      'X-Goog-Api-Key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      prompt,
      sourceContext: {
        source: sourceId,
        githubRepoContext: {
          startingBranch: 'main'
        }
      },
      title: 'Drizzle Schema Analysis - Supabase Consistency Check'
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create session: ${response.status} - ${errorText}`);
  }

  const session: JulesSession = await response.json();
  console.log(`[Jules] Session created: ${session.name}`);
  console.log(`[Jules] Title: ${session.title}`);
  console.log(`[Jules] State: ${session.state}`);

  return session;
}

async function pollSessionActivities(
  apiKey: string,
  sessionName: string,
  maxPolls: number = 30,
  intervalMs: number = 5000
): Promise<JulesActivity[]> {
  console.log('\n[Jules] Monitoring session progress...');

  let lastActivityCount = 0;

  for (let i = 0; i < maxPolls; i++) {
    const response = await fetch(`${JULES_API_BASE}/${sessionName}/activities`, {
      method: 'GET',
      headers: {
        'X-Goog-Api-Key': apiKey,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      console.log(`[Jules] Warning: Failed to fetch activities (attempt ${i + 1})`);
      await new Promise(r => setTimeout(r, intervalMs));
      continue;
    }

    const data = await response.json();
    const activities: JulesActivity[] = data.activities || [];

    if (activities.length > lastActivityCount) {
      const newActivities = activities.slice(lastActivityCount);
      for (const activity of newActivities) {
        if (activity.planGenerated) {
          console.log('\n[Jules] Plan generated:');
          activity.planGenerated.plan.steps.forEach((step, idx) => {
            console.log(`  ${idx + 1}. ${step.title}`);
            if (step.description) {
              console.log(`     ${step.description.substring(0, 100)}...`);
            }
          });
        }
        if (activity.messageAdded) {
          console.log(`\n[Jules] Message: ${activity.messageAdded.text.substring(0, 200)}...`);
        }
      }
      lastActivityCount = activities.length;
    }

    const sessionResponse = await fetch(`${JULES_API_BASE}/${sessionName}`, {
      method: 'GET',
      headers: {
        'X-Goog-Api-Key': apiKey,
        'Content-Type': 'application/json'
      }
    });

    if (sessionResponse.ok) {
      const sessionData = await sessionResponse.json();
      if (sessionData.state === 'COMPLETED' || sessionData.state === 'FAILED') {
        console.log(`\n[Jules] Session ${sessionData.state.toLowerCase()}`);
        return activities;
      }
    }

    process.stdout.write('.');
    await new Promise(r => setTimeout(r, intervalMs));
  }

  console.log('\n[Jules] Max polling attempts reached. Check Jules dashboard for results.');
  return [];
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Jules Schema Analysis - Drizzle/Supabase Consistency Check');
  console.log('═══════════════════════════════════════════════════════════\n');

  try {
    const apiKey = getApiKey();
    console.log('[Jules] API key loaded successfully');

    console.log('\n[Schema] Extracting Drizzle schema definitions...');
    const schemaFiles = await extractDrizzleSchema();

    if (schemaFiles.length === 0) {
      throw new Error('No schema files with table definitions found');
    }

    console.log(`[Schema] Found ${schemaFiles.length} schema file(s):`);
    for (const schema of schemaFiles) {
      console.log(`  - ${schema.filename}: ${schema.tables.length} table(s)`);
      schema.tables.forEach(t => console.log(`      • ${t}`));
    }

    const sourceId = await getRepoSource(apiKey);
    if (!sourceId) {
      console.log('\n[Jules] Cannot proceed without a connected repository.');
      console.log('[Jules] Visit https://jules.google.com to connect your GitHub repo.');
      process.exit(1);
    }

    const analysisPrompt = buildAnalysisPrompt(schemaFiles);

    const session = await createAnalysisSession(apiKey, sourceId, analysisPrompt);

    console.log('\n[Jules] Session URL:');
    console.log(`  https://jules.google.com/sessions/${session.name.split('/').pop()}`);

    const waitForResults = process.argv.includes('--wait');
    if (waitForResults) {
      await pollSessionActivities(apiKey, session.name);
    } else {
      console.log('\n[Jules] Session started successfully!');
      console.log('[Jules] Run with --wait flag to poll for results');
      console.log('[Jules] Or check the Jules dashboard for analysis progress');
    }

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('  Analysis triggered successfully');
    console.log('═══════════════════════════════════════════════════════════');

  } catch (error: any) {
    console.error('\n[Error]', error.message);
    process.exit(1);
  }
}

main();
