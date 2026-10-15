import { OpenAITranslationModel, translateSafetyAssertion } from "./translator.js";

const key = process.env.OPENAI_API_KEY;
if (key === undefined || key.length === 0) throw new Error("OPENAI_API_KEY is required");
const model = new OpenAITranslationModel({ apiKey: key, model: process.env.OPENAI_TRANSLATION_MODEL });
const proposal = await translateSafetyAssertion("A fixed checkout issue must not recur after deployment", model);
if (!proposal.supported || proposal.templateId !== "recurrence") throw new Error("Live OpenAI smoke did not select the reviewed recurrence template");
process.stdout.write(`OpenAI translation smoke passed (${model.model}, recurrence).\n`);
