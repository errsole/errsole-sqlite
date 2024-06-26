const sqlite3 = require('sqlite3');
const bcrypt = require('bcryptjs');
const cron = require('node-cron');
const { EventEmitter } = require('events');

class ErrsoleSQLite extends EventEmitter {
  constructor (options = {}) {
    super();
    if (!options.logging) options.logging = false;

    this.name = require('../package.json').name;
    this.version = require('../package.json').version || '0.0.0';
    this.isConnectionInProgress = true;

    this.db = new sqlite3.Database(options.database || ':memory:', (err) => {
      if (err) {
        console.error('Failed to connect to SQLite database:', err);
      } else {
        this.initialize();
      }
    });
  }

  async initialize () {
    try {
      await this.defineTables();
      this.ensureLogsTTL();
      this.setCacheSize();
      this.emit('ready');
      cron.schedule('0 * * * *', () => {
        this.deleteExpiredLogs();
      });
    } catch (err) {
      console.error('Failed to initialize:', err);
    }
  }

  defineTables () {
    const queries = [
      `CREATE TABLE IF NOT EXISTS errsole_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hostname TEXT,
        pid INTEGER,
        source TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        level TEXT DEFAULT 'info',
        message TEXT,
        meta TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS errsole_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        email TEXT UNIQUE NOT NULL,
        hashed_password TEXT NOT NULL,
        role TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS errsole_config (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE NOT NULL,
        value TEXT NOT NULL
      )`
    ];

    return new Promise((resolve, reject) => {
      let remainingQueries = queries.length;

      queries.forEach((query) => {
        this.db.run(query, (err) => {
          if (err) {
            console.error('Failed to execute query:', query, err);
            return reject(err);
          }
          remainingQueries--;
          if (remainingQueries === 0) {
            this.isConnectionInProgress = false;
            resolve();
          }
        });
      });
    });
  }

  async getConfig (key) {
    const query = 'SELECT * FROM errsole_config WHERE `key` = ?';
    return new Promise((resolve, reject) => {
      this.db.get(query, [key], (err, result) => {
        if (err) return reject(err);
        resolve({ item: result });
      });
    });
  }

  async setConfig (key, value) {
    const query = 'INSERT INTO errsole_config (`key`, `value`) VALUES (?, ?) ON CONFLICT(`key`) DO UPDATE SET `value` = excluded.value';
    return new Promise((resolve, reject) => {
      this.db.run(query, [key, value], (err) => {
        if (err) return reject(err);
        this.getConfig(key).then(resolve).catch(reject);
      });
    });
  }

  async deleteConfig (key) {
    const query = 'DELETE FROM errsole_config WHERE `key` = ?';
    return new Promise((resolve, reject) => {
      this.db.run(query, [key], (err, result) => {
        if (err) return reject(err);
        if (result.changes === 0) return reject(new Error('Configuration not found.'));
        resolve({});
      });
    });
  }

  async postLogs (logEntries) {
    while (this.isConnectionInProgress) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    const values = logEntries.map(logEntry => [
      logEntry.hostname,
      logEntry.pid,
      logEntry.source,
      logEntry.level,
      logEntry.message,
      logEntry.meta
    ]);

    const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?)').join(',');

    const query = `INSERT INTO errsole_logs (hostname, pid, source, level, message, meta) VALUES ${placeholders}`;

    const flattenedValues = values.flat();

    return new Promise((resolve, reject) => {
      this.db.run(query, flattenedValues, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  async getLogs (filters = {}) {
    const whereClauses = [];
    const values = [];
    const defaultLimit = 100;
    filters.limit = filters.limit || defaultLimit;
    let sortOrder = 'DESC';
    let shouldReverse = true;

    // Apply filters
    if (filters.hostname) {
      whereClauses.push('hostname = ?');
      values.push(filters.hostname);
    }
    if (filters.pid) {
      whereClauses.push('pid = ?');
      values.push(filters.pid);
    }
    if (filters.sources && filters.sources.length > 0) {
      whereClauses.push('source IN (?)');
      values.push(filters.sources);
    }
    if (filters.levels && filters.levels.length > 0) {
      whereClauses.push('level IN (?)');
      values.push(filters.levels);
    }
    if (filters.level_json && filters.level_json.length > 0) {
      const levelConditions = filters.level_json.map(levelObj => '(source = ? AND level = ?)');
      whereClauses.push(`(${levelConditions.join(' OR ')})`);
      filters.level_json.forEach(levelObj => {
        values.push(levelObj.source, levelObj.level);
      });
    }
    if (filters.lt_id) {
      whereClauses.push('id < ?');
      values.push(filters.lt_id);
      sortOrder = 'DESC';
      shouldReverse = true;
    } else if (filters.gt_id) {
      whereClauses.push('id > ?');
      values.push(filters.gt_id);
      sortOrder = 'ASC';
      shouldReverse = false;
    } else if (filters.lte_timestamp || filters.gte_timestamp) {
      if (filters.lte_timestamp) {
        whereClauses.push('timestamp <= ?');
        values.push(new Date(filters.lte_timestamp).toISOString());
        sortOrder = 'DESC';
        shouldReverse = true;
      }
      if (filters.gte_timestamp) {
        whereClauses.push('timestamp >= ?');
        values.push(new Date(filters.gte_timestamp).toISOString());
        sortOrder = 'ASC';
        shouldReverse = false;
      }
    }

    const whereClause = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const query = `SELECT id, hostname, pid, source, timestamp, level, message FROM errsole_logs ${whereClause} ORDER BY id ${sortOrder} LIMIT ?`;
    values.push(filters.limit);

    return new Promise((resolve, reject) => {
      this.db.all(query, values, (err, results) => {
        if (err) return reject(err);
        if (shouldReverse) results.reverse();
        resolve({ items: results });
      });
    });
  }

  async searchLogs (searchTerms, filters = {}) {
    const whereClauses = searchTerms.map(() => 'message LIKE ?');
    const values = searchTerms.map(term => `%${term}%`);
    filters.limit = filters.limit || 100;

    if (filters.hostname) {
      whereClauses.push('hostname = ?');
      values.push(filters.hostname);
    }
    if (filters.pid) {
      whereClauses.push('pid = ?');
      values.push(filters.pid);
    }
    if (filters.sources) {
      whereClauses.push('source IN (?)');
      values.push(filters.sources);
    }
    if (filters.levels) {
      whereClauses.push('level IN (?)');
      values.push(filters.levels);
    }
    if (filters.level_json) {
      filters.level_json.forEach(levelObj => {
        whereClauses.push('(source = ? AND level = ?)');
        values.push(levelObj.source, levelObj.level);
      });
    }
    if (filters.lt_id) {
      whereClauses.push('id < ?');
      values.push(filters.lt_id);
    } else if (filters.gt_id) {
      whereClauses.push('id > ?');
      values.push(filters.gt_id);
    } else if (filters.lte_timestamp || filters.gte_timestamp) {
      if (filters.lte_timestamp) {
        whereClauses.push('timestamp <= ?');
        values.push(new Date(filters.lte_timestamp).toISOString());
      }
      if (filters.gte_timestamp) {
        whereClauses.push('timestamp >= ?');
        values.push(new Date(filters.gte_timestamp).toISOString());
      }
    }

    const whereClause = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const query = `SELECT id, hostname, pid, source, timestamp, level, message FROM errsole_logs ${whereClause} ORDER BY id DESC LIMIT ?`;
    values.push(filters.limit);

    return new Promise((resolve, reject) => {
      this.db.all(query, values, (err, results) => {
        if (err) return reject(err);
        resolve({ items: results });
      });
    });
  }

  async getMeta (id) {
    const query = 'SELECT id, meta FROM errsole_logs WHERE id = ?';
    return new Promise((resolve, reject) => {
      this.db.get(query, [id], (err, result) => {
        if (err) return reject(err);
        if (!result) return reject(new Error('Log entry not found.'));
        resolve({ item: result });
      });
    });
  }

  async ensureLogsTTL () {
    const DEFAULT_TTL = 2592000000;
    try {
      const configResult = await this.getConfig('logsTTL');
      if (!configResult.item) {
        await this.setConfig('logsTTL', DEFAULT_TTL.toString());
      }
    } catch {}
  }

  /**
   * Deletes expired logs based on TTL configuration.
   *
   * @async
   * @function deleteExpiredLogs
   */

  async deleteExpiredLogs () {
    if (this.deleteExpiredLogsRunning) return;

    this.deleteExpiredLogsRunning = true;

    const logsTTLDefault = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds

    try {
      let logsTTL = logsTTLDefault;
      const configResult = await this.getConfig('logsTTL');
      if (configResult && configResult.item && configResult.item.value) {
        logsTTL = parseInt(configResult.item.value, 10);
      }
      let expirationTime = new Date(Date.now() - logsTTL);
      expirationTime = new Date(expirationTime).toISOString();
      let deletedRowCount;
      do {
        const result = await new Promise((resolve, reject) => {
          this.db.run(
            'DELETE FROM errsole_logs WHERE id IN (SELECT id FROM errsole_logs WHERE timestamp < ? LIMIT 1000)',
            [expirationTime],
            function (err) {
              if (err) {
                console.error(err);
                return reject(err);
              }
              resolve(this.changes);
            }
          );
        });
        deletedRowCount = result;
        await new Promise(resolve => setTimeout(resolve, 10000));
      } while (deletedRowCount > 0);
    } catch (err) {
      console.error(err);
    } finally {
      this.deleteExpiredLogsRunning = false;
    }
  }

  async delay (ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async createUser (user) {
    const SALT_ROUNDS = 10;
    const hashedPassword = await bcrypt.hash(user.password, SALT_ROUNDS);
    const query = 'INSERT INTO errsole_users (name, email, hashed_password, role) VALUES (?, ?, ?, ?)';
    return new Promise((resolve, reject) => {
      this.db.run(query, [user.name, user.email, hashedPassword, user.role], function (err) {
        if (err) {
          if (err.code === 'SQLITE_CONSTRAINT') return reject(new Error('A user with the provided email already exists.'));
          return reject(err);
        }
        resolve({ item: { id: this.lastID, name: user.name, email: user.email, role: user.role } });
      });
    });
  }

  async verifyUser (email, password) {
    if (!email || !password) throw new Error('Both email and password are required for verification.');

    const query = 'SELECT * FROM errsole_users WHERE email = ?';
    return new Promise((resolve, reject) => {
      this.db.get(query, [email], async (err, user) => {
        if (err) return reject(err);
        if (!user) return reject(new Error('User not found.'));

        const isPasswordCorrect = await bcrypt.compare(password, user.hashed_password);
        if (!isPasswordCorrect) return reject(new Error('Incorrect password.'));

        delete user.hashed_password;
        resolve({ item: user });
      });
    });
  }

  async getUserCount () {
    const query = 'SELECT COUNT(*) as count FROM errsole_users';
    return new Promise((resolve, reject) => {
      this.db.get(query, (err, result) => {
        if (err) return reject(err);
        resolve({ count: result.count });
      });
    });
  }

  async getAllUsers () {
    const query = 'SELECT id, name, email, role FROM errsole_users';
    return new Promise((resolve, reject) => {
      this.db.all(query, (err, results) => {
        if (err) return reject(err);
        resolve({ items: results });
      });
    });
  }

  async getUserByEmail (email) {
    if (!email) throw new Error('Email is required.');

    const query = 'SELECT id, name, email, role FROM errsole_users WHERE email = ?';
    return new Promise((resolve, reject) => {
      this.db.get(query, [email], (err, result) => {
        if (err) return reject(err);
        if (!result) return reject(new Error('User not found.'));
        resolve({ item: result });
      });
    });
  }

  async updateUserByEmail (email, updates) {
    if (!email) throw new Error('Email is required.');
    if (!updates || Object.keys(updates).length === 0) throw new Error('No updates provided.');

    const restrictedFields = ['id', 'hashed_password'];
    restrictedFields.forEach(field => delete updates[field]);

    const setClause = Object.keys(updates).map(key => `${key} = ?`).join(', ');
    const values = [...Object.values(updates), email];

    const query = `UPDATE errsole_users SET ${setClause} WHERE email = ?`;
    return new Promise((resolve, reject) => {
      this.db.run(query, values, async (err) => {
        if (err) return reject(err);
        this.getUserByEmail(email).then(resolve).catch(reject);
      });
    });
  }

  async updatePassword (email, currentPassword, newPassword) {
    if (!email || !currentPassword || !newPassword) throw new Error('Email, current password, and new password are required.');

    const query = 'SELECT * FROM errsole_users WHERE email = ?';
    return new Promise((resolve, reject) => {
      this.db.get(query, [email], async (err, user) => {
        if (err) return reject(err);
        if (!user) return reject(new Error('User not found.'));

        const isPasswordCorrect = await bcrypt.compare(currentPassword, user.hashed_password);
        if (!isPasswordCorrect) return reject(new Error('Current password is incorrect.'));

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        const updateQuery = 'UPDATE errsole_users SET hashed_password = ? WHERE email = ?';
        this.db.run(updateQuery, [hashedPassword, email], function (err) {
          if (err) return reject(err);
          delete user.hashed_password;
          resolve({ item: user });
        });
      });
    });
  }

  async deleteUser (userId) {
    if (!userId) throw new Error('User ID is required.');

    const query = 'DELETE FROM errsole_users WHERE id = ?';
    return new Promise((resolve, reject) => {
      this.db.run(query, [userId], function (err) {
        if (err) return reject(err);
        if (this.changes === 0) return reject(new Error('User not found.'));
        resolve({});
      });
    });
  }

  async getCacheSize () {
    const query = 'PRAGMA cache_size';
    return new Promise((resolve, reject) => {
      this.db.get(query, (err, result) => {
        if (err) {
          return reject(err);
        }

        resolve(result.cache_size);
      });
    });
  }

  async setCacheSize () {
    const desiredSize = 8192;
    const currentSize = await this.getCacheSize();

    if (currentSize < desiredSize) {
      const query = `PRAGMA cache_size = ${desiredSize}`;
      return new Promise((resolve, reject) => {
        this.db.run(query, (err) => {
          if (err) {
            return reject(err);
          }

          resolve();
        });
      });
    } else {
      return Promise.resolve();
    }
  }
}

module.exports = ErrsoleSQLite;
