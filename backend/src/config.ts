const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ClaudeConfig {
  model: string;
  effort: Effort;
}

/**
 * Claude API の設定を環境変数から読む。
 * API キー自体は SDK が ANTHROPIC_API_KEY から読むので、ここでは存在だけ確かめる。
 */
export function loadClaudeConfig(env: NodeJS.ProcessEnv = process.env): ClaudeConfig {
  if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) {
    throw new Error(
      "ANTHROPIC_API_KEY が設定されていません。backend/.env.example を backend/.env にコピーして設定してください。",
    );
  }
  const effort = env.CLAUDE_EFFORT ?? "high";
  if (!(EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(`CLAUDE_EFFORT は ${EFFORTS.join(" | ")} のいずれかにしてください: ${effort}`);
  }
  return {
    model: env.CLAUDE_MODEL ?? "claude-opus-5-5",
    effort: effort as Effort,
  };
}
