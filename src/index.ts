#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';

// ── ANSI Colors ──
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgMagenta: '\x1b[45m',
};

interface CSSRule {
  selector: string;
  declarations: string[];
  line: number;
  file: string;
}

interface AuditIssue {
  type: 'specificity' | 'duplicate' | 'important' | 'overqualified' | 'universal';
  message: string;
  selector: string;
  file: string;
  line: number;
  severity: 'warning' | 'error' | 'info';
}

interface AuditReport {
  files: { name: string; size: number; rules: number; selectors: number }[];
  totalSize: number;
  totalRules: number;
  totalSelectors: number;
  issues: AuditIssue[];
  scores: {
    overall: number;
    specificity: number;
    duplicates: number;
    important: number;
    fileSize: number;
  };
  summary: string;
}

function printHelp(): void {
  console.log(`
${c.bgMagenta}${c.white}${c.bold} CSS-AUDIT ${c.reset}  ${c.dim}v1.0.0${c.reset}

${c.bold}Audit CSS files for bloat, specificity issues, and bad patterns.${c.reset}

${c.yellow}USAGE${c.reset}
  ${c.cyan}css-audit${c.reset} <file|dir|url> [options]
  ${c.cyan}npx @lxgicstudios/css-audit${c.reset} ./styles --threshold 70

${c.yellow}ARGUMENTS${c.reset}
  ${c.green}<file|dir|url>${c.reset}   CSS file, directory, or URL to audit

${c.yellow}OPTIONS${c.reset}
  ${c.green}--url <url>${c.reset}       Audit CSS from a live website
  ${c.green}--threshold <n>${c.reset}   Minimum passing score 0-100 (default: 60)
  ${c.green}--no-color${c.reset}        Disable colored output
  ${c.green}--json${c.reset}            Output results as JSON
  ${c.green}--help${c.reset}            Show this help message

${c.yellow}WHAT IT CHECKS${c.reset}
  ${c.magenta}\u2022${c.reset} Specificity issues (deeply nested selectors, IDs)
  ${c.magenta}\u2022${c.reset} Duplicate declarations across rules
  ${c.magenta}\u2022${c.reset} !important abuse
  ${c.magenta}\u2022${c.reset} Overqualified selectors (div.class, tag#id)
  ${c.magenta}\u2022${c.reset} Universal selector usage
  ${c.magenta}\u2022${c.reset} File size analysis

${c.yellow}EXAMPLES${c.reset}
  ${c.dim}# Audit a single file${c.reset}
  css-audit styles.css

  ${c.dim}# Audit a directory${c.reset}
  css-audit ./src/styles

  ${c.dim}# Audit a live site${c.reset}
  css-audit --url https://example.com

  ${c.dim}# CI mode with threshold${c.reset}
  css-audit styles.css --threshold 80 --json
`);
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--no-color') args.noColor = true;
    else if (arg === '--url' && argv[i + 1]) args.url = argv[++i];
    else if (arg === '--threshold' && argv[i + 1]) args.threshold = argv[++i];
    else if (!arg.startsWith('-')) positional.push(arg);
  }

  if (positional.length > 0) args.input = positional[0];
  return args;
}

function fetchUrl(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { headers: { 'User-Agent': 'css-audit/1.0' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve, reject);
      }
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function extractCSSFromUrl(url: string): Promise<{ name: string; content: string }[]> {
  const html = await fetchUrl(url);
  const cssFiles: { name: string; content: string }[] = [];

  // Extract inline styles
  const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let match: RegExpExecArray | null;
  let inlineIdx = 0;
  while ((match = styleRegex.exec(html)) !== null) {
    cssFiles.push({ name: `inline-style-${++inlineIdx}`, content: match[1] });
  }

  // Extract linked stylesheets
  const linkRegex = /<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*>/gi;
  const linkRegex2 = /<link[^>]+href=["']([^"']+)["'][^>]*rel=["']stylesheet["'][^>]*>/gi;

  const hrefs: string[] = [];
  while ((match = linkRegex.exec(html)) !== null) hrefs.push(match[1]);
  while ((match = linkRegex2.exec(html)) !== null) hrefs.push(match[1]);

  for (const href of [...new Set(hrefs)]) {
    try {
      let cssUrl = href;
      if (href.startsWith('//')) cssUrl = 'https:' + href;
      else if (href.startsWith('/')) {
        const u = new URL(url);
        cssUrl = u.origin + href;
      } else if (!href.startsWith('http')) {
        cssUrl = new URL(href, url).toString();
      }
      const content = await fetchUrl(cssUrl);
      cssFiles.push({ name: href, content });
    } catch {
      // Skip unreachable stylesheets
    }
  }

  return cssFiles;
}

function parseCSSRules(content: string, filename: string): CSSRule[] {
  const rules: CSSRule[] = [];
  // Remove comments
  const cleaned = content.replace(/\/\*[\s\S]*?\*\//g, '');

  let lineNum = 1;
  let i = 0;

  while (i < cleaned.length) {
    // Count newlines
    if (cleaned[i] === '\n') { lineNum++; i++; continue; }

    // Skip whitespace
    if (/\s/.test(cleaned[i])) { i++; continue; }

    // Skip @rules (media queries, keyframes, etc.) - find matching brace
    if (cleaned[i] === '@') {
      const atStart = i;
      const atLine = lineNum;
      // Find the opening brace
      while (i < cleaned.length && cleaned[i] !== '{') {
        if (cleaned[i] === '\n') lineNum++;
        i++;
      }
      if (i < cleaned.length) {
        // Check if it's a block @rule (media, keyframes) or single-line (@import, @charset)
        let braceDepth = 1;
        i++; // skip opening brace
        while (i < cleaned.length && braceDepth > 0) {
          if (cleaned[i] === '{') braceDepth++;
          else if (cleaned[i] === '}') braceDepth--;
          if (cleaned[i] === '\n') lineNum++;
          i++;
        }
      }
      continue;
    }

    // Read selector
    let selector = '';
    const ruleLine = lineNum;
    while (i < cleaned.length && cleaned[i] !== '{') {
      if (cleaned[i] === '\n') lineNum++;
      selector += cleaned[i];
      i++;
    }
    selector = selector.trim();

    if (i >= cleaned.length) break;

    // Read declarations
    i++; // skip {
    let declStr = '';
    let braceDepth = 1;
    while (i < cleaned.length && braceDepth > 0) {
      if (cleaned[i] === '{') braceDepth++;
      else if (cleaned[i] === '}') { braceDepth--; if (braceDepth === 0) { i++; break; } }
      if (cleaned[i] === '\n') lineNum++;
      declStr += cleaned[i];
      i++;
    }

    if (selector) {
      const declarations = declStr
        .split(';')
        .map(d => d.trim())
        .filter(d => d.length > 0);

      rules.push({ selector, declarations, line: ruleLine, file: filename });
    }
  }

  return rules;
}

function calculateSpecificity(selector: string): [number, number, number] {
  // Remove pseudo-elements (count as element)
  let s = selector.replace(/::[a-zA-Z-]+/g, ' E');
  // Count IDs
  const ids = (s.match(/#[a-zA-Z_-][\w-]*/g) || []).length;
  s = s.replace(/#[a-zA-Z_-][\w-]*/g, '');
  // Count classes, attributes, pseudo-classes
  const classes = (s.match(/\.[a-zA-Z_-][\w-]*/g) || []).length +
    (s.match(/\[[^\]]*\]/g) || []).length +
    (s.match(/:[a-zA-Z-]+/g) || []).length;
  s = s.replace(/\.[a-zA-Z_-][\w-]*/g, '').replace(/\[[^\]]*\]/g, '').replace(/:[a-zA-Z-]+/g, '');
  // Count elements
  const elements = (s.match(/[a-zA-Z][\w-]*/g) || []).length;

  return [ids, classes, elements];
}

function auditCSS(cssFiles: { name: string; content: string }[], threshold: number): AuditReport {
  const allRules: CSSRule[] = [];
  const issues: AuditIssue[] = [];
  const fileStats: AuditReport['files'] = [];
  let totalSize = 0;

  for (const { name, content } of cssFiles) {
    const size = Buffer.byteLength(content, 'utf-8');
    totalSize += size;
    const rules = parseCSSRules(content, name);
    allRules.push(...rules);

    const selectors = rules.reduce((acc, r) => acc + r.selector.split(',').length, 0);
    fileStats.push({ name, size, rules: rules.length, selectors });
  }

  // Check specificity issues
  let highSpecCount = 0;
  for (const rule of allRules) {
    const selectors = rule.selector.split(',').map(s => s.trim());
    for (const sel of selectors) {
      const [ids, classes] = calculateSpecificity(sel);

      if (ids >= 2) {
        issues.push({
          type: 'specificity',
          message: `High specificity: ${ids} IDs in selector`,
          selector: sel,
          file: rule.file,
          line: rule.line,
          severity: 'error',
        });
        highSpecCount++;
      } else if (ids >= 1 && classes >= 2) {
        issues.push({
          type: 'specificity',
          message: `Moderate specificity: ${ids} ID + ${classes} classes`,
          selector: sel,
          file: rule.file,
          line: rule.line,
          severity: 'warning',
        });
        highSpecCount++;
      }

      // Overqualified selectors
      if (/^[a-z]+\./i.test(sel) || /^[a-z]+#/i.test(sel)) {
        issues.push({
          type: 'overqualified',
          message: `Overqualified selector (tag + class/id)`,
          selector: sel,
          file: rule.file,
          line: rule.line,
          severity: 'info',
        });
      }

      // Universal selector
      if (/^\*$/.test(sel.trim()) || /\s\*\s/.test(sel)) {
        issues.push({
          type: 'universal',
          message: 'Universal selector (*) can hurt performance',
          selector: sel,
          file: rule.file,
          line: rule.line,
          severity: 'info',
        });
      }

      // Deep nesting (more than 4 levels)
      const parts = sel.split(/[\s>+~]+/).filter(p => p.trim());
      if (parts.length > 4) {
        issues.push({
          type: 'specificity',
          message: `Deeply nested selector (${parts.length} levels)`,
          selector: sel,
          file: rule.file,
          line: rule.line,
          severity: 'warning',
        });
        highSpecCount++;
      }
    }
  }

  // Check !important abuse
  let importantCount = 0;
  for (const rule of allRules) {
    for (const decl of rule.declarations) {
      if (decl.includes('!important')) {
        importantCount++;
        issues.push({
          type: 'important',
          message: `!important used: ${decl.substring(0, 60)}`,
          selector: rule.selector,
          file: rule.file,
          line: rule.line,
          severity: 'warning',
        });
      }
    }
  }

  // Check duplicate declarations
  const declMap = new Map<string, { rule: CSSRule; decl: string }[]>();
  let duplicateCount = 0;
  for (const rule of allRules) {
    for (const decl of rule.declarations) {
      const prop = decl.split(':')[0]?.trim();
      const val = decl.split(':').slice(1).join(':').trim();
      if (!prop || !val) continue;
      const key = `${prop}:${val}`;
      if (!declMap.has(key)) declMap.set(key, []);
      declMap.get(key)!.push({ rule, decl });
    }
  }

  for (const [key, entries] of declMap) {
    if (entries.length > 2) {
      duplicateCount += entries.length - 1;
      issues.push({
        type: 'duplicate',
        message: `Declaration "${key}" appears ${entries.length} times`,
        selector: entries.map(e => e.rule.selector).join(', '),
        file: entries[0].rule.file,
        line: entries[0].rule.line,
        severity: 'warning',
      });
    }
  }

  // Calculate scores (0-100, higher is better)
  const totalDecls = allRules.reduce((acc, r) => acc + r.declarations.length, 0);

  const specificityScore = Math.max(0, 100 - (highSpecCount / Math.max(allRules.length, 1)) * 200);
  const duplicateScore = Math.max(0, 100 - (duplicateCount / Math.max(totalDecls, 1)) * 300);
  const importantScore = Math.max(0, 100 - (importantCount / Math.max(totalDecls, 1)) * 500);

  // File size score: 100 for < 10KB, scales down
  let fileSizeScore = 100;
  if (totalSize > 100000) fileSizeScore = 30;
  else if (totalSize > 50000) fileSizeScore = 50;
  else if (totalSize > 25000) fileSizeScore = 70;
  else if (totalSize > 10000) fileSizeScore = 85;

  const overall = Math.round(
    specificityScore * 0.3 +
    duplicateScore * 0.25 +
    importantScore * 0.25 +
    fileSizeScore * 0.2
  );

  const scores = {
    overall: Math.round(overall),
    specificity: Math.round(specificityScore),
    duplicates: Math.round(duplicateScore),
    important: Math.round(importantScore),
    fileSize: Math.round(fileSizeScore),
  };

  const status = overall >= threshold ? 'PASS' : 'FAIL';
  const summary = `${status}: Overall score ${overall}/100 (threshold: ${threshold})`;

  return {
    files: fileStats,
    totalSize,
    totalRules: allRules.length,
    totalSelectors: allRules.reduce((acc, r) => acc + r.selector.split(',').length, 0),
    issues,
    scores,
    summary,
  };
}

function printScoreBar(label: string, score: number, width: number = 20): void {
  const filled = Math.round((score / 100) * width);
  const empty = width - filled;
  let color = c.green;
  if (score < 50) color = c.red;
  else if (score < 75) color = c.yellow;

  const bar = color + '\u2588'.repeat(filled) + c.dim + '\u2591'.repeat(empty) + c.reset;
  console.log(`  ${label.padEnd(14)} ${bar} ${color}${score}${c.reset}/100`);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const jsonOutput = !!args.json;
  const threshold = parseInt(args.threshold as string) || 60;
  let cssFiles: { name: string; content: string }[] = [];

  // Get CSS content
  if (args.url) {
    if (!jsonOutput) {
      console.log(`\n${c.bgMagenta}${c.white}${c.bold} CSS-AUDIT ${c.reset}\n`);
      console.log(`${c.dim}Fetching CSS from:${c.reset} ${args.url}\n`);
    }
    cssFiles = await extractCSSFromUrl(args.url as string);
  } else if (args.input) {
    const inputPath = path.resolve(args.input as string);

    if (!fs.existsSync(inputPath)) {
      console.error(`${c.red}${c.bold}Error:${c.reset} Path not found: ${inputPath}`);
      process.exit(1);
    }

    const stat = fs.statSync(inputPath);
    if (stat.isDirectory()) {
      const files = findCSSFiles(inputPath);
      for (const file of files) {
        cssFiles.push({ name: path.relative(inputPath, file), content: fs.readFileSync(file, 'utf-8') });
      }
    } else {
      cssFiles.push({ name: path.basename(inputPath), content: fs.readFileSync(inputPath, 'utf-8') });
    }

    if (!jsonOutput) {
      console.log(`\n${c.bgMagenta}${c.white}${c.bold} CSS-AUDIT ${c.reset}\n`);
      console.log(`${c.dim}Auditing:${c.reset} ${inputPath}\n`);
    }
  } else {
    console.error(`${c.red}${c.bold}Error:${c.reset} No input provided.`);
    console.error(`Run ${c.cyan}css-audit --help${c.reset} for usage info.\n`);
    process.exit(1);
  }

  if (cssFiles.length === 0) {
    console.error(`${c.red}${c.bold}Error:${c.reset} No CSS files found.`);
    process.exit(1);
  }

  const report = auditCSS(cssFiles, threshold);

  if (jsonOutput) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    // File summary
    console.log(`${c.bold}Files Analyzed:${c.reset}`);
    for (const file of report.files) {
      console.log(`  ${c.cyan}${file.name}${c.reset} ${c.dim}(${formatBytes(file.size)}, ${file.rules} rules, ${file.selectors} selectors)${c.reset}`);
    }

    console.log(`\n${c.bold}Total:${c.reset} ${formatBytes(report.totalSize)} | ${report.totalRules} rules | ${report.totalSelectors} selectors\n`);

    // Scores
    console.log(`${c.bold}Health Scores:${c.reset}`);
    printScoreBar('Overall', report.scores.overall);
    printScoreBar('Specificity', report.scores.specificity);
    printScoreBar('Duplicates', report.scores.duplicates);
    printScoreBar('!important', report.scores.important);
    printScoreBar('File Size', report.scores.fileSize);

    // Issues
    if (report.issues.length > 0) {
      const errors = report.issues.filter(i => i.severity === 'error');
      const warnings = report.issues.filter(i => i.severity === 'warning');
      const infos = report.issues.filter(i => i.severity === 'info');

      console.log(`\n${c.bold}Issues Found: ${report.issues.length}${c.reset}`);
      if (errors.length > 0) console.log(`  ${c.red}\u2716 ${errors.length} errors${c.reset}`);
      if (warnings.length > 0) console.log(`  ${c.yellow}\u26A0 ${warnings.length} warnings${c.reset}`);
      if (infos.length > 0) console.log(`  ${c.blue}\u2139 ${infos.length} info${c.reset}`);

      console.log('');
      const topIssues = report.issues.slice(0, 15);
      for (const issue of topIssues) {
        const icon = issue.severity === 'error' ? `${c.red}\u2716` : issue.severity === 'warning' ? `${c.yellow}\u26A0` : `${c.blue}\u2139`;
        console.log(`  ${icon}${c.reset} ${issue.message}`);
        console.log(`    ${c.dim}${issue.file}:${issue.line} | ${issue.selector.substring(0, 60)}${c.reset}`);
      }

      if (report.issues.length > 15) {
        console.log(`\n  ${c.dim}... and ${report.issues.length - 15} more issues. Use --json for full report.${c.reset}`);
      }
    } else {
      console.log(`\n${c.green}${c.bold}No issues found! Your CSS looks clean.${c.reset}`);
    }

    // Final verdict
    const pass = report.scores.overall >= threshold;
    console.log(`\n${pass ? c.green : c.red}${c.bold}${report.summary}${c.reset}\n`);
  }

  // Exit with error code if below threshold
  if (report.scores.overall < threshold) {
    process.exit(1);
  }
}

function findCSSFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      files.push(...findCSSFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.css')) {
      files.push(fullPath);
    }
  }
  return files;
}

main().catch((err) => {
  console.error(`${c.red}${c.bold}Error:${c.reset} ${err.message}`);
  process.exit(1);
});
