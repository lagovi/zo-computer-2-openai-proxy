import { BaseProvider } from "./base.js";
import {
  calculateHash,
  getConversationId,
  saveConversationId,
} from "../utils/session-store.js";

export class ZoProvider extends BaseProvider {
  async getModels(authHeader) {
    const openaiModels = [];

    // Запрос стандартных моделей у Zo
    const fetchModels = async () => {
      const res = await fetch("https://api.zo.computer/models/available", {
        headers: { Authorization: authHeader },
      });
      if (!res.ok)
        throw new Error(`Zo Models API returned status ${res.status}`);
      const data = await res.json();
      return data.models || [];
    };

    // Запрос персон у Zo
    const fetchPersonas = async () => {
      const res = await fetch("https://api.zo.computer/personas/available", {
        headers: { Authorization: authHeader },
      });
      if (!res.ok)
        throw new Error(`Zo Personas API returned status ${res.status}`);
      const data = await res.json();
      return data.personas || [];
    };

    const [modelsResult, personasResult] = await Promise.allSettled([
      fetchModels(),
      fetchPersonas(),
    ]);

    if (modelsResult.status === "fulfilled") {
      for (const model of modelsResult.value) {
        openaiModels.push({
          id: model.model_name,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: model.vendor || "zo-computer",
        });
      }
    }

    if (personasResult.status === "fulfilled") {
      for (const persona of personasResult.value) {
        if (persona.id) {
          openaiModels.push({
            id: `persona:${persona.id}`,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "zo-personas",
          });
        }
      }
    }

    // Резервный вариант, если списки пусты
    if (openaiModels.length === 0) {
      openaiModels.push({
        id: "zo-computer-default",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "zo",
      });
    }

    return openaiModels;
  }

  async handleCompletion(req, res, payload, authHeader) {
    const messages = payload.messages;
    const isStream = !!payload.stream;

    console.log(
      `[ZoProvider] New request. Stream: ${isStream}, Messages count: ${messages.length}, Model: ${payload.model}`,
    );

    // 1. Поиск сессии (conversation_id) по истории предыдущих шагов
    let conversationId = null;
    let historyHash = null;

    if (messages.length > 1) {
      historyHash = calculateHash(authHeader, messages.slice(0, -1));
      conversationId = await getConversationId(historyHash);
      console.log(
        `[ZoProvider] Session search. Hash: ${historyHash}, Found conversation_id: ${conversationId}`,
      );
    } else {
      console.log(`[ZoProvider] Starting a fresh conversation (first turn).`);
    }

    // 2. Формируем пользовательский ввод
    const lastMessage = messages[messages.length - 1];
    let userInput = lastMessage.content || "";

    // Если это начало диалога и в массиве есть системный промпт — внедряем его
    if (!conversationId) {
      const systemMessage = messages.find((m) => m.role === "system");
      if (systemMessage && systemMessage.content) {
        userInput = `[System Instruction: ${systemMessage.content}]\n\nUser: ${userInput}`;
        console.log(
          `[ZoProvider] Injected system instructions into the first message.`,
        );
      }
    }

    // 3. Составляем полезную нагрузку для Zo API
    const zoPayload = {
      input: userInput,
      memory_mode: "enabled",
      stream: isStream,
    };

    if (conversationId) {
      zoPayload.conversation_id = conversationId;
    }

    if (payload.model) {
      if (payload.model.startsWith("persona:")) {
        zoPayload.persona_id = payload.model.substring(8);
        console.log(
          `[ZoProvider] Routing to custom Persona: ${zoPayload.persona_id}`,
        );
      } else {
        zoPayload.model_name = payload.model;
        console.log(
          `[ZoProvider] Routing to custom Model: ${zoPayload.model_name}`,
        );
      }
    }

    // 4. Отправляем запрос
    console.log(`[ZoProvider] Sending request to Zo API...`);
    const response = await fetch("https://api.zo.computer/zo/ask", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authHeader,
      },
      body: JSON.stringify(zoPayload),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(
        `[ZoProvider] Zo API returned HTTP ${response.status}: ${errText}`,
      );
      res.status(response.status).json({
        error: {
          message: `Zo API returned error: ${errText}`,
          type: "zo_api_error",
        },
      });
      return;
    }

    const responseId =
      "chatcmpl-" + Math.random().toString(36).substring(2, 15);

    // --- ОБЫЧНЫЙ (НЕСТРИМИНГОВЫЙ) РЕЖИМ ---
    if (!isStream) {
      const zoData = await response.json();
      const newConvId = zoData.conversation_id;

      console.log(
        `[ZoProvider] Non-stream response received. conversation_id: ${newConvId}`,
      );

      if (newConvId) {
        const nextTurnHash = calculateHash(authHeader, messages);
        await saveConversationId(nextTurnHash, newConvId);
        console.log(
          `[ZoProvider] Saved next turn hash: ${nextTurnHash} -> ${newConvId}`,
        );
      }

      res.json({
        id: responseId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: payload.model || "zo-computer",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: zoData.output || "",
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      });
      return;
    }

    // --- СТРИМИНГОВЫЙ (SSE) РЕЖИМ ---
    console.log(`[ZoProvider] Starting stream handling...`);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let currentEvent = "";

    // Структуры для отслеживания отправленного клиенту контента
    const sentLengthByIndex = {}; // index -> длина отправленного текста
    const partKinds = {}; // index -> "text" | "thinking"

    // Функция, вычисляющая только новые (не отправленные ранее) символы
    function getNewTextDelta(index, fullContent) {
      const alreadySent = sentLengthByIndex[index] || 0;
      if (fullContent.length > alreadySent) {
        const delta = fullContent.substring(alreadySent);
        sentLengthByIndex[index] = fullContent.length;
        return delta;
      }
      return "";
    }

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.log(`[ZoProvider] Stream reader finished (done=true).`);
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (let line of lines) {
          line = line.trim();
          if (!line) continue;

          console.log(`[Zo Stream Line]: ${line}`);

          if (line.startsWith("event:")) {
            currentEvent = line.substring(6).trim();
            continue;
          }

          if (line.startsWith("data:")) {
            const rawData = line.substring(5).trim();
            try {
              const chunkData = JSON.parse(rawData);
              console.log(
                `[Zo Stream Data] Event: "${currentEvent}", Keys: ${Object.keys(chunkData).join(", ")}`,
              );

              // Запоминаем сессию, если она пришла в потоке
              if (chunkData.conversation_id) {
                const nextTurnHash = calculateHash(authHeader, messages);
                await saveConversationId(
                  nextTurnHash,
                  chunkData.conversation_id,
                );
                console.log(
                  `[ZoProvider] Stream captured conversation_id: ${chunkData.conversation_id}. Next turn hash: ${nextTurnHash}`,
                );
              }

              let textChunk = "";
              let reasoningChunk = "";

              // Сценарий 1: Начало части (может сразу содержать весь текст в нестриминговых моделях)
              if (currentEvent === "PartStartEvent" && chunkData.part) {
                const idx = chunkData.index;
                const kind = chunkData.part.part_kind;
                const content = chunkData.part.content || "";

                if (kind) partKinds[idx] = kind;

                if (kind === "text") {
                  textChunk = getNewTextDelta(idx, content);
                } else if (kind === "thinking") {
                  reasoningChunk = getNewTextDelta(idx, content);
                }
              }
              // Сценарий 2: Постепенная генерация дельты (для классических стриминг-моделей)
              else if (currentEvent === "PartDeltaEvent" && chunkData.delta) {
                const idx = chunkData.index;
                const deltaText = chunkData.delta.content_delta || "";
                const kind = partKinds[idx] || "text";

                if (kind === "text") {
                  textChunk = deltaText;
                  sentLengthByIndex[idx] =
                    (sentLengthByIndex[idx] || 0) + deltaText.length;
                } else if (kind === "thinking") {
                  reasoningChunk = deltaText;
                  sentLengthByIndex[idx] =
                    (sentLengthByIndex[idx] || 0) + deltaText.length;
                }
              }
              // Сценарий 3: Завершение части (гарантирует, что мы забрали всё до последнего символа)
              else if (currentEvent === "PartEndEvent" && chunkData.part) {
                const idx = chunkData.index;
                const kind = chunkData.part.part_kind;
                const content = chunkData.part.content || "";

                if (kind === "text") {
                  textChunk = getNewTextDelta(idx, content);
                } else if (kind === "thinking") {
                  reasoningChunk = getNewTextDelta(idx, content);
                }
              }
              // Сценарий 4: Резервный сборщик из итогового FrontendModelResponse
              else if (
                currentEvent === "FrontendModelResponse" &&
                Array.isArray(chunkData.parts)
              ) {
                for (let i = 0; i < chunkData.parts.length; i++) {
                  const part = chunkData.parts[i];
                  const kind = part.part_kind;
                  const content = part.content || "";

                  if (kind === "text") {
                    textChunk += getNewTextDelta(i, content);
                  } else if (kind === "thinking") {
                    reasoningChunk += getNewTextDelta(i, content);
                  }
                }
              }

              // --- ОТПРАВКА ОТВЕТА В КЛИЕНТ ---

              // 1. Отправляем текст (контент ответа)
              if (textChunk) {
                console.log(
                  `[Zo Stream Chunk Sent] Text: "${textChunk.replace(/\n/g, "\\n")}"`,
                );
                const openAiChunk = {
                  id: responseId,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: payload.model || "zo-computer",
                  choices: [
                    {
                      index: 0,
                      delta: { content: textChunk },
                      finish_reason: null,
                    },
                  ],
                };
                res.write(`data: ${JSON.stringify(openAiChunk)}\n\n`);
              }

              // 2. Отправляем мысли (reasoning_content)
              if (reasoningChunk) {
                console.log(
                  `[Zo Stream Chunk Sent] Reasoning: "${reasoningChunk.replace(/\n/g, "\\n")}"`,
                );
                const openAiChunk = {
                  id: responseId,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: payload.model || "zo-computer",
                  choices: [
                    {
                      index: 0,
                      delta: {
                        reasoning_content: reasoningChunk,
                        reasoning: reasoningChunk, // дублируем для обратной совместимости
                      },
                      finish_reason: null,
                    },
                  ],
                };
                res.write(`data: ${JSON.stringify(openAiChunk)}\n\n`);
              }
            } catch (err) {
              console.warn(
                `[ZoProvider] Failed to parse stream JSON: ${err.message}. Raw: ${rawData}`,
              );
            }
          }
        }
      }

      // Отправляем финальный чанк о завершении генерации
      const finalChunk = {
        id: responseId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: payload.model || "zo-computer",
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop",
          },
        ],
      };
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      console.log(`[ZoProvider] Stream ended successfully.`);
    } catch (err) {
      console.error("[ZoProvider] Streaming internal error:", err);
    } finally {
      res.end();
    }
  }
}
