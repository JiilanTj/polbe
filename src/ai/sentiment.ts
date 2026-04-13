import OpenAI from "openai";
import { config } from "../config";

const openai = new OpenAI({ apiKey: config.openai.apiKey });

interface SentimentResult {
  sentiment: "positive" | "negative" | "neutral";
  score: number; // -1.0 to 1.0
}

export async function analyzeSentiment(texts: string[]): Promise<SentimentResult[]> {
  if (!config.openai.apiKey || texts.length === 0) return [];

  const batch = texts.slice(0, 20);
  const numbered = batch.map((t, i) => `${i + 1}. ${t}`).join("\n");

  const response = await openai.chat.completions.create({
    model: config.openai.model,
    messages: [
      {
        role: "system",
        content: `You are a sentiment analysis expert. Analyze the sentiment of each headline.
Return a JSON array with this format:
[{ "sentiment": "positive" | "negative" | "neutral", "score": number (-1.0 to 1.0) }]
Return one result per headline in the same order. Return ONLY valid JSON, no markdown.`,
      },
      {
        role: "user",
        content: `Analyze sentiment for these headlines:\n${numbered}`,
      },
    ],
    temperature: 0.1,
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) return [];

  try {
    const content = raw.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
    return JSON.parse(content) as SentimentResult[];
  } catch {
    console.error("[Sentiment] Failed to parse AI response:", raw);
    return [];
  }
}
