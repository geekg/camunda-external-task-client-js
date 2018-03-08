const events = require('events');

const EngineClient = require('./__internal/EngineClient');
const TaskClient = require('./TaskClient');

const {
  MISSING_PATH,
  ALREADY_REGISTERED,
  MISSING_HANDLER,
  WRONG_INTERCEPTOR,
  WRONG_MIDDLEWARES
} = require('./__internal/errors');

const { isFunction, isArrayOfFunctions } = require('./__internal/utils');

const defaultOptions = {
  workerId: 'some-random-id',
  maxTasks: 10,
  interval: 300,
  lockDuration: 50000,
  autoPoll: true
};


/**
 *
 * @param customOptions
 * @param customOptions.path: path to api | REQUIRED
 * @param customOptions.workerId
 * @param customOptions.maxTasks
 * @param customOptions.interval
 * @param customOptions.lockDuration
 * @param customOptions.autoPoll
 * @param customOptions.asyncResponseTimeout
 * @param customOptions.interceptors
 * @param customOptions.use
 * @constructor
 */
class Workers extends events {
  constructor(customOptions) {
    super();

    /**
     * Bind member methods
     */
    this.sanitizeOptions = this.sanitizeOptions.bind(this);
    this.start = this.start.bind(this);
    this.poll = this.poll.bind(this);
    this.subscribe = this.subscribe.bind(this);
    this.executeTask = this.executeTask.bind(this);
    this.stop = this.stop.bind(this);


    /**
     *  Initialize data
     */
    this.sanitizeOptions(customOptions);
    this.workers = {}; // Map which contains all subscribed topics
    this.engineClient = new EngineClient(this.options);
    this.taskClient = new TaskClient(this, this.engineClient);


    if (this.options.use) {
      this.options.use.forEach(f => f(this));
    }

    if (this.options.autoPoll) {
      this.start();
    }
  }

  sanitizeOptions(customOptions) {
    this.options = { ...defaultOptions, ...customOptions };

    if (!customOptions || !customOptions.path || !customOptions.path.length) {
      throw new Error(MISSING_PATH);
    }

    const { interceptors, use } = customOptions;

    // sanitize request interceptors
    if (interceptors && !isFunction(interceptors) && !isArrayOfFunctions(interceptors)) {
      throw new Error(WRONG_INTERCEPTOR);
    }

    if (isFunction(interceptors)) {
      this.options.interceptors = [interceptors];
    }

    // sanitize middlewares
    if (use && !isFunction(use) && !isArrayOfFunctions(use)) {
      throw new Error(WRONG_MIDDLEWARES);
    }

    if (isFunction(use)) {
      this.options.use = [use];
    }

  }

  /**
   * Starts polling
   */
  start() {
    this._isPollAllowed = true;
    this.poll();
  }

  /**
   * Polls tasks from engine and executes them
   */
  async poll() {
    if (!this._isPollAllowed) {
      return;
    }

    const self = this;
    const workers = this.workers;
    const engineClient = this.engineClient;
    const { maxTasks, interval, asyncResponseTimeout } = this.options;

    let pollingOptions = { maxTasks };
    if (asyncResponseTimeout) {
      pollingOptions = { ...pollingOptions, asyncResponseTimeout };
    }

    this.emit('poll:start');

    // if no workers are registered, reschedule polling
    if (!Object.keys(workers).length) {
      return setTimeout(this.poll, interval);
    }

    // collect topics workers are registered on
    const topics = Object.keys(workers).map(topicName => ({
      topicName,
      lockDuration: workers[topicName].lockDuration
    }));

    const requestBody = { ...pollingOptions, topics };

    try {
      const tasks = await engineClient.fetchAndLock(requestBody);
      this.emit('poll:success', tasks);
      tasks.forEach(self.executeTask);
    } catch (e) {
      this.emit('poll:error', e);
    }
    setTimeout(self.poll, interval);
  }

  /**
   * Subscribes a worker by adding it to the workers map
   * @param topic
   * @param customOptions
   * @param customOptions.lockDuration
   * @param worker
   */
  subscribe(topic, customOptions, worker) {
    const workers = this.workers;
    const options = this.options;
    const lockDuration = options.lockDuration;

    if (workers[topic]) {
      throw new Error(ALREADY_REGISTERED);
    }

    //handles the case if there is no options being
    if (typeof customOptions  === 'function') {
      worker = customOptions;
      customOptions = null;
    }

    if (!worker) {
      throw new Error(MISSING_HANDLER);
    }
    const unsubscribe = () => {
      delete workers[topic];
      this.emit('worker:unsubscribe');
    };

    const workerClient = { worker, unsubscribe, lockDuration, ...customOptions };
    // Add topic to workers with the related callback fkt and lockduration
    workers[topic] = workerClient;

    this.emit('worker:subscribe:success', topic, workerClient);

    return workerClient;
  }

  /**
   * Executes task using the worker registered to its topic
   */
  executeTask(task) {
    const taskClient = this.taskClient;
    const workerClient = this.workers[task.topicName];
    try {
	    workerClient.worker({ task, taskClient });
      this.emit('handler:success', task);
    } catch (e) {
      this.emit('handler:error', e);
    }
  }

  /**
   * Stops polling
   */
  stop() {
    this._isPollAllowed = false;
    this.emit('poll:stop');
  }
}

module.exports = Workers;