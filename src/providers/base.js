export class BaseProvider {
  /**
   * Возвращает список поддерживаемых моделей/персон в формате OpenAI.
   * @param {string} authHeader
   * @returns {Promise<Array>}
   */
  async getModels(authHeader) {
    throw new Error("getModels not implemented");
  }

  /**
   * Обрабатывает запрос completions (обычный режим или стриминг).
   * @param {object} req
   * @param {object} res
   * @param {object} payload
   * @param {string} authHeader
   * @returns {Promise<void>}
   */
  async handleCompletion(req, res, payload, authHeader) {
    throw new Error("handleCompletion not implemented");
  }
}
