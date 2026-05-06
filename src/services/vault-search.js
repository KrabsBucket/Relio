// PrismClaw — Local Vault Search Service
// Searches data/ folder for query matches, returns results + file content
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const VAULT_DIR = path.join(__dirname, '..', '..', 'vault');

/**
 * Search the local data/ folder for files matching a query.
 * Returns ranked results with file content excerpts.
 */
function searchVault(query) {
  const results = [];
  const queryLower = query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter(t => t.length > 1);

  // Search data/ folder only
  if (fs.existsSync(DATA_DIR)) {
    searchDir(DATA_DIR, queryTerms, results);
  }

  // Sort by relevance score
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 10);
}

function searchDir(dir, queryTerms, results) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Skip hidden dirs
      if (entry.name.startsWith('.')) continue;
      searchDir(fullPath, queryTerms, results);
      continue;
    }

    // Only search text-based files
    const ext = path.extname(entry.name).toLowerCase();
    if (!['.md', '.txt', '.csv', '.json', '.tsv', '.log', '.yaml', '.yml', '.xml'].includes(ext)) continue;

    try {
      const stat = fs.statSync(fullPath);
      if (stat.size > 5 * 1024 * 1024) continue; // Skip files > 5MB

      const content = fs.readFileSync(fullPath, 'utf-8');
      const contentLower = content.toLowerCase();
      const filenameLower = entry.name.toLowerCase();

      // Score: filename match = 10pts per term, content match = 1pt per occurrence
      let score = 0;
      const matchedLines = [];

      for (const term of queryTerms) {
        // Filename matches
        if (filenameLower.includes(term)) score += 10;

        // Content matches
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(term)) {
            score += 1;
            if (matchedLines.length < 5) {
              matchedLines.push({ line: i + 1, text: lines[i].trim().substring(0, 200) });
            }
          }
        }
      }

      if (score > 0) {
        results.push({
          file: path.relative(path.join(__dirname, '..', '..'), fullPath),
          filename: entry.name,
          ext,
          score,
          size: stat.size,
          matches: matchedLines,
          // Include full content for CSV/data files (for graphing)
          fullContent: ext === '.csv' || ext === '.tsv' || ext === '.json' ? content : null,
        });
      }
    } catch (err) {
      // Skip unreadable files
    }
  }
}

/**
 * Get the full content of a specific file (for graphing).
 */
function readDataFile(filePath) {
  const absPath = path.join(__dirname, '..', '..', filePath);
  if (!fs.existsSync(absPath)) return null;
  return fs.readFileSync(absPath, 'utf-8');
}

/**
 * Parse CSV content into { labels, values } for graphing.
 */
function parseCSVForGraph(csvContent) {
  const lines = csvContent.trim().split('\n');
  if (lines.length < 2) return null;

  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
  const rows = lines.slice(1).map(l => l.split(',').map(c => c.trim().replace(/"/g, '')));

  // Try to find a label column and a numeric column
  const labelCol = 0;
  let valueCol = -1;

  for (let c = 1; c < headers.length; c++) {
    if (rows.every(r => !isNaN(parseFloat(r[c])))) {
      valueCol = c;
      break;
    }
  }

  if (valueCol === -1) return null;

  return {
    labels: rows.map(r => r[labelCol]),
    values: rows.map(r => parseFloat(r[valueCol])),
    title: `${headers[labelCol]} vs ${headers[valueCol]}`,
    chartType: 'bar',
  };
}

module.exports = { searchVault, readDataFile, parseCSVForGraph };
