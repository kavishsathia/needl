import { describe, expect, it } from "vitest";
import { maximumAttempts, systemPrompt, translateToRule, type ChatMessage, type TranslationModel } from "./translator.js";

function scripted(outputs: readonly unknown[]): TranslationModel & { readonly calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  let index = 0;
  return {
    model: "fixture-model",
    calls,
    async complete(messages) {
      calls.push([...messages]);
      return outputs[Math.min(index++, outputs.length - 1)];
    },
  };
}

const answer = (source: string) => ({
  supported: true, name: "Clean break", source, explanation: "Watches charges after cancellation.", rejection_reason: "",
});

const cleanBreak = `rule "A customer who cancels must never pay an invoice again"
always (stripe.customer.subscription.deleted bind customer = customer -> never stripe.invoice.paid(customer = customer))`;

describe("translateToRule", () => {
  it("returns a rule only after it passes the checker", async () => {
    const model = scripted([answer(cleanBreak)]);
    await expect(translateToRule("A canceled customer must never be charged again", model)).resolves.toMatchObject({
      supported: true, name: "Clean break", source: cleanBreak, values: {}, attempts: 1,
    });
  });

  it("feeds checker errors back to the model and accepts the repaired rule", async () => {
    const model = scripted([
      answer("always (stripe.subscription.deleted bind customer = customer -> never stripe.invoice.paid(customer = customer))"),
      answer(cleanBreak),
    ]);
    const proposal = await translateToRule("A canceled customer must never be charged again", model);
    expect(proposal).toMatchObject({ supported: true, attempts: 2 });
    const repair = model.calls[1]!.at(-1)!;
    expect(repair.role).toBe("user");
    expect(repair.content).toMatch(/line 1, column 9: stripe has no event "subscription.deleted"/);
  });

  it("sends back defaults the provider does not allow and asks for a missing sentence", async () => {
    const bad = "rule \"No {status} deploys\"\ninput status: text = \"exploded\"\nnever gitlab.deployment(status = $status)";
    const good = bad.replace("exploded", "failed");
    const model = scripted([answer(bad), answer("never gitlab.deployment(status = \"failed\")"), answer(good)]);
    await expect(translateToRule("No failed deploys to production, ever", model)).resolves.toMatchObject({ supported: true, source: good, values: {}, attempts: 3 });
    expect(model.calls[1]!.at(-1)!.content).toMatch(/Default for status: "exploded" is not an allowed status/);
    expect(model.calls[2]!.at(-1)!.content).toMatch(/Start the rule with its sentence/);
  });

  it("refuses liveness the model writes and gives up after the attempt limit with the last problems", async () => {
    const model = scripted([answer("always (gitlab.deployment -> eventually linear.issue)")]);
    const proposal = await translateToRule("Every deploy must eventually be followed by an issue update", model);
    expect(proposal).toMatchObject({ supported: false, attempts: maximumAttempts });
    expect(proposal.rejectionReason).toMatch(/`eventually` has no time limit/);
  });

  it("passes on an explained refusal without a rule", async () => {
    const model = scripted([{ supported: false, name: "", source: "", explanation: "Linear state names are not received.", rejection_reason: "Needl does not receive Linear workflow state names." }]);
    await expect(translateToRule("When I push to prod it should show as Done on Linear", model)).resolves.toEqual({
      supported: false, explanation: "Linear state names are not received.", rejectionReason: "Needl does not receive Linear workflow state names.", attempts: 1,
    });
  });

  it("on the last attempt keeps a valid rule whose only problem is its sentence, read word for word", async () => {
    const model = scripted([answer("rule \"Deploys must never fail {x}\"\nnever gitlab.deployment(status = \"failed\")")]);
    await expect(translateToRule("Deploys must never fail", model)).resolves.toMatchObject({
      supported: true, attempts: maximumAttempts, source: "never gitlab.deployment(status = \"failed\")",
    });
    expect(model.calls[1]!.at(-1)!.content).toMatch(/no input x/);
  });

  it("rejects malformed structured output", async () => {
    await expect(translateToRule("A fixed issue must not recur", scripted([{ supported: true }]))).rejects.toThrow(/malformed/);
  });

  it("gives the model the language, the catalogue with connection status, and the worked examples", () => {
    const prompt = systemPrompt(new Set(["stripe"]));
    expect(prompt).toMatch(/NEEDL RULE LANGUAGE/);
    expect(prompt).toMatch(/Stripe \(stripe\) \[connected\]/);
    expect(prompt).toMatch(/GitLab \(gitlab\) \[not connected\]/);
    expect(prompt).toMatch(/stripe\.customer\.subscription\.deleted bind customer = customer/);
  });
});
