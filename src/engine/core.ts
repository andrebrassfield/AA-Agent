import type { EngineAdapter, AgentTurnInput, AgentTurnOutput } from "../types/engine.ts";
import type { ProviderRouter } from "../router/router.ts";
import type { ModelMessage } from "../types/router.ts";

export class CoreEngine implements EngineAdapter {
  name = "core";
  private router: ProviderRouter;

  constructor(router: ProviderRouter) {
    this.router = router;
  }

  private validateToolCall(toolCall: any): string[] {
    const errors: string[] = [];
    if (!toolCall || typeof toolCall !== "object") {
      return ["Tool call must be a JSON object."];
    }
    if (toolCall.name !== "manageBooking") {
      errors.push(`Unknown tool "${toolCall.name}". Only "manageBooking" is supported.`);
    }
    if (!toolCall.args || typeof toolCall.args !== "object") {
      errors.push("Missing or invalid 'args' object.");
      return errors;
    }
    const { action, bookingId, input } = toolCall.args;
    if (!["create", "reschedule", "cancel"].includes(action)) {
      errors.push("args.action must be one of 'create', 'reschedule', or 'cancel'.");
    }
    if (["reschedule", "cancel"].includes(action) && typeof bookingId !== "string") {
      errors.push(`args.bookingId is required as a string for action "${action}".`);
    }
    if (["create", "reschedule"].includes(action)) {
      if (!input || typeof input !== "object") {
        errors.push(`args.input object is required for action "${action}".`);
      } else {
        if (action === "create" && typeof input.customerName !== "string") errors.push("args.input.customerName is required for 'create'.");
        if (action === "create" && typeof input.customerPhone !== "string") errors.push("args.input.customerPhone is required for 'create'.");
        if (action === "create" && typeof input.serviceId !== "string") errors.push("args.input.serviceId is required for 'create'.");
        if (typeof input.requestedStartTime !== "string") errors.push("args.input.requestedStartTime is required as an ISO string.");
      }
    }
    return errors;
  }

  async processTurn(input: AgentTurnInput): Promise<AgentTurnOutput> {
    const { userMessage, context, conversationHistory } = input;
    const lowerMsg = userMessage.toLowerCase();

    // Guardrail check: AI never denies being AI if asked directly
    if (
      lowerMsg.includes("are you an ai") ||
      lowerMsg.includes("are you a human") ||
      lowerMsg.includes("are you a robot") ||
      lowerMsg.includes("is this an ai")
    ) {
      return {
        reply: `${context.clientConfig.persona.aiDisclosureWording} How may I assist you today?`,
        actionTaken: {
          type: "INFO_PROVIDED",
          details: { disclosureGiven: true },
        },
      };
    }

    const systemPrompt = `You are a front desk receptionist for ${context.clientConfig.business.name}, a ${context.clientConfig.business.trade} business.
Tone: ${context.clientConfig.persona.tone}.
Greeting: ${context.clientConfig.persona.greeting}.
Available services: ${context.clientConfig.services.services.map((s) => `${s.name} (id: ${s.id}, $${s.price}, ${s.durationMinutes}m)`).join(", ")}.

If asked to book, confirm the service, date/time, customer name, and phone number.
If details are missing, ask for them politely.
Once you have all details to create, reschedule, or cancel a booking, output exactly this JSON block on its own line:
<tool_call>{"name": "manageBooking", "args": {"action": "create|reschedule|cancel", "bookingId": "optional_id", "input": {"customerName": "...", "customerPhone": "...", "serviceId": "...", "requestedStartTime": "ISO_String"}}}</tool_call>
`;

    const messages: ModelMessage[] = [
      { role: "system" as const, content: systemPrompt },
      ...conversationHistory,
      { role: "user" as const, content: userMessage },
    ];

    let retries = 0;
    const MAX_RETRIES = 2;

    while (retries <= MAX_RETRIES) {
      const modelResponse = await this.router.complete({
        taskClass: "conversation",
        messages,
        temperature: 0.7,
      });

      let actionTaken: AgentTurnOutput["actionTaken"] = undefined;
      let reply = modelResponse.content;

      const toolCallMatch = reply.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
      if (toolCallMatch) {
        try {
          const toolCallRaw = toolCallMatch[1];
          const toolCall = JSON.parse(toolCallRaw);
          const validationErrors = this.validateToolCall(toolCall);

          if (validationErrors.length > 0) {
             if (retries >= MAX_RETRIES) {
               throw new Error(`Tool call validation failed after ${MAX_RETRIES} retries: ${validationErrors.join("; ")}`);
             }
             messages.push({ role: "assistant", content: reply });
             messages.push({ role: "user", content: `SYSTEM: Your tool call failed validation. Errors: ${validationErrors.join("; ")}. Please correct the JSON and try again.` });
             retries++;
             continue; // Retry
          }

          actionTaken = { type: "TOOL_CALL", details: toolCall };
          reply = reply.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();
        } catch (err: any) {
          if (retries >= MAX_RETRIES) {
             throw new Error(`Failed to parse tool call JSON after ${MAX_RETRIES} retries: ${err.message}`);
          }
          messages.push({ role: "assistant", content: reply });
          messages.push({ role: "user", content: `SYSTEM: Your tool call JSON was malformed. Error: ${err.message}. Please correct the JSON format and try again.` });
          retries++;
          continue; // Retry
        }
      }

      return {
        reply,
        actionTaken,
      };
    }

    throw new Error("Exceeded maximum retries for tool calls.");
  }
}
