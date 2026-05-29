import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { SESSIONS_DIR } from "../config.js";

// Быстрый кэш в оперативной памяти (fallback, если диск недоступен)
const inMemoryCache = new Map();

// Создание папки для сессий, если её еще нет
async function ensureDir() {
  try {
    await fs.mkdir(SESSIONS_DIR, { recursive: true });
  } catch (err) {
    // В случае ошибок доступа продолжаем работу в оперативной памяти
  }
}

// Расчет хэша на основе ключа авторизации и истории сообщений
export function calculateHash(authHeader, messages) {
  const cleanHeader = (authHeader || "").replace(/^Bearer\s+/i, "").trim();

  // Приводим сообщения к единому строгому формату для детерминированного хэша
  const cleanMessages = (messages || []).map((m) => ({
    role: m.role || "",
    content: m.content || "",
  }));

  const rawString = cleanHeader + "::" + JSON.stringify(cleanMessages);
  return crypto.createHash("md5").update(rawString).digest("hex");
}

// Получение id сессии из кэша памяти или с диска
export async function getConversationId(hash) {
  if (inMemoryCache.has(hash)) {
    return inMemoryCache.get(hash);
  }

  const filePath = path.join(SESSIONS_DIR, `${hash}.json`);
  try {
    const data = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(data);
    if (parsed && parsed.conversation_id) {
      // Кэшируем в ОЗУ для будущих запросов
      inMemoryCache.set(hash, parsed.conversation_id);
      return parsed.conversation_id;
    }
  } catch (err) {
    // Файл не найден или ошибка чтения — это нормально для новых диалогов
  }
  return null;
}

// Сохранение id сессии
export async function saveConversationId(hash, conversationId) {
  if (!hash || !conversationId) return;

  inMemoryCache.set(hash, conversationId);

  await ensureDir();
  const filePath = path.join(SESSIONS_DIR, `${hash}.json`);
  try {
    await fs.writeFile(
      filePath,
      JSON.stringify({ conversation_id: conversationId }),
      "utf-8",
    );
  } catch (err) {
    console.warn(
      `[SessionStore] Failed to write session to disk (falling back to memory):`,
      err.message,
    );
  }
}
