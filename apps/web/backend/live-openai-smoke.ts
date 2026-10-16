import { OpenAITranslationModel, translateToRule } from "./translator.js";

const key = process.env.OPENAI_API_KEY;
if (key === undefined || key.length === 0) throw new Error("OPENAI_API_KEY is required");
const model = new OpenAITranslationModel({ apiKey: key, model: process.env.OPENAI_TRANSLATION_MODEL });
const proposal = await translateToRule("A customer who cancels their subscription must never be charged again", model);
if (!proposal.supported || proposal.source === undefined || !proposal.source.includes("stripe.customer.subscription.deleted")) {
  throw new Error(`Live OpenAI smoke did not write a checked cancellation rule: ${JSON.stringify(proposal)}`);
}
process.stdout.write(`OpenAI rule smoke passed (${model.model}, ${proposal.attempts} attempt${proposal.attempts === 1 ? "" : "s"}).\n`);
