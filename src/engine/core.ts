import type { EngineAdapter, AgentTurnInput, AgentTurnOutput } from "../types/engine.ts";
import type { ProviderRouter } from "../router/router.ts";
import type { Booking } from "../types/db.ts";

export class CoreEngine implements EngineAdapter {
  name = "core";
  private router: ProviderRouter;

  constructor(router: ProviderRouter) {
    this.router = router;
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

    // Build prompt for conversation router
    const systemPrompt = `You are a front desk receptionist for ${context.clientConfig.business.name}, a ${context.clientConfig.business.trade} business.
Tone: ${context.clientConfig.persona.tone}.
Greeting: ${context.clientConfig.persona.greeting}.
Available services: ${context.clientConfig.services.services.map((s) => `${s.name} ($${s.price}, ${s.durationMinutes}m)`).join(", ")}.
If asked to book, confirm the service, date/time, and customer details.`;

    const messages = [
      { role: "system" as const, content: systemPrompt },
      ...conversationHistory,
      { role: "user" as const, content: userMessage },
    ];

    const modelResponse = await this.router.complete({
      taskClass: "conversation",
      messages,
      temperature: 0.7,
    });

    let actionTaken: AgentTurnOutput["actionTaken"] = undefined;

    // Detect if booking intent occurred
    if (lowerMsg.includes("book") || lowerMsg.includes("schedule") || lowerMsg.includes("appointment")) {
      const service = context.clientConfig.services.services[0];
      const startTime = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
      const endTime = new Date(Date.now() + 24 * 3600 * 1000 + (service?.durationMinutes || 60) * 60 * 1000).toISOString();

      const booking: Booking = {
        id: `bk-${Date.now()}`,
        customerName: "Valued Customer",
        customerPhone: context.senderPhone,
        serviceId: service?.id || "general",
        serviceName: service?.name || "Service Consultation",
        startTime,
        endTime,
        status: "confirmed",
        notes: `Booked via ${context.channel}`,
        createdAt: new Date().toISOString(),
      };

      actionTaken = {
        type: "BOOKING_CREATED",
        booking,
      };
    }

    return {
      reply: modelResponse.content,
      actionTaken,
    };
  }
}
