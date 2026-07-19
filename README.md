# ⚡ CodePulse

**AI-powered code review dashboard.** Paste any public GitHub repository URL and get an instant, senior-engineer-grade review — security, code quality, performance, maintainability, and documentation — powered by Groq + Llama 3.

## How it works

1. You submit a GitHub repo URL and pick an analysis focus (full, security, quality, or quick).
2. The server pulls the repo's file tree from the GitHub API, filters out noise (lockfiles, binaries, `node_modules`, tests, etc.), and ranks the remaining files by importance (entry points, config, routes/services/models score highest).
3. The top-scoring files (up to 15 files / 60k characters) are bundled into a prompt and sent to Groq's Llama 3.3 70B model.
4. The model returns a structured JSON review — overall score, letter grades per category, vulnerabilities with fixes, improvement suggestions, complexity assessment, and detected tech stack — rendered on the dashboard.

Works on **any public GitHub repository**, not just your own. Private repos work too, if `GITHUB_TOKEN` belongs to an account with access.

## Tech stack

- **Backend:** Node.js, Express
- **Frontend:** HTML5, CSS3, vanilla JS, GSAP
- **AI:** Groq API (Llama 3.3 70B)
- **Data source:** GitHub REST API

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env` and add your key:

```
GROQ_API_KEY=your_key_here
```

Get a free Groq API key at [console.groq.com](https://console.groq.com).

```bash
npm start
```

Visit **http://localhost:3000**.

### Optional: raise the GitHub rate limit

Without a token, GitHub API requests are capped at 60/hour. Add a [personal access token](https://github.com/settings/tokens) (no scopes needed for public repos) to `.env` as `GITHUB_TOKEN` to raise this to 5,000/hour.

## API

| Route | Method | Description |
|---|---|---|
| `/api/repo-info` | GET | `?repoUrl=` — fetch basic repo metadata |
| `/api/analyze` | POST | `{ repoUrl, analysisType }` — run a full AI review |

`analysisType` is one of `full`, `security`, `quality`, `quick`.

## License

MIT
