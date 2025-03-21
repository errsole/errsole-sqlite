/**
 * @typedef {Object} Config
 * @property {number} id
 * @property {string} key
 * @property {string} value
 */

/**
 * @typedef {Object} User
 * @property {number} id
 * @property {string} name
 * @property {string} email
 * @property {string} role
 */

/**
 * @typedef {Object} Log
 * @property {number} [id]
 * @property {number} [errsole_id]
 * @property {Date} timestamp
 * @property {string} hostname
 * @property {number} [pid]
 * @property {string} source
 * @property {string} level
 * @property {string} message
 * @property {string} [meta]
 */

/**
 * @typedef {Object} LogFilter
 * @property {number} [lt_id]
 * @property {number} [gt_id]
 * @property {Date} [lte_timestamp]
 * @property {Date} [gte_timestamp]
 * @property {string[]} [hostnames]
 * @property {{source: string, level: string}[]} [level_json]
 * @property {number} [errsole_id]
 * @property {number} [limit=100]
 */

/**
 * @typedef {Object} Notification
 * @property {number} [id]
 * @property {number} errsole_id
 * @property {string} hostname
 * @property {string} hashed_message
 * @property {Date} [created_at]
 * @property {Date} [updated_at]
 */

const bcrypt = require('bcryptjs');
const { EventEmitter } = require('events');
const cron = require('node-cron');
const sqlite3 = require('sqlite3');
const { promisify } = require('util');

class ErrsoleSQLite extends EventEmitter {
  constructor (filename, options = {}) {
    super();

    this.name = require('../package.json').name;
    this.version = require('../package.json').version || '0.0.0';

    let { tablePrefix = '' } = options;
    tablePrefix = tablePrefix ? `errsole_${tablePrefix.toLowerCase().replace(/[^a-z0-9]/g, '')}` : 'errsole';
    this.configTable = `${tablePrefix}_config`;
    this.usersTable = `${tablePrefix}_users`;
    this.logsTable = `${tablePrefix}_logs_v3`;
    this.notificationsTable = `${tablePrefix}_notifications_v2`;

    this.pendingLogs = [];
    this.batchSize = 100;
    this.flushInterval = 1000;

    this.isConnectionInProgress = true;
    this.db = new sqlite3.Database(filename, err => {
      if (err) throw new Error(err.message || err.toString());
      this.initialize();
    });
  }

  async initialize () {
    await this.setAutoVacuum();
    await this.setCacheSize();
    await this.createTables();
    await this.ensureLogsTTL();
    this.emit('ready');
    setInterval(() => this.flushLogs(), this.flushInterval);
    cron.schedule('0 * * * *', () => {
      this.deleteExpiredLogs();
      this.deleteExpiredNotificationItems();
    });
  }

  async setAutoVacuum () {
    return new Promise((resolve, reject) => {
      this.db.run('PRAGMA auto_vacuum = FULL', err => {
        if (err) return reject(new Error(err.message || err.toString()));
        resolve();
      });
    });
  }

  async setCacheSize () {
    const DESIRED_CACHE_SIZE = 8 * 1024;
    const currentSize = await this.getCacheSize();

    if (currentSize >= DESIRED_CACHE_SIZE) {
      return Promise.resolve();
    }

    const query = `PRAGMA cache_size = ${DESIRED_CACHE_SIZE}`;
    return new Promise((resolve, reject) => {
      this.db.run(query, err => {
        if (err) return reject(new Error(err.message || err.toString()));
        resolve();
      });
    });
  }

  async getCacheSize () {
    const query = 'PRAGMA cache_size';
    return new Promise((resolve, reject) => {
      this.db.get(query, (err, row) => {
        if (err) return reject(new Error(err.message || err.toString()));
        resolve(row.cache_size);
      });
    });
  }

  async createTables () {
    this.logsTableQueries = [
      `CREATE TABLE IF NOT EXISTS ${this.logsTable} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hostname TEXT,
        pid INTEGER,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        source TEXT,
        level TEXT DEFAULT 'info',
        message TEXT,
        meta TEXT,
        errsole_id BIGINT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_${this.logsTable}_source_level_id ON ${this.logsTable} (source, level, id)`,
      `CREATE INDEX IF NOT EXISTS idx_${this.logsTable}_source_level_timestamp_id ON ${this.logsTable} (source, level, timestamp, id)`,
      `CREATE INDEX IF NOT EXISTS idx_${this.logsTable}_timestamp_id ON ${this.logsTable} (timestamp, id)`,
      `CREATE INDEX IF NOT EXISTS idx_${this.logsTable}_errsole_id ON ${this.logsTable} (errsole_id)`
    ];
    const otherTableQueries = [
      `CREATE TABLE IF NOT EXISTS ${this.configTable} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        value TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ${this.usersTable} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        email TEXT UNIQUE NOT NULL,
        hashed_password TEXT NOT NULL,
        role TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS ${this.notificationsTable} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        errsole_id BIGINT,
        hostname TEXT,
        hashed_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE INDEX IF NOT EXISTS idx_${this.notificationsTable}_hashed_message_created_at ON ${this.notificationsTable} (hashed_message, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_${this.notificationsTable}_created_at ON ${this.notificationsTable} (created_at)`
    ];

    const queries = [...this.logsTableQueries, ...otherTableQueries];
    for (const query of queries) {
      await new Promise((resolve, reject) => {
        this.db.run(query, err => {
          if (err) return reject(new Error(err.message || err.toString()));
          resolve();
        });
      });
    }

    this.isConnectionInProgress = false;
  }

  async ensureLogsTTL () {
    const DEFAULT_LOGS_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds
    const configResult = await this.getConfig('logsTTL');
    if (!configResult.item) {
      await this.setConfig('logsTTL', DEFAULT_LOGS_TTL.toString());
    }
  }

  /**
   * Retrieves a configuration entry from the database.
   *
   * @async
   * @function getConfig
   * @param {string} key - The key of the configuration entry to retrieve.
   * @returns {Promise<{item: Config}>} - A promise that resolves with an object containing the configuration item.
   * @throws {Error} - Throws an error if the operation fails.
   */
  async getConfig (key) {
    const query = `SELECT * FROM ${this.configTable} WHERE \`key\` = ?`;

    return new Promise((resolve, reject) => {
      this.db.get(query, [key], (err, row) => {
        if (err) return reject(new Error(err.message || err.toString()));
        resolve({ item: row });
      });
    });
  }

  /**
   * Updates or adds a configuration entry in the database.
   *
   * @async
   * @function setConfig
   * @param {string} key - The key of the configuration entry.
   * @param {string} value - The value to be stored for the configuration entry.
   * @returns {Promise<{item: Config}>} - A promise that resolves with an object containing the updated or added configuration item.
   * @throws {Error} - Throws an error if the operation fails.
   */
  async setConfig (key, value) {
    const query = `INSERT INTO ${this.configTable} (\`key\`, \`value\`) VALUES (?, ?) ON CONFLICT(\`key\`) DO UPDATE SET \`value\` = excluded.value`;

    return new Promise((resolve, reject) => {
      this.db.run(query, [key, value], err => {
        if (err) return reject(new Error(err.message || err.toString()));
        this.getConfig(key).then(resolve).catch(reject);
      });
    });
  }

  /**
   * Deletes a configuration entry from the database.
   *
   * @async
   * @function deleteConfig
   * @param {string} key - The key of the configuration entry to be deleted.
   * @returns {Promise<{}>} - A Promise that resolves with an empty object upon successful deletion of the configuration.
   * @throws {Error} - Throws an error if the operation fails.
   */
  async deleteConfig (key) {
    const query = `DELETE FROM ${this.configTable} WHERE \`key\` = ?`;

    return new Promise((resolve, reject) => {
      this.db.run(query, [key], function (err) { // You must use an old-school function () { ... } style callback rather than a lambda function, otherwise this.lastID and this.changes will be undefined.
        if (err) return reject(new Error(err.message || err.toString()));
        if (this.changes === 0) return reject(new Error('Configuration not found.'));
        resolve({});
      });
    });
  }

  /**
   * Creates a new user record in the database.
   *
   * @async
   * @function createUser
   * @param {Object} user - The user data.
   * @param {string} user.name - The name of the user.
   * @param {string} user.email - The email address of the user.
   * @param {string} user.password - The password of the user.
   * @param {string} user.role - The role of the user.
   * @returns {Promise<{item: User}>} - A promise that resolves with an object containing the new user item.
   * @throws {Error} - Throws an error if the user creation fails due to duplicate email or other database issues.
   */
  async createUser (user) {
    const SALT_ROUNDS = 10;
    const hashedPassword = await bcrypt.hash(user.password, SALT_ROUNDS);
    const query = `INSERT INTO ${this.usersTable} (name, email, hashed_password, role) VALUES (?, ?, ?, ?)`;
    return new Promise((resolve, reject) => {
      this.db.run(query, [user.name, user.email, hashedPassword, user.role], function (err) { // You must use an old-school function () { ... } style callback rather than a lambda function, otherwise this.lastID and this.changes will be undefined.
        if (err) {
          if (err.code === 'SQLITE_CONSTRAINT') {
            return reject(new Error('A user with the provided email already exists.'));
          }
          return reject(new Error(err.message || err.toString()));
        }
        resolve({ item: { id: this.lastID, name: user.name, email: user.email, role: user.role } });
      });
    });
  }

  /**
   * Verifies a user's credentials against stored records.
   *
   * @async
   * @function verifyUser
   * @param {string} email - The email address of the user.
   * @param {string} password - The password of the user
   * @returns {Promise<{item: User}>} - A promise that resolves with an object containing the user item upon successful verification.
   * @throws {Error} - Throws an error if the operation fails.
   */
  async verifyUser (email, password) {
    if (!email || !password) {
      throw new Error('Both email and password are required for verification.');
    }

    const query = `SELECT * FROM ${this.usersTable} WHERE email = ?`;
    return new Promise((resolve, reject) => {
      this.db.get(query, [email], async (err, row) => {
        if (err) return reject(new Error(err.message || err.toString()));
        if (!row) return reject(new Error('User not found.'));

        const isPasswordCorrect = await bcrypt.compare(password, row.hashed_password);
        if (!isPasswordCorrect) return reject(new Error('Incorrect password.'));

        delete row.hashed_password;
        resolve({ item: row });
      });
    });
  }

  /**
   * Retrieves the total count of users from the database.
   *
   * @async
   * @function getUserCount
   * @returns {Promise<{count: number}>} - A promise that resolves with an object containing the count of users.
   * @throws {Error} - Throws an error if the operation fails.
   */
  async getUserCount () {
    const query = `SELECT COUNT(*) as count FROM ${this.usersTable}`;
    return new Promise((resolve, reject) => {
      this.db.get(query, (err, row) => {
        if (err) return reject(new Error(err.message || err.toString()));
        resolve({ count: row.count });
      });
    });
  }

  /**
   * Retrieves all user records from the database.
   *
   * @async
   * @function getAllUsers
   * @returns {Promise<{items: User[]}>} - A promise that resolves with an object containing an array of user items.
   * @throws {Error} - Throws an error if the operation fails.
   */
  async getAllUsers () {
    const query = `SELECT id, name, email, role FROM ${this.usersTable}`;
    return new Promise((resolve, reject) => {
      this.db.all(query, (err, rows) => {
        if (err) return reject(new Error(err.message || err.toString()));
        resolve({ items: rows });
      });
    });
  }

  /**
   * Retrieves a user record from the database based on the provided email.
   *
   * @async
   * @function getUserByEmail
   * @param {string} email - The email address of the user.
   * @returns {Promise<{item: User}>} - A Promise that resolves with an object containing the user item.
   * @throws {Error} - Throws an error if no user matches the email address.
   */
  async getUserByEmail (email) {
    if (!email) throw new Error('Email is required.');

    const query = `SELECT id, name, email, role FROM ${this.usersTable} WHERE email = ?`;
    return new Promise((resolve, reject) => {
      this.db.get(query, [email], (err, row) => {
        if (err) return reject(new Error(err.message || err.toString()));
        if (!row) return reject(new Error('User not found.'));
        resolve({ item: row });
      });
    });
  }

  /**
   * Updates a user's record in the database based on the provided email.
   *
   * @async
   * @function updateUserByEmail
   * @param {string} email - The email address of the user to be updated.
   * @param {Object} updates - The updates to be applied to the user record.
   * @returns {Promise<{item: User}>} - A Promise that resolves with an object containing the updated user item.
   * @throws {Error} - Throws an error if no updates could be applied or the user is not found.
   */
  async updateUserByEmail (email, updates) {
    if (!email) throw new Error('Email is required.');
    if (!updates || Object.keys(updates).length === 0) throw new Error('No updates provided.');

    const restrictedFields = ['id', 'hashed_password'];
    restrictedFields.forEach(field => delete updates[field]);

    const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
    const values = [...Object.values(updates), email];

    const query = `UPDATE ${this.usersTable} SET ${setClause} WHERE email = ?`;
    return new Promise((resolve, reject) => {
      this.db.run(query, values, err => {
        if (err) return reject(new Error(err.message || err.toString()));
        this.getUserByEmail(email).then(resolve).catch(reject);
      });
    });
  }

  /**
   * Updates a user's password in the database.
   *
   * @async
   * @function updatePassword
   * @param {string} email - The email address of the user whose password is to be updated.
   * @param {string} currentPassword - The current password of the user for verification.
   * @param {string} newPassword - The new password to replace the current one.
   * @returns {Promise<{item: User}>} - A Promise that resolves with an object containing the updated user item (excluding sensitive information).
   * @throws {Error} - If the user is not found, if the current password is incorrect, or if the password update fails.
   */
  async updatePassword (email, currentPassword, newPassword) {
    if (!email || !currentPassword || !newPassword) {
      throw new Error('Email, current password, and new password are required.');
    }

    const query = `SELECT * FROM ${this.usersTable} WHERE email = ?`;
    return new Promise((resolve, reject) => {
      this.db.get(query, [email], async (err, row) => {
        if (err) return reject(new Error(err.message || err.toString()));
        if (!row) return reject(new Error('User not found.'));

        const isPasswordCorrect = await bcrypt.compare(currentPassword, row.hashed_password);
        if (!isPasswordCorrect) return reject(new Error('Current password is incorrect.'));

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        const updateQuery = `UPDATE ${this.usersTable} SET hashed_password = ? WHERE email = ?`;
        this.db.run(updateQuery, [hashedPassword, email], err => {
          if (err) return reject(new Error(err.message || err.toString()));
          delete row.hashed_password;
          resolve({ item: row });
        });
      });
    });
  }

  /**
   * Deletes a user record from the database.
   *
   * @async
   * @function deleteUser
   * @param {number} id - The unique ID of the user to be deleted.
   * @returns {Promise<{}>} - A Promise that resolves with an empty object upon successful deletion of the user.
   * @throws {Error} - Throws an error if no user is found with the given ID or if the database operation fails.
   */
  async deleteUser (id) {
    if (!id) throw new Error('User ID is required.');

    const query = `DELETE FROM ${this.usersTable} WHERE id = ?`;
    return new Promise((resolve, reject) => {
      this.db.run(query, [id], function (err) { // You must use an old-school function () { ... } style callback rather than a lambda function, otherwise this.lastID and this.changes will be undefined.
        if (err) return reject(new Error(err.message || err.toString()));
        if (this.changes === 0) return reject(new Error('User not found.'));
        resolve({});
      });
    });
  }

  /**
   * Adds log entries to the pending logs and flushes them if the batch size is reached.
   *
   * @param {Log[]} logEntries - An array of log entries to be added to the pending logs.
   * @returns {Object} - An empty object.
   */
  postLogs (logEntries) {
    this.pendingLogs.push(...logEntries);
    if (this.pendingLogs.length >= this.batchSize) {
      this.flushLogs();
    }
    return {};
  }

  /**
   * Flushes pending logs to the database.
   *
   * @async
   * @function flushLogs
   * @returns {Promise<{}>} - A Promise that resolves with an empty object.
   * @throws {Error} - Throws an error if the operation fails.
   */
  async flushLogs () {
    while (this.isConnectionInProgress) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const logsToPost = this.pendingLogs.splice(0, this.pendingLogs.length);
    if (logsToPost.length === 0) {
      return {}; // No logs to post
    }

    const values = logsToPost.map(logEntry => [
      new Date(logEntry.timestamp),
      logEntry.hostname,
      logEntry.pid,
      logEntry.source,
      logEntry.level,
      logEntry.message,
      logEntry.meta,
      logEntry.errsole_id
    ]);

    const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const query = `INSERT OR IGNORE INTO ${this.logsTable} (timestamp, hostname, pid, source, level, message, meta, errsole_id) VALUES ${placeholders}`;

    const flatValues = values.reduce((accumulator, Logvalues) => accumulator.concat(Logvalues), []);

    return new Promise((resolve, reject) => {
      this.db.run(query, flatValues, function (err) {
        if (err) return reject(new Error(err.message || err.toString()));
        resolve({});
      });
    });
  }

  /**
   * Retrieves log entries from the database based on specified filters.
   *
   * @async
   * @function getLogs
   * @param {LogFilter} [filters] - Filters to apply for log retrieval.
   * @returns {Promise<{items: Log[]}>} - A Promise that resolves with an object containing log items.
   * @throws {Error} - Throws an error if the operation fails.
   */
  async getLogs (filters = {}) {
    const DEFAULT_LOGS_LIMIT = 100;
    filters.limit = filters.limit || DEFAULT_LOGS_LIMIT;

    const whereClauses = [];
    const values = [];
    let orderBy = 'id DESC';
    let shouldReverse = true;

    // Apply filters
    if (filters.level_json || filters.errsole_id) {
      const orConditions = [];
      if (filters.level_json && filters.level_json.length > 0) {
        const levelConditions = filters.level_json.map(levelObj => '(source = ? AND level = ?)');
        orConditions.push(`(${levelConditions.join(' OR ')})`);
        filters.level_json.forEach(levelObj => {
          values.push(levelObj.source, levelObj.level);
        });
      }
      if (filters.errsole_id) {
        orConditions.push('errsole_id = ?');
        values.push(filters.errsole_id);
      }
      if (orConditions.length > 0) {
        whereClauses.push(`(${orConditions.join(' OR ')})`);
      }
    }
    if (filters.lt_id) {
      whereClauses.push('id < ?');
      values.push(filters.lt_id);
      orderBy = 'id DESC';
      shouldReverse = true;
    } else if (filters.gt_id) {
      whereClauses.push('id > ?');
      values.push(filters.gt_id);
      orderBy = 'id ASC';
      shouldReverse = false;
    } else if (filters.lte_timestamp || filters.gte_timestamp) {
      if (filters.lte_timestamp) {
        whereClauses.push('timestamp <= ?');
        values.push(new Date(filters.lte_timestamp));
        orderBy = 'timestamp DESC, id DESC';
        shouldReverse = true;
      }
      if (filters.gte_timestamp) {
        whereClauses.push('timestamp >= ?');
        values.push(new Date(filters.gte_timestamp));
        orderBy = 'timestamp ASC, id ASC';
        shouldReverse = false;
      }
    }

    const whereClause = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const query = `SELECT id, hostname, pid, source, timestamp, level, message, errsole_id FROM ${this.logsTable} ${whereClause} ORDER BY ${orderBy} LIMIT ?`;
    values.push(filters.limit);

    return new Promise((resolve, reject) => {
      this.db.all(query, values, (err, rows) => {
        if (err) return reject(new Error(err.message || err.toString()));
        if (shouldReverse) rows.reverse();
        resolve({ items: rows });
      });
    });
  }

  /**
   * Retrieves log entries from the database based on specified search terms and filters.
   *
   * @async
   * @function searchLogs
   * @param {string[]} searchTerms - An array of search terms.
   * @param {LogFilter} [filters] - Filters to refine the search.
   * @returns {Promise<{items: Log[], filters: LogFilter[]}>} - A promise that resolves with an object containing an array of log items and the applied filters.
   * @throws {Error} - Throws an error if the operation fails.
   */
  async searchLogs (searchTerms, filters = {}) {
    const DEFAULT_LOGS_LIMIT = 100;
    filters.limit = filters.limit || DEFAULT_LOGS_LIMIT;

    const whereClauses = searchTerms.map(() => 'message LIKE ?');
    const values = searchTerms.map(term => `%${term}%`);
    let orderBy = 'id DESC';
    let shouldReverse = true;

    // Apply filters
    if (filters.level_json || filters.errsole_id) {
      const orConditions = [];
      if (filters.level_json && filters.level_json.length > 0) {
        const levelConditions = filters.level_json.map(levelObj => '(source = ? AND level = ?)');
        orConditions.push(`(${levelConditions.join(' OR ')})`);
        filters.level_json.forEach(levelObj => {
          values.push(levelObj.source, levelObj.level);
        });
      }
      if (filters.errsole_id) {
        orConditions.push('errsole_id = ?');
        values.push(filters.errsole_id);
      }
      if (orConditions.length > 0) {
        whereClauses.push(`(${orConditions.join(' OR ')})`);
      }
    }
    if (filters.lt_id) {
      whereClauses.push('id < ?');
      values.push(filters.lt_id);
      orderBy = 'id DESC';
      shouldReverse = true;
    }
    if (filters.gt_id) {
      whereClauses.push('id > ?');
      values.push(filters.gt_id);
      orderBy = 'id ASC';
      shouldReverse = false;
    }
    if (filters.lte_timestamp || filters.gte_timestamp) {
      if (filters.lte_timestamp) {
        whereClauses.push('timestamp <= ?');
        values.push(new Date(filters.lte_timestamp));
        orderBy = 'timestamp DESC, id DESC';
        shouldReverse = true;
      }
      if (filters.gte_timestamp) {
        whereClauses.push('timestamp >= ?');
        values.push(new Date(filters.gte_timestamp));
        orderBy = 'timestamp ASC, id ASC';
        shouldReverse = false;
      }
      if (filters.lte_timestamp && !filters.gte_timestamp) {
        filters.lte_timestamp = new Date(filters.lte_timestamp);
        const gteTimestamp = new Date(filters.lte_timestamp.getTime() - 24 * 60 * 60 * 1000);
        whereClauses.push('timestamp >= ?');
        values.push(gteTimestamp);
        filters.gte_timestamp = gteTimestamp;
      }
      if (filters.gte_timestamp && !filters.lte_timestamp) {
        filters.gte_timestamp = new Date(filters.gte_timestamp);
        const lteTimestamp = new Date(filters.gte_timestamp.getTime() + 24 * 60 * 60 * 1000);
        whereClauses.push('timestamp <= ?');
        values.push(lteTimestamp);
        filters.lte_timestamp = lteTimestamp;
      }
    }

    const whereClause = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const limitClause = `LIMIT ${filters.limit}`;
    const query = `SELECT id, hostname, pid, source, timestamp, level, message, errsole_id FROM ${this.logsTable} ${whereClause} ORDER BY ${orderBy} ${limitClause}`;

    return new Promise((resolve, reject) => {
      this.db.all(query, values, (err, rows) => {
        if (err) return reject(new Error(err.message || err.toString()));
        if (shouldReverse) rows.reverse();
        resolve({ items: rows, filters });
      });
    });
  }

  /**
   * Deletes all logs from the logs table.
   *
   * @async
   * @function deleteAllLogs
   * @returns {Promise<{}>} - A Promise that resolves with an empty object upon successful deletion of the logs.
   * @throws {Error} - Throws an error if the operation fails.
   */
  async deleteAllLogs () {
    const runAsync = promisify(this.db.run.bind(this.db));
    try {
      await runAsync('BEGIN TRANSACTION;');
      await runAsync(`DROP TABLE IF EXISTS ${this.logsTable};`);
      for (const query of this.logsTableQueries) {
        await runAsync(query);
      }
      await runAsync('COMMIT;');
      return {};
    } catch (err) {
      await runAsync('ROLLBACK;');
      throw new Error(err.message || err.toString());
    }
  }

  /**
   * Retrieves the meta data of a log entry.
   *
   * @async
   * @function getMeta
   * @param {number} id - The unique ID of the log entry.
   * @returns {Promise<{item: id, meta}>}  - A Promise that resolves with an object containing the log ID and its associated metadata.
   * @throws {Error} - Throws an error if the log entry is not found or the operation fails.
   */
  async getMeta (id) {
    const query = `SELECT id, meta FROM ${this.logsTable} WHERE id = ?`;
    return new Promise((resolve, reject) => {
      this.db.get(query, [id], (err, row) => {
        if (err) return reject(new Error(err.message || err.toString()));
        if (!row) return reject(new Error('Log entry not found.'));
        resolve({ item: row });
      });
    });
  }

  /**
   * Inserts a notification, counts today's notifications, and retrieves the previous notification.
   * @param {Notification} notification - The notification to be inserted.
   * @returns {Promise<Object>} - Returns today's notification count and the previous notification.
   */
  async insertNotificationItem (notification = {}) {
    const errsoleId = notification.errsole_id;
    const hostname = notification.hostname;
    const hashedMessage = notification.hashed_message;

    try {
      await new Promise((resolve, reject) => {
        this.db.run('BEGIN TRANSACTION;', err => {
          if (err) return reject(new Error(err.message || err.toString()));
          resolve();
        });
      });

      const fetchPreviousNotificationQuery = `
        SELECT * FROM ${this.notificationsTable}
        WHERE hashed_message = ?
        ORDER BY created_at DESC
        LIMIT 1;
      `;
      const previousNotificationItem = await new Promise((resolve, reject) => {
        this.db.get(fetchPreviousNotificationQuery, [hashedMessage], (err, row) => {
          if (err) return reject(new Error(err.message || err.toString()));
          resolve(row);
        });
      });

      const insertNotificationQuery = `
        INSERT INTO ${this.notificationsTable} (errsole_id, hostname, hashed_message)
        VALUES (?, ?, ?);
      `;
      await new Promise((resolve, reject) => {
        this.db.run(insertNotificationQuery, [errsoleId, hostname, hashedMessage], err => {
          if (err) return reject(new Error(err.message || err.toString()));
          resolve();
        });
      });

      const countTodayNotificationsQuery = `
        SELECT COUNT(*) AS notificationCount FROM ${this.notificationsTable}
        WHERE hashed_message = ?
        AND created_at >= DATE('now', 'start of day', 'utc')
        AND created_at < DATE('now', 'start of day', 'utc', '+1 day');
      `;
      const todayNotificationCount = await new Promise((resolve, reject) => {
        this.db.get(countTodayNotificationsQuery, [hashedMessage], (err, result) => {
          if (err) return reject(new Error(err.message || err.toString()));
          resolve(result.notificationCount || 0);
        });
      });

      await new Promise((resolve, reject) => {
        this.db.run('COMMIT;', err => {
          if (err) return reject(new Error(err.message || err.toString()));
          resolve();
        });
      });

      return {
        previousNotificationItem,
        todayNotificationCount
      };
    } catch (err) {
      await new Promise(resolve => {
        this.db.run('ROLLBACK;', () => resolve());
      });
      throw new Error(err.message || err.toString());
    }
  }

  /**
   * Retrieves unique hostnames from the database.
   *
   * @async
   * @function getHostnames
   * @returns {Promise<{items: string[]}>} - A Promise that resolves with an object containing an array of unique hostnames.
   * @throws {Error} - Throws an error if the operation fails.
   */
  async getHostnames () {
    return { items: [] };
  }

  async deleteExpiredLogs () {
    if (this.deleteExpiredLogsRunning) return;

    this.deleteExpiredLogsRunning = true;

    const DEFAULT_LOGS_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days in milliseconds

    try {
      let logsTTL = DEFAULT_LOGS_TTL;
      const configResult = await this.getConfig('logsTTL');
      if (configResult.item) {
        const parsedTTL = parseInt(configResult.item.value, 10);
        logsTTL = isNaN(parsedTTL) ? DEFAULT_LOGS_TTL : parsedTTL;
      }
      let expirationTime = new Date(Date.now() - logsTTL);
      expirationTime = new Date(expirationTime);
      let deletedRowCount;
      do {
        deletedRowCount = await new Promise((resolve, reject) => {
          this.db.run(
            `DELETE FROM ${this.logsTable} WHERE id IN (SELECT id FROM ${this.logsTable} WHERE timestamp < ? LIMIT 1000)`,
            [expirationTime],
            function (err) { // You must use an old-school function () { ... } style callback rather than a lambda function, otherwise this.lastID and this.changes will be undefined.
              if (err) return reject(new Error(err.message || err.toString()));
              resolve(this.changes);
            }
          );
        });
        await new Promise(resolve => setTimeout(resolve, 10000));
      } while (deletedRowCount > 0);
    } catch (err) {
      console.error(new Error(err.message || err.toString()));
    } finally {
      this.deleteExpiredLogsRunning = false;
    }
  }

  async deleteExpiredNotificationItems () {
    if (this.deleteExpiredNotificationItemsRunning) return;

    this.deleteExpiredNotificationItemsRunning = true;

    const DEFAULT_NOTIFICATIONS_TTL = 7 * 24 * 60 * 60 * 1000;

    try {
      let notificationsTTL = DEFAULT_NOTIFICATIONS_TTL;
      const configResult = await this.getConfig('logsTTL');
      if (configResult.item) {
        const parsedTTL = parseInt(configResult.item.value, 10);
        notificationsTTL = isNaN(parsedTTL) ? DEFAULT_NOTIFICATIONS_TTL : parsedTTL;
      }
      const expirationTime = new Date(Date.now() - notificationsTTL).toISOString().slice(0, 19).replace('T', ' ');
      let deletedRowCount;
      do {
        const idsToDelete = await new Promise((resolve, reject) => {
          this.db.all(
            `SELECT id FROM ${this.notificationsTable} WHERE created_at < ? LIMIT 1000`,
            [expirationTime],
            (err, rows) => {
              if (err) return reject(new Error(err.message || err.toString()));
              resolve(rows.map(row => row.id));
            }
          );
        });
        if (idsToDelete.length === 0) break;
        await new Promise((resolve, reject) => {
          const placeholders = idsToDelete.map(() => '?').join(', ');
          this.db.run(
          `DELETE FROM ${this.notificationsTable} WHERE id IN (${placeholders})`,
          idsToDelete,
          function (err) { // You must use an old-school function () { ... } style callback rather than a lambda function, otherwise this.lastID and this.changes will be undefined.
            if (err) return reject(new Error(err.message || err.toString()));
            resolve(this.changes);
          }
          );
        });
        deletedRowCount = idsToDelete.length;
        await new Promise(resolve => setTimeout(resolve, 10000));
      } while (deletedRowCount > 0);
    } catch (err) {
      console.error(new Error(err.message || err.toString()));
    } finally {
      this.deleteExpiredNotificationItemsRunning = false;
    }
  }
}

module.exports = ErrsoleSQLite;
module.exports.default = ErrsoleSQLite;
