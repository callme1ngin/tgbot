const { chromium } = require('playwright');

class BrowserPool {
  constructor(options = {}) {
    this.maxContexts = options.maxContexts || 3;
    this.maxPagesPerContext = options.maxPagesPerContext || 5;
    this.viewport = options.viewport || { width: 1280, height: 720 };
    this.blockResourceTypes = new Set(options.blockResourceTypes || ['script', 'media']);
    this.browser = null;
    this.contexts = [];
    this.idlePages = new Map();
    this.activePages = new Map();
    this.activePagesByContext = new Map();
    this.totalPagesByContext = new Map();
    this.waiters = [];
  }

  async init() {
    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage', // Важно для Linux - не использует /dev/shm
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions'
      ],
      executablePath: process.env.CHROMIUM_PATH || undefined
    });

    for (let i = 0; i < this.maxContexts; i++) {
      const context = await this.browser.newContext({
        viewport: this.viewport,
        ignoreHTTPSErrors: true
      });

      if (this.blockResourceTypes.size > 0) {
        await context.route('**/*', route => {
          if (this.blockResourceTypes.has(route.request().resourceType())) {
            return route.abort();
          }

          return route.continue();
        });
      }

      this.contexts.push(context);
      this.idlePages.set(context, []);
      this.activePagesByContext.set(context, 0);
      this.totalPagesByContext.set(context, 0);
    }

    console.log(`Browser pool initialized with ${this.maxContexts} contexts`);
  }

  async getPage() {
    if (!this.browser) {
      throw new Error('Browser pool is not initialized');
    }

    while (true) {
      const page = await this.tryAcquirePage();

      if (page) {
        return page;
      }

      await new Promise(resolve => this.waiters.push(resolve));
    }
  }

  async tryAcquirePage() {
    const context = this.getLeastBusyContext();
    if (!context) {
      return null;
    }

    const idle = this.idlePages.get(context);

    let page;

    while (idle.length > 0 && !page) {
      const candidate = idle.pop();
      if (!candidate.isClosed()) {
        page = candidate;
      } else {
        this.totalPagesByContext.set(context, this.totalPagesByContext.get(context) - 1);
      }
    }

    if (!page) {
      const totalPages = this.totalPagesByContext.get(context);
      if (totalPages >= this.maxPagesPerContext) {
        return null;
      }

      page = await context.newPage();
      this.totalPagesByContext.set(context, totalPages + 1);
    }

    this.activePages.set(page, context);
    this.activePagesByContext.set(context, this.activePagesByContext.get(context) + 1);
    return page;
  }

  getLeastBusyContext() {
    const availableContexts = this.contexts.filter(context => {
      const idle = this.idlePages.get(context);
      const total = this.totalPagesByContext.get(context);
      return idle.length > 0 || total < this.maxPagesPerContext;
    });

    if (availableContexts.length === 0) {
      return null;
    }

    return availableContexts.reduce((best, context) => {
      const bestActive = this.activePagesByContext.get(best);
      const active = this.activePagesByContext.get(context);
      const bestTotal = this.totalPagesByContext.get(best);
      const total = this.totalPagesByContext.get(context);

      if (active < bestActive) {
        return context;
      }

      if (active === bestActive && total < bestTotal) {
        return context;
      }

      return best;
    }, availableContexts[0]);
  }

  async releasePage(page) {
    const context = this.activePages.get(page);

    if (!context) {
      return;
    }

    this.activePages.delete(page);
    this.activePagesByContext.set(context, Math.max(0, this.activePagesByContext.get(context) - 1));

    try {
      if (!page.isClosed()) {
        await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 3000 });
      }
    } catch (e) {
      console.warn('Failed to reset page:', e.message);
    }

    if (page.isClosed()) {
      this.totalPagesByContext.set(context, Math.max(0, this.totalPagesByContext.get(context) - 1));
    } else {
      this.idlePages.get(context).push(page);
    }

    this.notifyWaiter();
  }

  notifyWaiter() {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter();
    }
  }

  getStats() {
    return {
      contexts: this.contexts.length,
      activePages: this.activePages.size,
      idlePages: [...this.idlePages.values()].reduce((sum, pages) => sum + pages.length, 0),
      maxPages: this.maxContexts * this.maxPagesPerContext
    };
  }

  async close() {
    await this.browser?.close();
    console.log('Browser pool closed');
  }
}

module.exports = BrowserPool;
