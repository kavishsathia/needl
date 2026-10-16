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

const answer = (source: string, choices: { name: string; values: string[] }[] = []) => ({
  supported: true, name: "Clean break", source, choices, explanation: "Watches charges after cancellation.", rejection_reason: "",
});

const cleanBreak = `always (stripe.customer.subscription.deleted bind customer = customer -> never stripe.invoice.paid(customer = customer))`;

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

  it("types initial choices and rejects values the provider does not allow", async () => {
    const source = "never gitlab.deployment(status = \"failed\", environment = $environment)";
    await expect(translateToRule("No failed deploys to production, ever", scripted([answer(source, [{ name: "environment", values: ["production"] }])])))
      .resolves.toMatchObject({ supported: true, values: { environment: "production" } });
    const fixed = "never gitlab.deployment(status = $status)";
    const model = scripted([answer(fixed, [{ name: "status", values: ["exploded"] }]), answer(fixed, [{ name: "status", values: ["failed"] }])]);
    await expect(translateToRule("No failed deploys to production, ever", model)).resolves.toMatchObject({ values: { status: "failed" }, attempts: 2 });
  });

  it("refuses liveness the model writes and gives up after the attempt limit with the last problems", async () => {
    const model = scripted([answer("always (gitlab.deployment -> eventually linear.issue)")]);
    const proposal = await translateToRule("Every deploy must eventually be followed by an issue update", model);
    expect(proposal).toMatchObject({ supported: false, attempts: maximumAttempts });
    expect(proposal.rejectionReason).toMatch(/`eventually` has no time limit/);
  });

  it("passes on an explained refusal without a rule", async () => {
    const model = scripted([{ supported: false, name: "", source: "", choices: [], explanation: "Linear state names are not received.", rejection_reason: "Needl does not receive Linear workflow state names." }]);
    await expect(translateToRule("When I push to prod it should show as Done on Linear", model)).resolves.toEqual({
      supported: false, explanation: "Linear state names are not received.", rejectionReason: "Needl does not receive Linear workflow state names.", attempts: 1,
    });
  });

  it("keeps a valid rule whose only problem is a note, reading that part mechanically", async () => {
    const model = scripted([answer("never #\"a failed deploy\" gitlab.deployment(status = \"failed\")")]);
    await expect(translateToRule("Deploys must never fail", model)).resolves.toMatchObject({
      supported: true, attempts: 1, source: "never  gitlab.deployment(status = \"failed\")",
    });
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
