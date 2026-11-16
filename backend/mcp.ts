
import "dotenv/config";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();

app.use(express.json({ limit: "1mb" }));

const API_BASE = (
  process.env.API_BASE_URL ?? "http://localhost:3003"
).replace(/\/+$/, "");

const PORT = Number(process.env.MCP_PORT ?? 3002);
const REQUEST_TIMEOUT = 15000;

async function callBackend(
  path: string,
  options?: RequestInit
): Promise<unknown> {
  let response: Response;

  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("Backend request timed out.");
    }

    throw new Error(
      `Could not connect to backend: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const responseText = await response.text();

  let result: unknown;

  try {
    result = responseText ? JSON.parse(responseText) : {};
  } catch {
    result = responseText.slice(0, 2000);
  }

  if (!response.ok) {
    throw new Error(
      `Backend returned HTTP ${response.status}: ${
        typeof result === "string"
          ? result
          : JSON.stringify(result)
      }`
    );
  }

  return result;
}

function toolResult(result: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}

function createMcpServer() {
  const server = new McpServer({
    name: "aegis-emergency-coordinator",
    version: "1.0.0",
  });

  server.registerTool(
    "create_emergency",
    {
      title: "Create Emergency",
      description:
        "Create a simulated emergency only when the user explicitly asks to simulate or test one.",
      inputSchema: {},
    },
    async () => {
      const result = await callBackend("/emergencies", {
        method: "POST",
        body: JSON.stringify({}),
      });

      return toolResult(result);
    }
  );

  server.registerTool(
    "list_emergencies",
    {
      title: "List Emergencies",
      description:
        "List current emergency incidents and their statuses.",
      inputSchema: {},
    },
    async () => {
      const result = await callBackend("/emergencies");
      return toolResult(result);
    }
  );

  server.registerTool(
    "get_emergency",
    {
      title: "Get Emergency Details",
      description:
        "Retrieve an emergency and its response timeline by ID.",
      inputSchema: {
        id: z.string().min(1).describe("The emergency incident ID"),
      },
    },
    async ({ id }) => {
      const result = await callBackend(
        `/emergencies/${encodeURIComponent(id)}`
      );

      return toolResult(result);
    }
  );

  server.registerTool(
    "respond_to_emergency",
    {
      title: "Respond to Emergency",
      description:
        "Record an explicit OKAY or NO_RESPONSE response for a simulated emergency.",
      inputSchema: {
        id: z.string().min(1).describe("The emergency incident ID"),
        response: z
          .enum(["OKAY", "NO_RESPONSE"])
          .describe("The person's response"),
      },
    },
    async ({ id, response }) => {
      const result = await callBackend(
        `/emergencies/${encodeURIComponent(id)}/respond`,
        {
          method: "POST",
          body: JSON.stringify({ response }),
        }
      );

      return toolResult(result);
    }
  );

  server.registerTool(
    "acknowledge_caregiver",
    {
      title: "Acknowledge Caregiver Alert",
      description:
        "Record acknowledgement of a simulated primary or backup caregiver alert.",
      inputSchema: {
        id: z.string().min(1).describe("The emergency incident ID"),
        caregiver: z
          .enum(["PRIMARY", "BACKUP"])
          .describe("Which caregiver acknowledges the alert"),
      },
    },
    async ({ id, caregiver }) => {
      const result = await callBackend(
        `/emergencies/${encodeURIComponent(id)}/caregiver-ack`,
        {
          method: "POST",
          body: JSON.stringify({ caregiver }),
        }
      );

      return toolResult(result);
    }
  );

  server.registerTool(
    "coordinate_household_event",
    {
      title: "Coordinate Household Event",
      description: `
Submit a household event to AEGIS for evaluation.

IMPORTANT: The type field must be exactly one of these values:

- DOORBELL: Someone pressed the doorbell.
- QUIET_HOURS: Quiet hours are active or being requested.
- CONFLICTING_REQUEST: Two household requests conflict.
- DEVICE_FAILURE: A household device or device action failed.
- SAFETY_EMERGENCY: A potential fire, gas leak, injury, or other safety emergency.

For every doorbell event, ALWAYS use DOORBELL.

A live match does not change the event type.
Use DOORBELL for a doorbell pressed while someone is watching a match.

Never invent, abbreviate, or modify event type values.
`,
      inputSchema: {
        type: z
          .enum([
            "DOORBELL",
            "QUIET_HOURS",
            "CONFLICTING_REQUEST",
            "DEVICE_FAILURE",
            "SAFETY_EMERGENCY",
          ])
          .describe("The type of household event"),

        description: z
          .string()
          .min(1)
          .describe("What happened in the household"),

        liveMatch: z
          .boolean()
          .optional()
          .describe("Whether the family is watching a live match"),

        quietHours: z
          .boolean()
          .optional()
          .describe("Whether quiet hours are active"),

        simulateFailure: z
          .boolean()
          .optional()
          .describe(
            "Simulate a primary action failure to test fallback recovery"
          ),
      },
    },
    async ({
      type,
      description,
      liveMatch,
      quietHours,
      simulateFailure,
    }) => {
      const result = await callBackend("/household/events", {
        method: "POST",
        body: JSON.stringify({
          type,
          description,
          context: {
            liveMatch: liveMatch ?? false,
            quietHours: quietHours ?? false,
            currentActivity: liveMatch
              ? "Watching a live match"
              : undefined,
          },
          simulateFailure: simulateFailure ?? false,
        }),
      });

      return toolResult(result);
    }
  );

  return server;
}

// Health check
app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "healthy",
    service: "AEGIS MCP Server",
    backend: API_BASE,
  });
});

// Stateless MCP endpoint
app.all("/mcp", async (req, res) => {
  const server = createMcpServer();

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  let closed = false;

  const closeResources = async () => {
    if (closed) return;

    closed = true;

    try {
      await transport.close();
    } catch (error) {
      console.error("MCP transport close error:", error);
    }

    try {
      await server.close();
    } catch (error) {
      console.error("MCP server close error:", error);
    }
  };

  res.on("close", () => {
    void closeResources();
  });

  try {
    await server.connect(transport);

    await transport.handleRequest(
      req,
      res,
      req.body
    );
  } catch (error) {
    console.error("MCP request failed:", error);

    if (!res.headersSent) {
      res.status(500).json({
        error: "MCP request failed",
        message:
          error instanceof Error
            ? error.message
            : "Unknown MCP error",
      });
    }

    await closeResources();
  }
});

app.listen(PORT, () => {
  console.log(`AEGIS MCP server running on port ${PORT}`);
  console.log(`MCP endpoint: /mcp`);
  console.log(`Health endpoint: /health`);
  console.log(`AEGIS backend API: ${API_BASE}`);
});
