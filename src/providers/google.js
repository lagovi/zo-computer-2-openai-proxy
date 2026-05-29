import { BaseProvider } from "./base.js";

export class GoogleProvider extends BaseProvider {
  // Нормализация имен для сопоставления с GitHub
  normalizeName(name) {
    return name
      .replace(/\s*(Preview|Instruct|Latest)\b/gi, "")
      .trim()
      .toLowerCase();
  }

  // Форматирование лимитов токенов
  formatTokens(n) {
    if (n >= 1000000) return `${Math.floor(n / 1000000)}M`;
    if (n >= 1000) return `${Math.floor(n / 1000)}k`;
    return n.toString();
  }

  // Регулярный парсер страницы цен Google (без DOMParser/jsdom)
  parsePricingPageRegex(html) {
    const parsedList = [];

    const h2Regex = /<h2[^>]*id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/h2>/gi;
    const matches = [];
    let match;
    while ((match = h2Regex.exec(html)) !== null) {
      matches.push({
        id: match[1],
        name: match[2].replace(/<[^>]*>/g, "").trim(),
        index: match.index,
        lastIndex: h2Regex.lastIndex,
      });
    }

    for (let i = 0; i < matches.length; i++) {
      const current = matches[i];
      const nextIndex =
        i + 1 < matches.length ? matches[i + 1].index : html.length;
      const sectionHtml = html.substring(current.lastIndex, nextIndex);

      const tableMatch = sectionHtml.match(
        /<table[\s\S]*?>([\s\S]*?)<\/table>/i,
      );
      if (!tableMatch) continue;

      const tableHtml = tableMatch[1];

      const theadMatch = tableHtml.match(/<thead[\s\S]*?>([\s\S]*?)<\/thead>/i);
      let colIdx = 1;
      if (theadMatch) {
        const ths = [];
        const thRegex = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
        let thm;
        while ((thm = thRegex.exec(theadMatch[1])) !== null) {
          ths.push(
            thm[1]
              .replace(/<[^>]*>/g, "")
              .trim()
              .toLowerCase(),
          );
        }
        const freeTierIdx = ths.findIndex((h) => h.includes("free tier"));
        if (freeTierIdx !== -1) colIdx = freeTierIdx;
      }

      const tbodyMatch = tableHtml.match(/<tbody[\s\S]*?>([\s\S]*?)<\/tbody>/i);
      if (!tbodyMatch) continue;

      const trs = [];
      const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
      let trm;
      while ((trm = trRegex.exec(tbodyMatch[1])) !== null) {
        trs.push(trm[1]);
      }

      let inputFree = false;
      let outputFree = false;
      let hasInputPrice = false;
      let hasOutputPrice = false;
      let inputPriceVal = "N/A";
      let outputPriceVal = "N/A";
      const pricingDetails = {};

      for (const tr of trs) {
        const tds = [];
        const tdRegex = /<t[drh][^>]*>([\s\S]*?)<\/t[drh]>/gi;
        let tdm;
        while ((tdm = tdRegex.exec(tr)) !== null) {
          tds.push(tdm[1].replace(/<[^>]*>/g, "").trim());
        }
        if (tds.length < 2) continue;

        const rowLabel = tds[0].toLowerCase();
        if (colIdx >= tds.length) continue;
        const freeTierValue = tds[colIdx];
        const freeTierValueLower = freeTierValue.toLowerCase();

        pricingDetails[rowLabel] = freeTierValue;

        if (rowLabel.includes("input price") || rowLabel.includes("входная")) {
          hasInputPrice = true;
          inputPriceVal = freeTierValue;
          if (
            freeTierValueLower.includes("free of charge") ||
            freeTierValueLower === "free"
          ) {
            inputFree = true;
          }
        }
        if (
          rowLabel.includes("output price") ||
          rowLabel.includes("выходная")
        ) {
          hasOutputPrice = true;
          outputPriceVal = freeTierValue;
          if (
            freeTierValueLower.includes("free of charge") ||
            freeTierValueLower === "free"
          ) {
            outputFree = true;
          }
        }
      }

      if (inputPriceVal === "N/A" || outputPriceVal === "N/A") {
        const priceEntries = Object.entries(pricingDetails).filter(
          ([k]) => k.includes("price") || k.includes("тариф"),
        );
        if (priceEntries[0]) inputPriceVal = priceEntries[0][1];
        if (priceEntries[1]) outputPriceVal = priceEntries[1][1];
      }

      let isFree = false;
      if (hasInputPrice) {
        isFree = inputFree && (!hasOutputPrice || outputFree);
      } else {
        const hasAnyFree = Object.values(pricingDetails).some(
          (v) =>
            v.toLowerCase().includes("free of charge") ||
            v.toLowerCase() === "free",
        );
        const hasNotAvailable = Object.values(pricingDetails).some((v) =>
          v.toLowerCase().includes("not available"),
        );
        isFree = hasAnyFree && !hasNotAvailable;
      }

      parsedList.push({
        id: current.id,
        name: current.name,
        inputPrice: inputPriceVal,
        outputPrice: outputPriceVal,
        isFree: isFree,
        details: pricingDetails,
      });
    }

    return parsedList;
  }

  // Парсинг лимитов бесплатных моделей с GitHub README
  parseGithubReadme(text) {
    const freeDict = {};
    const headingMatch = text.match(/###\s*\[?Google AI Studio/i);
    const start = headingMatch
      ? headingMatch.index + headingMatch[0].length
      : 0;
    const remainingText = text.substring(start);
    const tableMatch = remainingText.match(/<table>([\s\S]*?)<\/table>/i);

    if (tableMatch) {
      const tableHtml = tableMatch[1];
      const rowRegex =
        /<tr>\s*<td>([^<]+)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/gi;
      let match;

      while ((match = rowRegex.exec(tableHtml)) !== null) {
        const display = match[1].trim();
        const limits = match[2];

        const rpmMatch = limits.match(/(\d[\d,]*)\s*requests\/minute/i);
        const rpdMatch = limits.match(/(\d[\d,]*)\s*requests\/day/i);

        const rpm = rpmMatch ? parseInt(rpmMatch[1].replace(/,/g, ""), 10) : 0;
        const rpd = rpdMatch ? parseInt(rpdMatch[1].replace(/,/g, ""), 10) : 0;

        if (rpd > 0) {
          freeDict[display] = { rpd, rpm };
        }
      }
    }
    return freeDict;
  }

  async getModels(authHeader) {
    const apiKey = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!apiKey) throw new Error("Google API Key is missing");

    console.log("[GoogleProvider] Fetching all models from Gemini API...");
    let allModels = [];
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      allModels = json.models || [];
    } catch (e) {
      throw new Error(`Failed to retrieve models from Google: ${e.message}`);
    }

    let freeModelIds = null;
    console.log("[GoogleProvider] Scanning pricing page at ai.google.dev...");
    try {
      const pricingRes = await fetch(
        "https://ai.google.dev/gemini-api/docs/pricing",
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
            "Accept-Language": "en-US,en;q=0.9",
          },
        },
      );
      if (pricingRes.ok) {
        const html = await pricingRes.text();
        const parsedPricing = this.parsePricingPageRegex(html);
        const freeModels = parsedPricing.filter((m) => m.isFree);
        freeModelIds = new Set(freeModels.map((m) => m.id));
        console.log(
          `[GoogleProvider] Discovered ${freeModelIds.size} free models on Google Pricing page.`,
        );
      } else {
        console.warn(
          `[GoogleProvider] Pricing page returned status ${pricingRes.status}`,
        );
      }
    } catch (e) {
      console.warn(
        "[GoogleProvider] Failed to fetch pricing from Google, switching to GitHub fallback:",
        e.message,
      );
    }

    let freeDict = null;
    if (!freeModelIds || freeModelIds.size === 0) {
      console.log("[GoogleProvider] Using GitHub README fallback...");
      try {
        const ghRes = await fetch(
          "https://raw.githubusercontent.com/cheahjs/free-llm-api-resources/main/README.md",
        );
        if (ghRes.ok) {
          const text = await ghRes.text();
          freeDict = this.parseGithubReadme(text);
          console.log(
            `[GoogleProvider] Loaded ${Object.keys(freeDict).length} free models from GitHub README.`,
          );
        }
      } catch (e) {
        console.error(
          "[GoogleProvider] Failed to load GitHub README fallback:",
          e.message,
        );
      }
    }

    const openaiModels = [];
    const used = new Set();

    if (freeModelIds && freeModelIds.size > 0) {
      for (const m of allModels) {
        const short = m.name.replace("models/", "");
        if (used.has(short)) continue;

        const isMatched =
          freeModelIds.has(short) ||
          Array.from(freeModelIds).some(
            (freeId) =>
              short === freeId ||
              short.startsWith(freeId + "-") ||
              freeId.startsWith(short + "-"),
          );

        if (isMatched) {
          openaiModels.push({
            id: short,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "google",
          });
          used.add(short);
        }
      }
    }

    if (
      openaiModels.length === 0 &&
      freeDict &&
      Object.keys(freeDict).length > 0
    ) {
      for (const ghDisplay of Object.keys(freeDict)) {
        let found = false;
        for (let attempt = 1; attempt <= 2; attempt++) {
          if (found) break;
          const allowForbidden = attempt === 2;

          for (const m of allModels) {
            const short = m.name.replace("models/", "");
            const apiDisp = m.displayName || "";

            if (used.has(short)) continue;

            const ghWords = ghDisplay.toLowerCase().split(/\s+/);
            const combined = (apiDisp + " " + short).toLowerCase();
            const allWordsMatch = ghWords.every((w) => combined.includes(w));

            if (
              apiDisp === ghDisplay ||
              this.normalizeName(apiDisp) === this.normalizeName(ghDisplay) ||
              short
                .toLowerCase()
                .startsWith(
                  this.normalizeName(ghDisplay).replace(/\s+/g, "-"),
                ) ||
              allWordsMatch
            ) {
              openaiModels.push({
                id: short,
                object: "model",
                created: Math.floor(Date.now() / 1000),
                owned_by: "google",
              });
              used.add(short);
              found = true;
              break;
            }
          }
        }
      }
    }

    console.log(
      `[GoogleProvider] Found ${openaiModels.length} compatible free Gemini models.`,
    );
    return openaiModels;
  }

  async handleCompletion(req, res, payload, authHeader) {
    const apiKey = authHeader.replace(/^Bearer\s+/i, "").trim();
    const modelId = payload.model;
    const isStream = !!payload.stream;

    console.log(
      `[GoogleProvider] Request. Model: ${modelId}, Stream: ${isStream}`,
    );

    // 1. Преобразуем сообщения OpenAI во вложенную мультимодальную структуру Gemini
    const contents = [];
    let systemInstruction = null;

    for (const msg of payload.messages) {
      const role = msg.role;
      const parts = [];

      // Обработка текстового содержимого
      if (typeof msg.content === "string") {
        parts.push({ text: msg.content });
      }
      // Мультимодальная обработка (массив с текстом и Base64-картинками)
      else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "text") {
            parts.push({ text: part.text });
          } else if (
            part.type === "image_url" &&
            part.image_url &&
            part.image_url.url
          ) {
            const imageUrl = part.image_url.url;

            if (imageUrl.startsWith("data:")) {
              const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
              if (matches) {
                const mimeType = matches[1];
                const base64Data = matches[2];
                parts.push({
                  inlineData: {
                    mimeType: mimeType,
                    data: base64Data,
                  },
                });
                console.log(
                  `[GoogleProvider] Multimodal: parsed image with MIME: ${mimeType}`,
                );
              }
            } else {
              parts.push({ text: `[Image: ${imageUrl}]` });
            }
          }
        }
      } else if (
        msg.content &&
        typeof msg.content === "object" &&
        msg.content.text
      ) {
        parts.push({ text: msg.content.text });
      }

      if (parts.length === 0) {
        parts.push({ text: "" });
      }

      if (role === "system") {
        systemInstruction = { parts };
      } else {
        contents.push({
          role: role === "assistant" ? "model" : "user",
          parts,
        });
      }
    }

    // 2. Формируем конфигурацию генерации по спецификации Google REST API
    const generationConfig = {};
    if (payload.temperature !== undefined)
      generationConfig.temperature = payload.temperature;
    if (payload.top_p !== undefined) generationConfig.topP = payload.top_p;
    if (payload.top_k !== undefined) generationConfig.topK = payload.top_k;
    if (payload.max_tokens !== undefined)
      generationConfig.maxOutputTokens = payload.max_tokens;

    const geminiPayload = { contents };
    if (systemInstruction) geminiPayload.systemInstruction = systemInstruction;
    if (Object.keys(generationConfig).length > 0)
      geminiPayload.generationConfig = generationConfig;

    const responseId =
      "chatcmpl-" + Math.random().toString(36).substring(2, 15);

    // --- ОБЫЧНЫЙ (НЕСТРИМИНГОВЫЙ) РЕЖИМ ---
    if (!isStream) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiPayload),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[GoogleProvider] API Error: ${errText}`);
        return res.status(response.status).json({
          error: {
            message: `Google API Error: ${errText}`,
            type: "google_api_error",
          },
        });
      }

      const json = await response.json();

      let answerText = "";
      let reasoningText = "";

      if (json.candidates && json.candidates.length > 0) {
        const parts = json.candidates[0].content?.parts || [];
        const thoughtParts = parts.filter((p) => p.thought === true);
        reasoningText = thoughtParts.map((p) => p.text).join("");

        const cleanParts = parts.filter((p) => p.text && !p.thought);
        answerText = cleanParts.map((p) => p.text).join("");
      }

      const responsePayload = {
        id: responseId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: answerText,
            },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      };

      if (reasoningText) {
        responsePayload.choices[0].message.reasoning_content = reasoningText;
      }

      res.json(responsePayload);
      return;
    }

    // --- СТРИМИНГОВЫЙ (SSE) РЕЖИМ ---
    console.log(`[GoogleProvider] Initiating Gemini stream...`);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:streamGenerateContent?alt=sse&key=${apiKey}`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiPayload),
    });

    if (!response.ok) {
      const errText = await response.text();
      const errObj = {
        error: { message: `Google Streaming Error: ${errText}` },
      };
      res.write(`data: ${JSON.stringify(errObj)}\n\n`);
      res.end();
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (let line of lines) {
          line = line.trim();
          if (!line) continue;

          // Логируем сырую строку для точного контроля мыслей и текста
          console.log(`[Gemini Stream Line]: ${line}`);

          if (line.startsWith("data:")) {
            const rawData = line.substring(5).trim();
            try {
              const chunkData = JSON.parse(rawData);

              if (chunkData.candidates && chunkData.candidates.length > 0) {
                const parts = chunkData.candidates[0].content?.parts || [];

                for (const part of parts) {
                  // 1. Потоковая трансляция мыслей (thinking)
                  if (part.thought === true && part.text) {
                    console.log(
                      `[Gemini Stream Thought]: "${part.text.replace(/\n/g, "\\n")}"`,
                    );
                    const openAiChunk = {
                      id: responseId,
                      object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000),
                      model: modelId,
                      choices: [
                        {
                          index: 0,
                          delta: {
                            reasoning_content: part.text,
                            reasoning: part.text,
                          },
                          finish_reason: null,
                        },
                      ],
                    };
                    res.write(`data: ${JSON.stringify(openAiChunk)}\n\n`);
                  }
                  // 2. Потоковая трансляция чистого текста ответа
                  else if (part.text && !part.thought) {
                    console.log(
                      `[Gemini Stream Text]: "${part.text.replace(/\n/g, "\\n")}"`,
                    );
                    const openAiChunk = {
                      id: responseId,
                      object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000),
                      model: modelId,
                      choices: [
                        {
                          index: 0,
                          delta: { content: part.text },
                          finish_reason: null,
                        },
                      ],
                    };
                    res.write(`data: ${JSON.stringify(openAiChunk)}\n\n`);
                  }
                }
              }
            } catch (err) {
              // Игнорируем неполные строки парсинга
            }
          }
        }
      }

      // Финальный стоп-пакет
      const finalChunk = {
        id: responseId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: modelId,
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
      console.log(`[GoogleProvider] Gemini stream finished successfully.`);
    } catch (err) {
      console.error("[GoogleProvider] Streaming error:", err);
    } finally {
      res.end();
    }
  }
}
