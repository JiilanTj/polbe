import OpenAI from "openai";
import { config } from "../config";

const openai = new OpenAI({ apiKey: config.openai.apiKey });

export interface GeneratedQuestion {
  question: string;
  questionId: string;
  description: string;
  descriptionId: string;
  category: string;
  resolutionDate: string; // ISO date string
  confidenceScore: number; // 0-1
  resolutionCriteria: string;
  resolutionCriteriaId: string;
}

export async function generateQuestions(
  articleTitles: string[],
  articleDescriptions: string[]
): Promise<GeneratedQuestion[]> {
  if (!config.openai.apiKey || articleTitles.length === 0) return [];

  const articlesContext = articleTitles
    .slice(0, 30)
    .map((title, i) => {
      const desc = articleDescriptions[i] ? ` - ${articleDescriptions[i]}` : "";
      return `${i + 1}. ${title}${desc}`;
    })
    .join("\n");

  const response = await openai.chat.completions.create({
    model: config.openai.model,
    messages: [
      {
        role: "system",
        content: `You are a Polymarket prediction market expert. Based on news articles, generate prediction market questions.

Rules:
- Questions must be YES/NO answerable
- Questions must start with "Will" or similar predictive framing
- Questions must have a clear resolution date
- Questions should be specific and unambiguous
- Focus on high-interest topics (politics, economy, crypto, tech, world events)
- Each question needs a resolution date (realistic future date)
- Generate 3-8 questions depending on how many distinct newsworthy topics exist
- Return both English and Indonesian versions for each generated field
- Indonesian text must be natural and meaning-preserving, not word-for-word literal translation

The current date is ${new Date().toISOString().split("T")[0]}.

Return a JSON array with this format:
[{
  "question": "Will X happen by/before Y date?",
  "questionId": "Apakah X akan terjadi sebelum/tanggal Y?",
  "description": "Context explaining the question and resolution criteria",
  "descriptionId": "Konteks penjelasan pertanyaan dan kriteria resolusinya",
  "category": "politics|economy|crypto|technology|world|sports|entertainment|science|health",
  "resolutionDate": "YYYY-MM-DD",
  "resolutionCriteria": "Clear English criteria for how this question resolves",
  "resolutionCriteriaId": "Kriteria resolusi yang jelas dalam Bahasa Indonesia",
  "confidenceScore": 0.0-1.0 (how good this question is for a prediction market)
}]
Return ONLY valid JSON, no markdown.`,
      },
      {
        role: "user",
        content: `Generate Polymarket-style prediction questions from these recent news articles:\n${articlesContext}`,
      },
    ],
    temperature: 0.7,
  });

  const raw = response.choices[0]?.message?.content;
  if (!raw) return [];
  const content = raw.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();

  try {
    return JSON.parse(content) as GeneratedQuestion[];
  } catch {
    console.error("[QuestionGen] Failed to parse AI response:", content);
    return [];
  }
}
