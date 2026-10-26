// Secret-pattern flagging (assessment §4/R3). High-confidence shapes
// only; this is a safety net, not a guarantee. False positives on fake
// example keys are expected — the user reviews the plan list and passes
// --allow-secrets to override, rather than Memport silently suppressing.

export interface SecretMatch {
  pattern: string;
  excerpt: string;
}

interface Pattern {
  name: string;
  re: RegExp;
}

const PATTERNS: Pattern[] = [
  { name: "openai-key", re: /sk-[A-Za-z0-9]{20,}/ },
  { name: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: "github-token", re: /(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{20,}/ },
  { name: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "slack-token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "bearer-token", re: /Bearer [A-Za-z0-9_~+\/-]{20,}={0,2}/ },
  {
    name: "assigned-api-key",
    re: /(?:api[_-]?key|apikey|secret|token)\s*[:=]\s*['"][A-Za-z0-9_\-./+]{16,}['"]/i,
  },
];

/** Return one match per pattern hit (first occurrence each). */
export function findSecrets(body: string): SecretMatch[] {
  const out: SecretMatch[] = [];
  for (const p of PATTERNS) {
    const m = p.re.exec(body);
    if (m) {
      const start = Math.max(0, m.index - 12);
      const excerpt = body.slice(start, m.index + Math.min(m[0].length, 24)).replace(/\n/g, " ");
      out.push({ pattern: p.name, excerpt: excerpt.length > 40 ? excerpt.slice(0, 40) + "…" : excerpt });
    }
  }
  return out;
}
