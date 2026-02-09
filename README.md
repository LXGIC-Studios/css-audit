# @lxgicstudios/css-audit

[![npm version](https://img.shields.io/npm/v/@lxgicstudios/css-audit)](https://www.npmjs.com/package/@lxgicstudios/css-audit)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-blue)](https://www.npmjs.com/package/@lxgicstudios/css-audit)

Audit CSS files for bloat, specificity problems, duplicate declarations, and `!important` abuse. Get a health report with actionable scores. Supports auditing live websites too.

Your CSS shouldn't be a mess. This tool tells you exactly where the problems are.

## Install

```bash
# Use directly with npx
npx @lxgicstudios/css-audit ./styles

# Or install globally
npm install -g @lxgicstudios/css-audit
```

## Usage

```bash
# Audit a single CSS file
css-audit styles.css

# Audit an entire directory
css-audit ./src/styles

# Audit a live website
css-audit --url https://example.com

# CI mode with minimum score
css-audit styles.css --threshold 80 --json

# JSON output for build pipelines
css-audit ./styles --json
```

## What It Checks

- **Specificity issues** - deeply nested selectors, multiple IDs, overqualified selectors
- **Duplicate declarations** - the same property:value pair repeated across rules
- **!important abuse** - overuse of `!important` flags
- **Overqualified selectors** - `div.class` or `tag#id` patterns
- **Universal selector usage** - `*` selectors that hurt performance
- **File size** - whether your CSS is getting too large

## Health Scores

You'll get scores from 0-100 in four categories:

| Category | Weight | What It Measures |
|----------|--------|------------------|
| Specificity | 30% | How complex your selectors are |
| Duplicates | 25% | Repeated declarations across rules |
| !important | 25% | How often you're forcing styles |
| File Size | 20% | Total CSS weight |

The overall score is a weighted average. Aim for 75+ on healthy projects.

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `--url <url>` | Audit CSS from a live website | - |
| `--threshold <n>` | Minimum passing score (0-100) | 60 |
| `--no-color` | Disable colored output | false |
| `--json` | Output results as JSON | false |
| `--help` | Show help message | - |

## Features

- Zero external dependencies - uses Node.js built-in modules only
- Audits local files, directories, or live URLs
- Color-coded health report with visual score bars
- JSON output for CI/CD integration
- Exits with code 1 when below threshold (great for pipelines)
- Groups issues by severity: errors, warnings, info

---

**Built by [LXGIC Studios](https://lxgicstudios.com)**

[GitHub](https://github.com/lxgicstudios/css-audit) | [Twitter](https://x.com/lxgicstudios)
