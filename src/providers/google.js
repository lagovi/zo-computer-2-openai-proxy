import { BaseProvider } from "./base.js";

export class GoogleProvider extends BaseProvider {
  async getModels(authHeader) {
    // Возвращаем список популярных моделей Gemini, чтобы они отображались в вашем UI
    return [
      {
        id: "gemini-1.5-pro",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "google",
      },
      {
        id: "gemini-1.5-flash",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "google",
      },
      {
        id: "gemini-2.5-pro",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "google",
      },
      {
        id: "gemini-2.5-flash",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "google",
      },
    ];
  }

  async handleCompletion(req, res, payload, authHeader) {
    res.status(501).json({
      error: {
        message:
          "Google AI Studio provider is ready in the architecture and will be fully enabled in Phase 2. Please use your Zo Computer key starting with 'zo_sk_' for now.",
        type: "not_implemented_yet",
        param: null,
        code: "provider_placeholder",
      },
    });
  }
}
