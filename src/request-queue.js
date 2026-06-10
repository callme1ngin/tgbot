class RequestQueue {
  constructor(options = {}) {
    this.maxConcurrent = options.maxConcurrent || 5;
    this.activeRequests = 0;
    this.queue = [];
    this.callbacks = new Map();
  }

  async add(taskId, task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ taskId, task, resolve, reject });
      this.callbacks.set(taskId, { resolve, reject });
      this.processQueue();
    });
  }

  async processQueue() {
    while (this.activeRequests < this.maxConcurrent && this.queue.length > 0) {
      const { taskId, task, resolve, reject } = this.queue.shift();
      this.activeRequests++;

      task()
        .then(result => {
          resolve(result);
          this.callbacks.delete(taskId);
        })
        .catch(error => {
          reject(error);
          this.callbacks.delete(taskId);
        })
        .finally(() => {
          this.activeRequests--;
          this.processQueue();
        });
    }
  }

  getQueueLength() {
    return this.queue.length;
  }

  getActiveCount() {
    return this.activeRequests;
  }
}

module.exports = RequestQueue;
