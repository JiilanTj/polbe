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

export interface SingleQuestionTranslationInput {
  question: string;
  description?: string | null;
  resolutionCriteria?: string | null;
  outcomes?: string[];
}

export interface SingleQuestionTranslationResult {
  questionId: string;
  descriptionId: string | null;
  resolutionCriteriaId: string | null;
  outcomesId: string[];
}

type PartialGeneratedQuestion = Partial<GeneratedQuestion> & Record<string, unknown>;

function stripCodeFences(raw: string): string {
  return raw.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
}

function parseJsonArray(raw: string): PartialGeneratedQuestion[] {
  const content = stripCodeFences(raw);
  const parsed = JSON.parse(content);
  return Array.isArray(parsed) ? (parsed as PartialGeneratedQuestion[]) : [];
}

function toText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sameText(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function normalizeOutcomeFallback(outcomes: string[]): string[] {
  return outcomes.map((item) => {
    const lower = item.trim().toLowerCase();
    if (lower === "yes") return "Ya";
    if (lower === "no") return "Tidak";
    return item;
  });
}

function normalizeQuestion(input: PartialGeneratedQuestion): GeneratedQuestion | null {
  const question = toText(input.question);
  const description = toText(input.description);
  const category = toText(input.category);
  const resolutionDate = toText(input.resolutionDate);
  const resolutionCriteria = toText(input.resolutionCriteria);
  const confidenceScore = Number(input.confidenceScore ?? 0.5);

  if (!question || !resolutionDate) return null;

  return {
    question,
    questionId: toText(input.questionId) || question,
    description,
    descriptionId: toText(input.descriptionId) || description,
    category,
    resolutionDate,
    confidenceScore: Number.isFinite(confidenceScore) ? Math.max(0, Math.min(1, confidenceScore)) : 0.5,
    resolutionCriteria,
    resolutionCriteriaId: toText(input.resolutionCriteriaId) || resolutionCriteria,
  };
}

function needsIndonesianBackfill(item: GeneratedQuestion): boolean {
  return (
    !item.questionId ||
    sameText(item.questionId, item.question) ||
    (!item.descriptionId && !!item.description) ||
    (!!item.description && sameText(item.descriptionId, item.description)) ||
    (!item.resolutionCriteriaId && !!item.resolutionCriteria) ||
    (!!item.resolutionCriteria && sameText(item.resolutionCriteriaId, item.resolutionCriteria))
  );
}

export async function translateSingleQuestionToIndonesian(
  input: SingleQuestionTranslationInput
): Promise<SingleQuestionTranslationResult> {
  const baseFallback: SingleQuestionTranslationResult = {
    questionId: input.question,
    descriptionId: input.description ?? null,
    resolutionCriteriaId: input.resolutionCriteria ?? null,
    outcomesId: normalizeOutcomeFallback(input.outcomes ?? []),
  };

  if (!config.openai.apiKey || !input.question.trim()) return baseFallback;

  try {
    const response = await openai.chat.completions.create({
      model: config.openai.model,
      messages: [
        {
          role: "system",
          content: `You are an expert English-to-Indonesian translator for prediction market content.
Return ONLY valid JSON object with this exact shape:
{"questionId":"...","descriptionId":"...","resolutionCriteriaId":"...","outcomesId":["..."]}
Rules:
- Keep meaning exact and natural in Bahasa Indonesia.
- Keep outcome count exactly the same as input outcomes count.
- If description or resolution criteria are empty in input, return empty string for those fields.`,
        },
        {
          role: "user",
          content: JSON.stringify({
            question: input.question,
            description: input.description ?? "",
            resolutionCriteria: input.resolutionCriteria ?? "",
            outcomes: input.outcomes ?? [],
          }),
        },
      ],
      temperature: 0.2,
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) return baseFallback;

    const parsed = JSON.parse(stripCodeFences(raw)) as Record<string, unknown>;
    const questionId = toText(parsed.questionId) || baseFallback.questionId;
    const descriptionId = toText(parsed.descriptionId) || baseFallback.descriptionId;
    const resolutionCriteriaId =
      toText(parsed.resolutionCriteriaId) || baseFallback.resolutionCriteriaId;

    let outcomesId = baseFallback.outcomesId;
    if (Array.isArray(parsed.outcomesId)) {
      const translatedOutcomes = parsed.outcomesId
        .map((item) => toText(item))
        .filter((item) => item.length > 0);
      if ((input.outcomes?.length ?? 0) === translatedOutcomes.length) {
        outcomesId = translatedOutcomes;
      }
    }

    return {
      questionId,
      descriptionId,
      resolutionCriteriaId,
      outcomesId,
    };
  } catch (error) {
    console.error("[QuestionGen] Failed single-question Indonesian translation:", error);
    return baseFallback;
  }
}

async function backfillIndonesianFields(items: GeneratedQuestion[]): Promise<GeneratedQuestion[]> {
  const pending = items
    .map((item, index) => ({ index, item }))
    .filter(({ item }) => needsIndonesianBackfill(item));

  if (pending.length === 0) return items;

  const promptData = pending.map(({ index, item }) => ({
    index,
    question: item.question,
    description: item.description,
    resolutionCriteria: item.resolutionCriteria,
  }));

  try {
    const response = await openai.chat.completions.create({
      model: config.openai.model,
      messages: [
        {
          role: "system",
          content: `You are a professional English-to-Indonesian translator for prediction market content.
Return a JSON array only. Keep the same order and keep each index unchanged.
Translate naturally into Bahasa Indonesia while preserving meaning.
Required format:
[{"index":0,"questionId":"...","descriptionId":"...","resolutionCriteriaId":"..."}]`,
        },
        {
          role: "user",
          content: `Translate these fields into Indonesian:\n${JSON.stringify(promptData)}`,
        },
      ],
      temperature: 0.2,
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) return items;

    const translated = parseJsonArray(raw);
    const byIndex = new Map<number, PartialGeneratedQuestion>();
    for (const row of translated) {
      const index = Number(row.index);
      if (Number.isFinite(index)) byIndex.set(index, row);
    }

    return items.map((item, index) => {
      const tr = byIndex.get(index);
      if (!tr) return item;
      const questionId = toText(tr.questionId);
      const descriptionId = toText(tr.descriptionId);
      const resolutionCriteriaId = toText(tr.resolutionCriteriaId);

      return {
        ...item,
        questionId: questionId || item.questionId || item.question,
        descriptionId: descriptionId || item.descriptionId || item.description,
        resolutionCriteriaId:
          resolutionCriteriaId || item.resolutionCriteriaId || item.resolutionCriteria,
      };
    });
  } catch (error) {
    console.error("[QuestionGen] Failed to backfill Indonesian fields:", error);
    return items;
  }
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

  try {
    const parsed = parseJsonArray(raw);
    const normalized = parsed
      .map(normalizeQuestion)
      .filter((item): item is GeneratedQuestion => item !== null);

    if (normalized.length === 0) return [];
    return await backfillIndonesianFields(normalized);
  } catch {
    console.error("[QuestionGen] Failed to parse AI response:", raw);
    return [];
  }
}
