import { createClient } from "redis";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class ValkeyBinding {
  constructor(url, {
    prefix = process.env.VALKEY_PREFIX ?? "nara001:",
    connectTimeoutMs = 3_000,
    retryCooldownMs = 5_000,
  } = {}) {
    if (!url) throw new Error("VALKEY_URL is required");
    this.prefix = prefix;
    this.client = createClient({
      url,
      disableOfflineQueue: true,
      commandsQueueMaxLength: 1_000,
      socket: {
        connectTimeout: connectTimeoutMs,
        reconnectStrategy: (retries) => retries >= 3
          ? new Error("Valkey reconnect limit reached")
          : Math.min(100 + retries * 100, 1_000),
      },
    });
    this.client.on("error", (error) => console.error("Valkey connection error", error));
    this.connecting = null;
    this.retryCooldownMs = retryCooldownMs;
    this.unavailableUntil = 0;
  }

  key(value) {
    return `${this.prefix}${value}`;
  }

  async ready() {
    if (this.client.isReady) return this.client;
    if (this.client.isOpen) return this.client;
    if (Date.now() < this.unavailableUntil) throw new Error("Valkey is temporarily unavailable");
    if (!this.connecting) {
      this.connecting = this.client.connect()
        .catch((error) => {
          this.unavailableUntil = Date.now() + this.retryCooldownMs;
          throw error;
        })
        .finally(() => {
          this.connecting = null;
        });
    }
    await this.connecting;
    return this.client;
  }

  async get(key) {
    return (await this.ready()).get(this.key(key));
  }

  async set(key, value, options = {}) {
    const settings = {};
    if (options.ttlSeconds) settings.EX = Math.max(1, Math.trunc(options.ttlSeconds));
    if (options.onlyIfAbsent) settings.NX = true;
    return (await this.ready()).set(this.key(key), String(value), settings);
  }

  async delete(...keys) {
    if (!keys.length) return 0;
    return (await this.ready()).del(keys.map((key) => this.key(key)));
  }

  async incrementBy(key, amount, ttlSeconds) {
    const client = await this.ready();
    const multi = client.multi().incrBy(this.key(key), Math.trunc(amount));
    if (ttlSeconds) multi.expire(this.key(key), Math.max(1, Math.trunc(ttlSeconds)), "NX");
    const [value] = await multi.exec();
    return Number(value);
  }

  async hashIncrementBy(key, field, amount) {
    return Number(await (await this.ready()).hIncrBy(this.key(key), String(field), Math.trunc(amount)));
  }

  async hashGet(key, field) {
    return (await this.ready()).hGet(this.key(key), String(field));
  }

  async hashEntries(key) {
    return (await this.ready()).hGetAll(this.key(key));
  }

  async hashDelete(key, ...fields) {
    if (!fields.length) return 0;
    return (await this.ready()).hDel(this.key(key), fields.map(String));
  }

  async consumeHash(key, entries, totalKey) {
    const pairs = Object.entries(entries);
    if (!pairs.length) return 0;
    const argumentsList = [];
    for (const [field, amount] of pairs) argumentsList.push(String(field), String(Math.max(0, Math.trunc(Number(amount)))));
    const script = `
      local consumed = 0
      for i = 1, #ARGV, 2 do
        local field = ARGV[i]
        local requested = tonumber(ARGV[i + 1])
        local current = tonumber(redis.call('HGET', KEYS[1], field) or '0')
        local amount = math.min(current, requested)
        if amount > 0 then
          local remaining = current - amount
          if remaining > 0 then redis.call('HSET', KEYS[1], field, remaining)
          else redis.call('HDEL', KEYS[1], field) end
          consumed = consumed + amount
        end
      end
      if consumed > 0 and KEYS[2] ~= '' then
        local total = tonumber(redis.call('GET', KEYS[2]) or '0')
        redis.call('SET', KEYS[2], math.max(0, total - consumed), 'EX', 3600)
      end
      return consumed
    `;
    return Number(await (await this.ready()).eval(script, {
      keys: [this.key(key), totalKey ? this.key(totalKey) : ""],
      arguments: argumentsList,
    }));
  }

  async expire(key, ttlSeconds) {
    return (await this.ready()).expire(this.key(key), Math.max(1, Math.trunc(ttlSeconds)));
  }

  async withLock(key, action, {
    ttlMilliseconds = 10_000,
    waitMilliseconds = 2_000,
    retryMilliseconds = 50,
  } = {}) {
    const client = await this.ready();
    const lockKey = this.key(`lock:${key}`);
    const token = crypto.randomUUID();
    const deadline = Date.now() + waitMilliseconds;
    while (Date.now() <= deadline) {
      const acquired = await client.set(lockKey, token, { NX: true, PX: ttlMilliseconds });
      if (acquired) {
        try {
          return await action();
        } finally {
          await client.eval(
            "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
            { keys: [lockKey], arguments: [token] },
          ).catch(() => undefined);
        }
      }
      await sleep(retryMilliseconds);
    }
    throw new Error(`Timed out waiting for distributed lock: ${key}`);
  }

  async close() {
    if (this.client.isOpen) await this.client.quit();
  }
}

export function createValkeyBinding(url, options) {
  return url ? new ValkeyBinding(url, options) : null;
}
