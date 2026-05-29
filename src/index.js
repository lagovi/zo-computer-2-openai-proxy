import express from "express";
import cors from "cors";
import { PORT } from "./config.js";
import v1Router from "./routes/v1.js";

const app = express();

// Настройка CORS для работы со сторонними веб-клиентами (NextChat, OpenWebUI и т.д.)
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// Парсинг JSON с запасом под длинные диалоги
app.use(express.json({ limit: "10mb" }));

// Корневой эндпоинт — отвечает без авторизации (идеально для пинга cron-job.org)
app.get("/", (req, res) => {
  res.json({
    status: "online",
    message: "Zo Computer & Google AI Studio OpenAI Proxy is running.",
    timestamp: new Date().toISOString(),
  });
});

// Подключаем роутер v1
app.use("/v1", v1Router);

// Обработка несуществующих маршрутов
app.use((req, res) => {
  res.status(404).json({
    error: {
      message: `Route ${req.method} ${req.url} not found`,
      type: "invalid_request_error",
      param: null,
      code: "resource_not_found",
    },
  });
});

// Глобальный обработчик ошибок
app.use((err, req, res, next) => {
  console.error("Unhandled application error:", err);
  res.status(500).json({
    error: {
      message: "Internal server error occurred on the proxy.",
      type: "api_error",
      param: null,
      code: "internal_error",
    },
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[Proxy] Server started successfully on http://0.0.0.0:${PORT}`);
  console.log(`[Proxy] Healthcheck available at GET http://localhost:${PORT}/`);
});
