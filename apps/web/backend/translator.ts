import OpenAI from "openai";
import type { Provider } from "../../../src/core/types.js";
import { checkRule, type CheckedRule, type CheckResult, type RuleIssue } from "../../../src/rules/check.js";
import { choiceIssues, type ParamValue, type ParamValues } from "../../../src/rules/compile.js";
import { describeCatalogue, ruleLanguageGuide } from "../../../src/rules/describe.js";
import type { RuleProposal } from "../src/domain.js";
import { exampleRules } from "../src/examples.js";

export type ChatMessage = { readonly role: "system" | "user" | "assistant"; readonly content: string };

/** One structured model call; the agent loop around it is model-independent and fully testable. */
export interface TranslationModel {
  complete(messages: readonly ChatMessage[]): Promise<unknown>;
  readonly model: string;
}

interface StructuredRule {
  readonly supported: boolean;
  readonly name: string;
  readonly source: string;
  readonly choices: readonly { readonly name: string; readonly values: readonly string[] }[];
  readonly explanation: string;
  readonly rejection_reason: string;
}

const outputSchema = {
  type: "object",
  properties: {
    supported: { type: "boolean", description: "True when you wrote a rule; false only when the request cannot be stated as a rule over the listed events." },
    name: { type: "string", description: "Short title for the rule, two to five words." },
    source: { type: "string", description: "The rule in the Needl rule language, with notes on the parts a person reads. Empty when unsupported." },
    choices: {
      type: "array",
      description: "Initial values for $choices the user's text pins down (e.g. production). Leave out choices the text does not settle.",
      items: {
        type: "object",
        properties: { name: { type: "string", description: "Choice name without $" }, values: { type: "array", items: { type: "string" }, description: "One value, or several for a choice used with in" } },
        required: ["name", "values"],
        additionalProperties: false,
      },
    },
    explanation: { type: "string", description: "One or two plain sentences: what the rule watches and any assumption you made." },
    rejection_reason: { type: "string", description: "Empty when supported. Otherwise what is missing, e.g. an event Needl does not receive, in plain words." },
  },
  required: ["supported", "name", "source", "choices", "explanation", "rejection_reason"],
  additionalProperties: false,
} as const;

/** Model calls per request: the first attempt plus repairs after checker errors. */
export const maximumAttempts = 3;

export function systemPrompt(connected?: ReadonlySet<Provider>): string {
  const examples = exampleRules.map((example) => [
    `Request: ${example.prompt}`,
    `Rule:\n${example.source}`,
    `Choices: ${JSON.stringify(Object.entries(example.values).map(([name, value]) => ({ name, values: [value].flat().map(String) })))}`,
  ].join("\n")).join("\n\n");
  return [
    "You write monitoring rules for Needl. A person describes something that must never go wrong across their tools; you write it as one rule in the Needl rule language below, using only the events and fields listed. Write exactly what they asked for: do not weaken, widen or narrow it to fit. If the request needs an event or field Needl does not receive, say so instead of substituting something else.",
    "Requests that wait for something (\"should be done\", \"must follow up\", \"needs to appear\") are fine with a time limit; if the person gives none, choose a sensible one as the initial value of a time-limit $choice and say so in the explanation.",
    "When the request leaves a link between tools implicit, use the usual convention the catalogue supports instead of refusing, and state the assumption in the explanation. For example, a branch or deployment is linked to a Linear issue by the issue key in the branch name (ref.issue_key = identifier), and \"prod\" means a successful deployment to the production environment (as a $choice).",
    "Integrations marked [not connected] are only not sending webhooks yet. Never refuse because an integration is not connected: write the rule, and mention in the explanation which integrations still need connecting.",
    ruleLanguageGuide,
    `INTEGRATIONS, EVENTS AND FIELDS\n${describeCatalogue(connected)}`,
    `WORKED EXAMPLES\n${examples}`,
    "Answer with the JSON object only.",
  ].join("\n\n");
}

export class OpenAITranslationModel implements TranslationModel {
  readonly model: string;
  readonly #client: OpenAI;

  constructor(options: { readonly apiKey: string; readonly model?: string }) {
    this.model = options.model ?? "gpt-6-sol";
    this.#client = new OpenAI({ apiKey: options.apiKey });
  }

  async complete(messages: readonly ChatMessage[]): Promise<unknown> {
    const response = await this.#client.responses.create({
      model: this.model,
      max_output_tokens: 16_000,
      input: messages.map((message) => ({ role: message.role, content: message.content })),
      text: { format: { type: "json_schema", name: "needl_rule", strict: true, schema: outputSchema } },
    });
    if (response.status !== "completed" || response.output_text.length === 0) throw new Error("Rule model did not return a complete structured response");
    return JSON.parse(response.output_text);
  }
}

function parseStructured(value: unknown): StructuredRule {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Rule model returned malformed structured output");
  const candidate = value as Partial<StructuredRule>;
  if (typeof candidate.supported !== "boolean" || typeof candidate.source !== "string" || typeof candidate.name !== "string"
    || typeof candidate.explanation !== "string" || typeof candidate.rejection_reason !== "string" || !Array.isArray(candidate.choices)) {
    throw new Error("Rule model returned malformed structured output");
  }
  return candidate as StructuredRule;
}

function typedChoices(rule: CheckedRule, choices: StructuredRule["choices"]): { values: ParamValues; problems: string[] } {
  const values: Record<string, ParamValue> = {};
  const problems: string[] = [];
  for (const choice of choices) {
    const param = rule.params.find((candidate) => candidate.name === choice.name.replace(/^\$/, ""));
    if (param === undefined) { problems.push(`choices: the rule has no $${choice.name}`); continue; }
    const items = choice.values.map((value) => param.type === "number" ? Number(value) : param.type === "boolean" ? value === "true" : value);
    if (items.some((item) => typeof item === "number" && !Number.isFinite(item))) { problems.push(`choices: $${param.name} needs numbers`); continue; }
    values[param.name] = param.list ? items : items[0]!;
  }
  // Report wrong values, but not missing ones: the user fills those in.
  problems.push(...choiceIssues(rule, values).filter((issue) => values[issue.param] !== undefined).map((issue) => `choices: ${issue.message}`));
  return { values, problems };
}

/** Drops the notes behind note-only problems: the parts are then read mechanically, and the rule is unchanged. */
function dropBrokenNotes(source: string, errors: readonly RuleIssue[]): string {
  const spans = [...new Map(errors.map((error) => [error.span.start, error.span])).values()].sort((left, right) => right.start - left.start);
  let output = source;
  for (const span of spans) output = output.slice(0, span.start) + output.slice(span.end);
  return output;
}

function checkWithNoteFallback(source: string, paramValues: Readonly<Record<string, unknown>>): { readonly source: string; readonly result: CheckResult } {
  const result = checkRule(source, { paramValues });
  if (result.ok || !result.errors.every((error) => error.kind === "note")) return { source, result };
  const repaired = dropBrokenNotes(source, result.errors);
  return { source: repaired, result: checkRule(repaired, { paramValues }) };
}

/**
 * Asks the model for a rule, then runs it through the same checker every rule passes. Checker errors (with line and
 * column) go back to the model to repair, up to `maximumAttempts` calls. Only a rule that passes is ever returned.
 */
export async function translateToRule(input: string, model: TranslationModel, connected?: ReadonlySet<Provider>): Promise<RuleProposal> {
  const normalized = input.trim();
  if (normalized.length < 8 || normalized.length > 1_000) throw new Error("Expectation must contain between 8 and 1,000 characters");
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt(connected) }, { role: "user", content: normalized }];
  let lastProblems: string[] = [];
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const raw = await model.complete(messages);
    const output = parseStructured(raw);
    if (!output.supported) {
      return { supported: false, explanation: output.explanation, rejectionReason: output.rejection_reason || "This cannot be written as a rule over the events Needl receives.", attempts: attempt };
    }
    const paramValues = Object.fromEntries(output.choices.map((choice) => [choice.name.replace(/^\$/, ""), choice.values]));
    const { source, result: checked } = checkWithNoteFallback(output.source, paramValues);
    if (checked.ok) {
      const { values, problems } = typedChoices(checked.rule, output.choices);
      if (problems.length === 0) {
        return { supported: true, name: output.name.trim() || normalized.slice(0, 60), source, values, explanation: output.explanation, attempts: attempt };
      }
      lastProblems = problems;
    } else {
      lastProblems = checked.errors.map((error) => `line ${error.span.line}, column ${error.span.column}: ${error.message}`);
    }
    messages.push(
      { role: "assistant", content: JSON.stringify(raw) },
      { role: "user", content: `The rule did not pass Needl's checker:\n${lastProblems.map((problem) => `- ${problem}`).join("\n")}\nFix these and answer again with the full JSON object.` },
    );
  }
  return {
    supported: false,
    explanation: "The model could not produce a rule that passes Needl's checker.",
    rejectionReason: `After ${maximumAttempts} attempts the rule still had problems: ${lastProblems.join("; ")}`,
    attempts: maximumAttempts,
  };
}
