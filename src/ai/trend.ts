import OpenAI from "openai";
import { config } from "../config";

const openai = new OpenAI({ apiKey: config.openai.apiKey });

interface TrendResult {
  topic: string;
  category: string;
  mentionCount: number;
  trendScore: number;
}

export async function detectTrends(articleTitles: string[]): Promise<TrendResult[]> {
  if (!config.openai.apiKey || articleTitles.length === 0) return [];

  const titlesText = articleTitles.slice(0, 100).join("\n- ");

  const response = await openai.chat.completions.create({
    model: config.openai.model,
    messages: [
      {
        role: "system",
        content: `You are a trend analysis expert. Analyze news headlines and identify trending topics.
Return a JSON array of trending topics with this format:
[{ "topic": "string", "category": "politics|economy|crypto|technology|world|sports|entertainment|science|health", "mentionCount": number, "trendScore": number (0-100) }]
Focus on topics that could become prediction market questions. Return max 10 trends. Return ONLY valid JSON, no markdown.`,
      },
      {
        role: "user",
        content: `Analyze these recent headlines and identify trending topics:\n- ${titlesText}`,
      },
    ],
    temperature: 0.3,
  });

  const content = response.choices[0]?.message?.content;
  if (!content) return [];

  try {
    return JSON.parse(content) as TrendResult[];
  } catch {
    console.error("[Trend] Failed to parse AI response:", content);
    return [];
  }
}
