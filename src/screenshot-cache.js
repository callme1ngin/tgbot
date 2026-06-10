const crypto = require('crypto');

class ScreenshotCache {
  constructor(options = {}) {
    this.cache = new Map();
    this.maxSize = options.maxSize || 100; // Максимум кешированных скриншотов
    this.ttl = options.ttl || 60 * 60 * 1000; // 1 час по умолчанию
  }

  generateKey(url, template, data) {
    const key = `${url}:${template}:${JSON.stringify(data)}`;
    return crypto.createHash('md5').update(key).digest('hex');
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;

    // Проверяем TTL
    if (Date.now() - entry.timestamp > this.ttl) {
      this.cache.delete(key);
      return null;
    }

    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.data;
  }

  set(key, data) {
    // Если кеш переполнен, удаляем самый старый элемент
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }

    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
  }

  clear() {
    this.cache.clear();
  }

  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize
    };
  }
}

module.exports = ScreenshotCache;
