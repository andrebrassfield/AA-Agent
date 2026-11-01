import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { DataStore } from "../db/store.ts";
import { FakeCalendar } from "../calendar/calendar.ts";
import { FORT_SMITH_HVAC_CONFIG } from "../demo/shop_data.ts";
import { handleBookingWorkflow } from "../workflows/booking.ts";

const server = new Server(
  {
    name: "booking-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const manageBookingTool: Tool = {
  name: "manageBooking",
  description: "Create, reschedule, or cancel bookings enforcing business rules.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["create", "reschedule", "cancel"] },
      bookingId: { type: "string" },
      customerName: { type: "string" },
      customerPhone: { type: "string" },
      serviceId: { type: "string" },
      requestedStartTime: { type: "string" },
    },
    required: ["action"],
  },
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [manageBookingTool],
  };
});

// Mock state for MCP
const store = new DataStore(":memory:");
const calendar = new FakeCalendar();

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "manageBooking") {
    throw new Error(`Tool ${request.params.name} not found`);
  }

  const args = request.params.arguments as any;
  const result = await handleBookingWorkflow(
    args,
    FORT_SMITH_HVAC_CONFIG,
    calendar,
    store
  );

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

run().catch(console.error);
