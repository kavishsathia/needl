import OpenAI from "openai";
import type { TemplateId } from "../src/domain.js";
import { defaultMeaningValues, meaningTemplates } from "../src/meaning.js";
import { unsupportedAuthoringIntent } from "../src/safety.js";

export interface TranslationProposal {
  readonly supported: boolean;
  readonly templateId?: TemplateId;
  readonly values?: Readonly<Record<string, string>>;
  readonly explanation: string;
  readonly rejectionReason?: string;
}

interface StructuredTranslation {
  readonly supported: boolean;
  readonly template_id: string;
  readonly explanation: string;
  readonly rejection_reason: string;
}

export interface TranslationModel {
  translate(input: string): Promise<unknown>;
  readonly model: string;
}

const outputSchema = {
  type: "object",
  properties: {
    supported: { type: "boolean", description: "True only when the statement maps without changing intent to one reviewed safety template." },
    template_id: { type: "string", enum: ["recurrence", "feature", "order", "none"] },
    explanation: { type: "string", description: "A short plain-language explanation of the proposed interpretation." },
    rejection_reason: { type: "string", description: "Empty when supported; otherwise explain why this is not finite-evidence safety intent." },
  },
  required: ["supported", "template_id", "explanation", "rejection_reason"],
  additionalProperties: false,
} as const;

export class OpenAITranslationModel implements TranslationModel {
  readonly model: string;
  readonly #client: OpenAI;

  constructor(options: { readonly apiKey: string; readonly model?: string }) {
    this.model = options.model ?? "gpt-4o-mini";
    this.#client = new OpenAI({ apiKey: options.apiKey });
  }

  async translate(input: string): Promise<unknown> {
    const response = await this.#client.responses.create({
      model: this.model,
      max_output_tokens: 300,
      input: [
        { role: "system", content: "You translate business safety expectations into exactly one reviewed Needl template. recurrence means a linked issue must not recur after a deployed fix. feature means errors must not occur while a named feature is disabled. order means an accepted order must not be fulfilled before payment is observed. Reject deadlines, eventual promises, requests for actions, and intent that would require inventing facts. Do not silently rewrite intent." },
        { role: "user", content: input },
      ],
      text: { format: { type: "json_schema", name: "needl_translation", strict: true, schema: outputSchema } },
    });
    if (response.status !== "completed" || response.output_text.length === 0) throw new Error("Translation model did not return a complete structured response");
    return JSON.parse(response.output_text);
  }
}

function parseStructured(value: unknown): StructuredTranslation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Translation model returned malformed structured output");
  const candidate = value as Partial<StructuredTranslation>;
  if (typeof candidate.supported !== "boolean" || typeof candidate.template_id !== "string" || typeof candidate.explanation !== "string" || typeof candidate.rejection_reason !== "string") {
    throw new Error("Translation model returned malformed structured output");
  }
  return candidate as StructuredTranslation;
}

export async function translateSafetyAssertion(input: string, model: TranslationModel): Promise<TranslationProposal> {
  const normalized = input.trim();
  if (normalized.length < 8 || normalized.length > 1_000) throw new Error("Expectation must contain between 8 and 1,000 characters");
  if (unsupportedAuthoringIntent(normalized)) {
    return { supported: false, explanation: "Needl requires a condition that one finite observation can break.", rejectionReason: "Deadlines and eventual promises are outside the supported safety policy." };
  }
  const result = parseStructured(await model.translate(normalized));
  if (!result.supported) return { supported: false, explanation: result.explanation, rejectionReason: result.rejection_reason || "This intent is outside the reviewed safety templates." };
  if (!(result.template_id in meaningTemplates)) throw new Error("Translation model selected an unsupported template");
  const templateId = result.template_id as TemplateId;
  return { supported: true, templateId, values: defaultMeaningValues(templateId), explanation: result.explanation };
}
