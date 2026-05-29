import { ZoProvider } from "./zo.js";
import { GoogleProvider } from "./google.js";

const zoProvider = new ZoProvider();
const googleProvider = new GoogleProvider();

/**
 * Определяет провайдера на основе формата его API-ключа
 * @param {string} authHeader
 * @returns {BaseProvider|null}
 */
export function getProviderByKey(authHeader) {
  if (!authHeader) return null;

  // Убираем Bearer, если он передан
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (token.startsWith("zo_sk_")) {
    return zoProvider;
  } else if (token.startsWith("AIza") || token.startsWith("AQ.")) {
    return googleProvider;
  }

  return null;
}
