import { Router } from "express";
import { getProviderByKey } from "../providers/factory.js";

const router = Router();

// Маршрут: GET /v1/models
router.get("/models", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({
      error: {
        message: "Missing Authorization header.",
        type: "invalid_request_error",
      },
    });
  }

  const provider = getProviderByKey(authHeader);
  if (!provider) {
    return res.status(401).json({
      error: {
        message:
          "Invalid API key prefix. Use a Zo key starting with 'zo_sk_' or a Google key starting with 'AIza'.",
        type: "invalid_request_error",
      },
    });
  }

  try {
    const models = await provider.getModels(authHeader);
    res.json({
      object: "list",
      data: models,
    });
  } catch (err) {
    console.error("[Router] Models error:", err);
    res.status(500).json({
      error: {
        message: `Failed to fetch models from provider: ${err.message}`,
        type: "api_error",
      },
    });
  }
});

// Маршрут: POST /v1/chat/completions
router.post("/chat/completions", async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({
      error: {
        message: "Missing Authorization header.",
        type: "invalid_request_error",
      },
    });
  }

  const provider = getProviderByKey(authHeader);
  if (!provider) {
    return res.status(401).json({
      error: {
        message:
          "Invalid API key prefix. Use a Zo key starting with 'zo_sk_' or a Google key starting with 'AIza'.",
        type: "invalid_request_error",
      },
    });
  }

  const payload = req.body;
  if (
    !payload ||
    !Array.isArray(payload.messages) ||
    payload.messages.length === 0
  ) {
    return res.status(400).json({
      error: {
        message:
          "Invalid format. 'messages' array is required and cannot be empty.",
        type: "invalid_request_error",
      },
    });
  }

  try {
    await provider.handleCompletion(req, res, payload, authHeader);
  } catch (err) {
    console.error("[Router] Completions error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message: `Proxy error during chat completion: ${err.message}`,
          type: "api_error",
        },
      });
    }
  }
});

export default router;
