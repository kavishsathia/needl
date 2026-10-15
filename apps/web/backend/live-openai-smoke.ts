import { OpenAITranslationModel, translateSafetyAssertion } from "./translator.js";

const key = process.env.OPENAI_API_KEY;
if (key === undefined || key.length === 0) throw new Error("OPENAI_API_KEY is required");
const model = new OpenAITranslationModel({ apiKey: key, model: process.env.OPENAI_TRANSLATION_MODEL });
const proposal = await translateSafetyAssertion("A customer who cancels their subscription must never be charged again", model);
if (!proposal.supported || proposal.templateId !== "clean-break") throw new Error("Live OpenAI smoke did not select the reviewed clean-break template");
process.stdout.write(`OpenAI translation smoke passed (${model.model}, clean-break).\n`);
