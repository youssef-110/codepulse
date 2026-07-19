/*
 * CodePulse — AI Code Review Dashboard
 * Setup: npm install → copy .env.example to .env → add GROQ_API_KEY → npm start
 * Visit: http://localhost:3000
 * Get free Groq API key at: https://console.groq.com
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fetch = require('node-fetch');

const app = express();

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

const MAX_FILES = 15;
const MAX_CHARS_PER_FILE = 6000;
const MAX_TOTAL_CHARS = 60000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/*  Errors                                                             */
/* ------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function handleError(res, err) {
  const status = err.status || 500;
  const message = err.message || 'Unexpected server error.';
  console.error(`[CodePulse] ✖ Error ${status}: ${message}`);
  res.status(status).json({ error: message });
}

/* ------------------------------------------------------------------ */
/*  GitHub helpers                                                     */
/* ------------------------------------------------------------------ */

function parseGitHubUrl(repoUrl) {
  if (!repoUrl || typeof repoUrl !== 'string') {
    throw new HttpError(400, 'Missing repoUrl. Send a GitHub repository URL.');
  }
  const cleaned = repoUrl.trim().replace(/\.git$/i, '');
  const match = cleaned.match(/github\.com[/:]([\w.-]+)\/([\w.-]+)/i);
  if (!match) {
    throw new HttpError(400, 'Invalid GitHub URL. Expected format: https://github.com/owner/repo');
  }
  return { owner: match[1], repo: match[2] };
}

function githubHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'CodePulse-Analyzer'
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return headers;
}

async function githubFetch(url) {
  const res = await fetch(url, { headers: githubHeaders() });
  if (res.status === 404) {
    throw new HttpError(404, 'Repository not found. It may be private, deleted, or the URL is misspelled.');
  }
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      throw new HttpError(429, 'GitHub API rate limit exceeded. Add a GITHUB_TOKEN to .env to raise the limit (60 → 5,000 req/hour), or try again later.');
    }
    throw new HttpError(403, 'GitHub API access forbidden. The repository may be private.');
  }
  if (!res.ok) {
    throw new HttpError(res.status, `GitHub API error (${res.status} ${res.statusText}).`);
  }
  return res.json();
}

function shapeRepo(info) {
  return {
    name: info.name,
    fullName: info.full_name,
    owner: info.owner ? info.owner.login : undefined,
    description: info.description,
    stars: info.stargazers_count,
    forks: info.forks_count,
    language: info.language,
    defaultBranch: info.default_branch,
    openIssues: info.open_issues_count,
    url: info.html_url
  };
}

/* ------------------------------------------------------------------ */
/*  File selection — filter noise, rank by importance                  */
/* ------------------------------------------------------------------ */

const IGNORED_DIRS = [
  'node_modules', '.git', 'dist', 'build', 'out', 'vendor', 'coverage',
  '.next', '.nuxt', '.svelte-kit', '__pycache__', 'venv', '.venv',
  'bower_components', '.idea', '.vscode', 'assets/fonts', 'fixtures'
];

const IGNORED_FILES = [
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb',
  'composer.lock', 'gemfile.lock', 'poetry.lock', 'cargo.lock',
  '.ds_store', 'license', 'license.md', 'license.txt'
];

const IGNORED_SUFFIXES = [
  // images
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.bmp', '.avif',
  // fonts
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  // media + binaries
  '.mp3', '.mp4', '.wav', '.mov', '.pdf', '.zip', '.tar', '.gz', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm',
  // generated
  '.map', '.min.js', '.min.css', '.lock', '.snap'
];

const NAME_SCORES = {
  'package.json': 100, 'readme.md': 60,
  'server.js': 95, 'server.ts': 95, 'app.js': 92, 'app.ts': 92,
  'index.js': 90, 'index.ts': 90, 'main.js': 90, 'main.ts': 90,
  'app.py': 92, 'main.py': 92, 'manage.py': 85, 'settings.py': 82,
  'main.go': 92, 'main.rs': 92, 'index.html': 72,
  'requirements.txt': 78, 'go.mod': 76, 'cargo.toml': 76,
  'pom.xml': 74, 'build.gradle': 74, 'dockerfile': 68,
  'docker-compose.yml': 62, 'next.config.js': 58, 'vite.config.js': 55,
  'webpack.config.js': 55, 'tsconfig.json': 50
};

const EXT_SCORES = {
  '.js': 50, '.jsx': 52, '.ts': 52, '.tsx': 54, '.mjs': 50, '.cjs': 48,
  '.py': 52, '.go': 52, '.rs': 52, '.rb': 50, '.php': 48,
  '.java': 50, '.kt': 50, '.cs': 50, '.swift': 48, '.c': 46, '.cpp': 46,
  '.h': 38, '.vue': 52, '.svelte': 52, '.html': 34, '.css': 28,
  '.scss': 28, '.sql': 40, '.sh': 34, '.yml': 26, '.yaml': 26,
  '.json': 22, '.md': 16, '.toml': 24
};

function isAnalyzable(item) {
  if (item.type !== 'blob') return false;
  const p = item.path.toLowerCase();
  const parts = p.split('/');
  const name = parts[parts.length - 1];
  if (parts.some((part) => IGNORED_DIRS.includes(part))) return false;
  if (IGNORED_FILES.includes(name)) return false;
  if (IGNORED_SUFFIXES.some((suf) => name.endsWith(suf))) return false;
  if (typeof item.size === 'number' && (item.size > 200000 || item.size < 20)) return false;
  return true;
}

function scoreFile(item) {
  const p = item.path.toLowerCase();
  const parts = p.split('/');
  const name = parts[parts.length - 1];
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';

  let score = EXT_SCORES[ext] !== undefined ? EXT_SCORES[ext] : 5;
  if (NAME_SCORES[name]) score += NAME_SCORES[name];

  const depth = parts.length - 1;
  score -= depth * 6;

  if (/^(src|lib|app|server|api)\//.test(p)) score += 15;
  if (/(^|\/)(routes?|controllers?|models?|services?|middlewares?|auth|api|store|hooks|utils?|helpers?|core|config)\//.test(p)) score += 12;
  if (/(^|\/)(tests?|__tests__|spec|e2e|examples?|docs?)\//.test(p) || /\.(test|spec)\./.test(name)) score -= 25;

  if (typeof item.size === 'number') {
    if (item.size > 60000) score -= 20;
    else if (item.size > 20000) score -= 8;
  }
  return score;
}

async function fetchFileContent(owner, repo, branch, filePath) {
  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;
  const data = await githubFetch(url);
  if (!data || !data.content) return null;
  return Buffer.from(data.content, 'base64').toString('utf8');
}

/* ------------------------------------------------------------------ */
/*  Groq — AI analysis                                                 */
/* ------------------------------------------------------------------ */

const SYSTEM_PROMPT =
  'You are CodePulse, a principal software engineer performing an expert code review. ' +
  'You always respond with ONLY a single valid JSON object — no markdown, no code fences, ' +
  'no commentary before or after the JSON.';

const RESPONSE_STRUCTURE = `{
  "overallScore": <integer 0-100>,
  "grades": {
    "security": { "score": <integer 0-100>, "grade": "<A|B|C|D|F>" },
    "codeQuality": { "score": <integer 0-100>, "grade": "<A|B|C|D|F>" },
    "performance": { "score": <integer 0-100>, "grade": "<A|B|C|D|F>" },
    "maintainability": { "score": <integer 0-100>, "grade": "<A|B|C|D|F>" },
    "documentation": { "score": <integer 0-100>, "grade": "<A|B|C|D|F>" }
  },
  "summary": "<executive summary, 2-4 sentences>",
  "strengths": ["<3-5 specific strengths>"],
  "vulnerabilities": [
    {
      "severity": "<critical|high|medium|low>",
      "title": "<short title>",
      "description": "<what the problem is>",
      "location": "<file and/or function>",
      "fix": "<how to fix it>"
    }
  ],
  "suggestions": [
    {
      "category": "<performance|quality|security|architecture>",
      "title": "<short title>",
      "description": "<what to improve and why>",
      "priority": "<high|medium|low>",
      "codeExample": "<optional short code snippet, or empty string>"
    }
  ],
  "complexity": {
    "level": "<simple|moderate|complex|enterprise>",
    "description": "<complexity assessment>",
    "technicalDebt": "<low|medium|high>",
    "estimatedRefactorTime": "<e.g. 2-4 hours>"
  },
  "techStack": ["<detected technologies>"],
  "positiveHighlights": ["<good patterns found in the code>"]
}`;

const FOCUS_PROMPTS = {
  full: 'Perform a complete, balanced review covering security, code quality, performance, maintainability and documentation equally.',
  security: 'Focus primarily on SECURITY: injection risks, hardcoded secrets, auth flaws, unsafe dependencies, missing input validation. Weight the security grade heavily in the overall score and report every vulnerability you can find.',
  quality: 'Focus primarily on CODE QUALITY and maintainability: readability, structure, duplication, naming, error handling, testing and adherence to best practices.',
  quick: 'Perform a fast high-level scan. Keep the summary short and report only the 1-3 most important vulnerabilities and 2-3 top suggestions.'
};

function buildPrompt(repoInfo, analysisType, filesBundle) {
  const focus = FOCUS_PROMPTS[analysisType] || FOCUS_PROMPTS.full;
  return `Analyze the following repository and respond with ONLY valid JSON matching EXACTLY this structure (no markdown, no code fences, no text outside the JSON):

${RESPONSE_STRUCTURE}

Rules:
- Every score is an integer from 0 to 100. Every grade is a single letter: A, B, C, D or F.
- Include 3-5 strengths, up to 6 vulnerabilities (empty array if none found), and 3-6 suggestions.
- Be specific: reference real file names and functions from the provided source code.
- ${focus}

Repository: ${repoInfo.full_name}
Description: ${repoInfo.description || 'n/a'}
Primary language: ${repoInfo.language || 'unknown'}
Stars: ${repoInfo.stargazers_count}

Source files:

${filesBundle}`;
}

async function callGroq(prompt) {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.3,
      max_tokens: 4000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ]
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[CodePulse] Groq API error ${res.status}: ${body.slice(0, 300)}`);
    if (res.status === 401) {
      throw new HttpError(500, 'Groq API key is invalid or missing. Check GROQ_API_KEY in your .env file (get one free at https://console.groq.com).');
    }
    if (res.status === 429) {
      throw new HttpError(429, 'Groq API rate limit reached. Wait a moment and try again.');
    }
    throw new HttpError(502, `Groq API error (${res.status}). Try again in a moment.`);
  }

  const data = await res.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

function parseAnalysisJson(raw) {
  if (!raw) throw new HttpError(502, 'The AI returned an empty response. Try again.');
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new HttpError(502, 'The AI response was not valid JSON. Try again — this usually resolves on a retry.');
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new HttpError(502, 'Could not parse the AI analysis as JSON. Try again — this usually resolves on a retry.');
  }
}

function clampScore(n) {
  const v = Math.round(Number(n));
  if (Number.isNaN(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

function gradeForScore(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function normalizeGrade(g, score) {
  const letter = String(g || '').trim().charAt(0).toUpperCase();
  return ['A', 'B', 'C', 'D', 'F'].includes(letter) ? letter : gradeForScore(score);
}

function normalizeAnalysis(a) {
  const grades = a.grades || {};
  const category = (g) => {
    const score = clampScore(g && g.score);
    return { score, grade: normalizeGrade(g && g.grade, score) };
  };
  const asArray = (v) => (Array.isArray(v) ? v : []);
  const complexity = a.complexity || {};
  const overall = clampScore(a.overallScore);

  return {
    overallScore: overall,
    grades: {
      security: category(grades.security),
      codeQuality: category(grades.codeQuality),
      performance: category(grades.performance),
      maintainability: category(grades.maintainability),
      documentation: category(grades.documentation)
    },
    summary: String(a.summary || 'Analysis complete.'),
    strengths: asArray(a.strengths).map(String),
    vulnerabilities: asArray(a.vulnerabilities).map((v) => ({
      severity: ['critical', 'high', 'medium', 'low'].includes(String(v.severity).toLowerCase())
        ? String(v.severity).toLowerCase()
        : 'medium',
      title: String(v.title || 'Issue'),
      description: String(v.description || ''),
      location: String(v.location || ''),
      fix: String(v.fix || '')
    })),
    suggestions: asArray(a.suggestions).map((s) => ({
      category: ['performance', 'quality', 'security', 'architecture'].includes(String(s.category).toLowerCase())
        ? String(s.category).toLowerCase()
        : 'quality',
      title: String(s.title || 'Suggestion'),
      description: String(s.description || ''),
      priority: ['high', 'medium', 'low'].includes(String(s.priority).toLowerCase())
        ? String(s.priority).toLowerCase()
        : 'medium',
      codeExample: String(s.codeExample || '')
    })),
    complexity: {
      level: ['simple', 'moderate', 'complex', 'enterprise'].includes(String(complexity.level).toLowerCase())
        ? String(complexity.level).toLowerCase()
        : 'moderate',
      description: String(complexity.description || ''),
      technicalDebt: ['low', 'medium', 'high'].includes(String(complexity.technicalDebt).toLowerCase())
        ? String(complexity.technicalDebt).toLowerCase()
        : 'medium',
      estimatedRefactorTime: String(complexity.estimatedRefactorTime || '—')
    },
    techStack: asArray(a.techStack).map(String),
    positiveHighlights: asArray(a.positiveHighlights).map(String)
  };
}

/* ------------------------------------------------------------------ */
/*  Routes                                                             */
/* ------------------------------------------------------------------ */

app.get('/api/repo-info', async (req, res) => {
  try {
    const { owner, repo } = parseGitHubUrl(req.query.repoUrl);
    console.log(`[CodePulse] Repo info request → ${owner}/${repo}`);
    const info = await githubFetch(`https://api.github.com/repos/${owner}/${repo}`);
    res.json(shapeRepo(info));
  } catch (err) {
    handleError(res, err);
  }
});

app.post('/api/analyze', async (req, res) => {
  const startedAt = Date.now();
  try {
    if (!GROQ_API_KEY) {
      throw new HttpError(500, 'GROQ_API_KEY is not configured on the server. Copy .env.example to .env and add your key from https://console.groq.com.');
    }

    const { repoUrl, analysisType = 'full' } = req.body || {};
    console.log('\n[CodePulse] ────── New analysis request ──────');
    console.log(`[CodePulse] Repo URL: ${repoUrl} | Type: ${analysisType}`);

    const { owner, repo } = parseGitHubUrl(repoUrl);
    console.log(`[CodePulse] Parsed → owner: ${owner}, repo: ${repo}`);

    console.log('[CodePulse] Step 1/4 — Fetching repository metadata...');
    const info = await githubFetch(`https://api.github.com/repos/${owner}/${repo}`);
    console.log(`[CodePulse] Repo: ${info.full_name} (${info.language || 'unknown'}, ★${info.stargazers_count}, branch: ${info.default_branch})`);

    console.log('[CodePulse] Step 2/4 — Fetching file tree (recursive)...');
    const tree = await githubFetch(`https://api.github.com/repos/${owner}/${repo}/git/trees/${encodeURIComponent(info.default_branch)}?recursive=1`);
    const allFiles = tree.tree || [];
    console.log(`[CodePulse] Tree contains ${allFiles.length} entries${tree.truncated ? ' (truncated by GitHub — very large repo)' : ''}`);

    const selected = allFiles
      .filter(isAnalyzable)
      .map((f) => ({ path: f.path, size: f.size, score: scoreFile(f) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_FILES);

    if (selected.length === 0) {
      throw new HttpError(422, 'No analyzable source files found in this repository.');
    }
    console.log(`[CodePulse] Selected ${selected.length} files:`);
    selected.forEach((f) => console.log(`[CodePulse]   • ${f.path}`));

    console.log('[CodePulse] Step 3/4 — Downloading file contents...');
    const withContent = await Promise.all(
      selected.map(async (f) => {
        try {
          return { path: f.path, content: await fetchFileContent(owner, repo, info.default_branch, f.path) };
        } catch (e) {
          console.warn(`[CodePulse]   ⚠ Skipped ${f.path}: ${e.message}`);
          return { path: f.path, content: null };
        }
      })
    );

    let totalChars = 0;
    const bundleParts = [];
    const analyzedFiles = [];
    for (const f of withContent) {
      if (!f.content) continue;
      if (totalChars >= MAX_TOTAL_CHARS) break;
      let content = f.content.slice(0, MAX_CHARS_PER_FILE);
      if (totalChars + content.length > MAX_TOTAL_CHARS) {
        content = content.slice(0, MAX_TOTAL_CHARS - totalChars);
      }
      if (!content.trim()) continue;
      totalChars += content.length;
      bundleParts.push(`--- FILE: ${f.path} ---\n${content}`);
      analyzedFiles.push(f.path);
    }

    if (bundleParts.length === 0) {
      throw new HttpError(422, 'Could not read any file contents from this repository.');
    }

    console.log(`[CodePulse] Step 4/4 — Running AI analysis via Groq (${GROQ_MODEL}) — ${bundleParts.length} files, ${totalChars} chars...`);
    const raw = await callGroq(buildPrompt(info, analysisType, bundleParts.join('\n\n')));
    const analysis = normalizeAnalysis(parseAnalysisJson(raw));

    console.log(`[CodePulse] ✔ Analysis complete in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — overall score: ${analysis.overallScore}`);
    res.json({
      success: true,
      repo: shapeRepo(info),
      filesAnalyzed: analyzedFiles,
      analysis
    });
  } catch (err) {
    handleError(res, err);
  }
});

/* ------------------------------------------------------------------ */
/*  Start                                                              */
/* ------------------------------------------------------------------ */

app.listen(PORT, () => {
  console.log(`\n⚡ CodePulse running at http://localhost:${PORT}\n`);
  if (!GROQ_API_KEY) {
    console.warn('⚠  GROQ_API_KEY is missing — copy .env.example to .env and add your key.');
    console.warn('   Get a free key at: https://console.groq.com\n');
  }
  if (!GITHUB_TOKEN) {
    console.log('ℹ  No GITHUB_TOKEN set — using anonymous GitHub API (60 requests/hour).');
    console.log('   Add one in .env to raise the limit to 5,000/hour.\n');
  }
});
