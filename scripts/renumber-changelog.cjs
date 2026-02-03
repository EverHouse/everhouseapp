const fs = require('fs');

const content = fs.readFileSync('src/data/changelog.ts', 'utf-8');

const headerRegex = /^([\s\S]*?export const changelog: ChangelogEntry\[\] = \[)\s*/;
const headerMatch = content.match(headerRegex);
if (!headerMatch) {
  console.error('Could not find changelog header');
  process.exit(1);
}
const header = headerMatch[1];

const afterHeader = content.slice(headerMatch[0].length);
const closingBracket = afterHeader.lastIndexOf('];');
const entriesSection = afterHeader.slice(0, closingBracket);

const entries = [];
let depth = 0;
let currentEntry = '';
let inString = false;
let escapeNext = false;

for (let i = 0; i < entriesSection.length; i++) {
  const char = entriesSection[i];
  
  if (escapeNext) {
    currentEntry += char;
    escapeNext = false;
    continue;
  }
  
  if (char === '\\' && inString) {
    currentEntry += char;
    escapeNext = true;
    continue;
  }
  
  if (char === '"' && !escapeNext) {
    inString = !inString;
  }
  
  if (!inString) {
    if (char === '{') {
      if (depth === 0) {
        currentEntry = '{';
      } else {
        currentEntry += char;
      }
      depth++;
    } else if (char === '}') {
      depth--;
      currentEntry += char;
      if (depth === 0) {
        entries.push(currentEntry.trim());
        currentEntry = '';
      }
    } else if (depth > 0) {
      currentEntry += char;
    }
  } else if (depth > 0) {
    currentEntry += char;
  }
}

console.log(`Found ${entries.length} raw entries`);

function parseEntry(entryStr) {
  const versionMatch = entryStr.match(/version:\s*"([^"]+)"/);
  const dateMatch = entryStr.match(/date:\s*"([^"]+)"/);
  const titleMatch = entryStr.match(/title:\s*"((?:[^"\\]|\\.)*)"/);
  const isMajorMatch = entryStr.match(/isMajor:\s*(true|false)/);
  
  const changesStartIdx = entryStr.indexOf('changes:');
  if (changesStartIdx === -1) return null;
  
  const changesArrayStart = entryStr.indexOf('[', changesStartIdx);
  let changesArrayEnd = changesArrayStart + 1;
  let bracketDepth = 1;
  let inStr = false;
  let escape = false;
  
  while (changesArrayEnd < entryStr.length && bracketDepth > 0) {
    const c = entryStr[changesArrayEnd];
    if (escape) {
      escape = false;
    } else if (c === '\\' && inStr) {
      escape = true;
    } else if (c === '"') {
      inStr = !inStr;
    } else if (!inStr) {
      if (c === '[') bracketDepth++;
      if (c === ']') bracketDepth--;
    }
    changesArrayEnd++;
  }
  
  const changesArrayStr = entryStr.slice(changesArrayStart, changesArrayEnd);
  
  const changes = [];
  const changeRegex = /"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = changeRegex.exec(changesArrayStr)) !== null) {
    changes.push(m[1]);
  }
  
  return {
    version: versionMatch ? versionMatch[1] : 'unknown',
    date: dateMatch ? dateMatch[1] : 'unknown',
    title: titleMatch ? titleMatch[1] : 'Unknown',
    isMajor: isMajorMatch ? isMajorMatch[1] === 'true' : false,
    changes
  };
}

const parsedEntries = entries.map(parseEntry).filter(e => e !== null);
console.log(`Parsed ${parsedEntries.length} entries`);

parsedEntries.reverse();

let majorVersion = 0;
let minorVersion = 0;

for (const entry of parsedEntries) {
  if (entry.isMajor) {
    majorVersion++;
    minorVersion = 0;
  } else {
    minorVersion++;
  }
  entry.newVersion = `${majorVersion}.${minorVersion}.0`;
}

parsedEntries.reverse();

console.log(`\nVersion mapping:`);
console.log(`Latest: ${parsedEntries[0].newVersion} (was ${parsedEntries[0].version}) - "${parsedEntries[0].title}"`);
console.log(`Total major versions: ${majorVersion}`);

let output = header + '\n';

for (let i = 0; i < parsedEntries.length; i++) {
  const entry = parsedEntries[i];
  const isLast = i === parsedEntries.length - 1;
  
  output += '  {\n';
  output += `    version: "${entry.newVersion}",\n`;
  output += `    date: "${entry.date}",\n`;
  output += `    title: "${entry.title}",\n`;
  if (entry.isMajor) {
    output += `    isMajor: true,\n`;
  }
  output += '    changes: [\n';
  for (let j = 0; j < entry.changes.length; j++) {
    const change = entry.changes[j];
    const isLastChange = j === entry.changes.length - 1;
    output += `      "${change}"${isLastChange ? '' : ','}\n`;
  }
  output += '    ]\n';
  output += `  }${isLast ? '' : ','}\n`;
}

output += '];\n';

fs.writeFileSync('src/data/changelog.ts', output);
console.log('\nChangelog updated successfully!');
