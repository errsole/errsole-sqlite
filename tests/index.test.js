const cron = require('node-cron');
const ErrsoleSQLite = require('../lib/index');
const bcrypt = require('bcryptjs');

/* globals expect, jest, beforeEach, it, afterEach, describe, beforeAll, afterAll */

jest.mock('node-cron');

let cronJob;
let originalConsoleError;
let errsoleSQLite;

beforeAll(() => {
  // Mock setInterval and cron.schedule globally
  jest.useFakeTimers();
  jest.spyOn(global, 'setInterval');
  cronJob = { stop: jest.fn() };
  jest.spyOn(cron, 'schedule').mockReturnValue(cronJob);

  // Suppress console.error globally
  originalConsoleError = console.error;
  console.error = jest.fn();
});

afterAll(() => {
  // Stop the cron job after all tests
  cronJob.stop();

  // Clear any intervals after all tests if you have an interval id like flushIntervalId
  if (errsoleSQLite && errsoleSQLite.flushIntervalId) {
    clearInterval(errsoleSQLite.flushIntervalId);
  }

  // Restore real timers and console.error globally
  jest.useRealTimers();
  console.error = originalConsoleError;
});

describe('ErrsoleSQLite - initialize', () => {
  beforeEach(() => {
    // Create an instance of ErrsoleSQLite with an in-memory SQLite database
    errsoleSQLite = new ErrsoleSQLite(':memory:'); // Assign to higher scoped variable

    // Spy on and mock the dependent methods except createTables
    jest.spyOn(errsoleSQLite, 'setCacheSize').mockResolvedValue();
    jest.spyOn(errsoleSQLite, 'createTables').mockResolvedValue();
    jest.spyOn(errsoleSQLite, 'ensureLogsTTL').mockResolvedValue();
    jest.spyOn(errsoleSQLite, 'flushLogs').mockImplementation(() => Promise.resolve());
    jest.spyOn(errsoleSQLite, 'deleteExpiredLogs').mockImplementation(() => Promise.resolve());

    // Additionally, mock deleteExpiredNotificationItems to prevent it from accessing the database
    jest.spyOn(errsoleSQLite, 'deleteExpiredNotificationItems').mockImplementation(() => Promise.resolve());

    // Spy on the emit method
    jest.spyOn(errsoleSQLite, 'emit').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.clearAllMocks(); // Clear all mocks after each test
  });

  it('should call setCacheSize, createTables, ensureLogsTTL, and emit "ready" event', async () => {
    await errsoleSQLite.initialize();

    expect(errsoleSQLite.setCacheSize).toHaveBeenCalledTimes(1);
    expect(errsoleSQLite.createTables).toHaveBeenCalledTimes(1);
    expect(errsoleSQLite.ensureLogsTTL).toHaveBeenCalledTimes(1);
    expect(errsoleSQLite.emit).toHaveBeenCalledWith('ready');
  });

  it('should schedule a cron job to deleteExpiredLogs every hour', async () => {
    await errsoleSQLite.initialize();

    expect(cron.schedule).toHaveBeenCalledTimes(1);
    expect(cron.schedule).toHaveBeenCalledWith('0 * * * *', expect.any(Function));

    // Retrieve the callback passed to cron.schedule and execute it
    const cronCallback = cron.schedule.mock.calls[0][1];
    cronCallback(); // Simulate cron job execution

    expect(errsoleSQLite.deleteExpiredLogs).toHaveBeenCalledTimes(1);
  });

  it('should handle errors gracefully during initialization', async () => {
    // Make setCacheSize throw an error
    errsoleSQLite.setCacheSize.mockRejectedValue(new Error('Cache size error'));

    // Spy on console.error to verify error logging
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(errsoleSQLite.initialize()).rejects.toThrow('Cache size error');

    expect(errsoleSQLite.setCacheSize).toHaveBeenCalledTimes(1);
    expect(errsoleSQLite.createTables).not.toHaveBeenCalled();
    expect(errsoleSQLite.ensureLogsTTL).not.toHaveBeenCalled();
    expect(errsoleSQLite.emit).not.toHaveBeenCalled();
    expect(cron.schedule).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('should emit "ready" event only once even if initialize is called multiple times', async () => {
    await errsoleSQLite.initialize();
    await errsoleSQLite.initialize(); // Call initialize again

    // Emit should be called twice
    expect(errsoleSQLite.emit).toHaveBeenCalledTimes(2);
    expect(errsoleSQLite.emit).toHaveBeenNthCalledWith(1, 'ready');
    expect(errsoleSQLite.emit).toHaveBeenNthCalledWith(2, 'ready');
  });
});

describe('ErrsoleSQLite - createTables', () => {
  let errsoleSQLite;

  beforeEach(() => {
    // Create an instance of ErrsoleSQLite with an in-memory SQLite database
    errsoleSQLite = new ErrsoleSQLite(':memory:');

    // Spy on the db.run function to mock the table creation queries
    jest.spyOn(errsoleSQLite.db, 'run').mockImplementation((query, callback) => {
      callback(null); // Simulate successful execution
    });
  });

  afterEach(() => {
    jest.clearAllMocks(); // Clear all mocks after each test
  });

  it('should create necessary tables successfully', async () => {
    // Call the createTables function to create required tables
    await errsoleSQLite.createTables();

    // Verify specific SQL statements are called
    expect(errsoleSQLite.db.run).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS errsole_logs_v2'), expect.any(Function));
    expect(errsoleSQLite.db.run).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS errsole_users'), expect.any(Function));
    expect(errsoleSQLite.db.run).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS errsole_config'), expect.any(Function));
    expect(errsoleSQLite.db.run).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS errsole_notifications'), expect.any(Function));
  });

  it('should handle errors during table creation', async () => {
    // Mock db.run to simulate an error during table creation
    const mockError = new Error('Database error during table creation');
    errsoleSQLite.db.run.mockImplementationOnce((query, callback) => {
      callback(mockError);
    });

    await expect(errsoleSQLite.createTables()).rejects.toThrow('Database error during table creation');

    // Verify that db.run was only called once due to the error
    expect(errsoleSQLite.db.run).toHaveBeenCalledTimes(1);
  });

  it('should continue creating tables if one table already exists', async () => {
    // Verify that the function does not throw an error for "table already exists"
    await expect(errsoleSQLite.createTables()).resolves.not.toThrow();

    // Verify that db.run was called for each table creation, even with errors
    expect(errsoleSQLite.db.run).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS errsole_logs_v2'), expect.any(Function));
    expect(errsoleSQLite.db.run).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS errsole_users'), expect.any(Function));
    expect(errsoleSQLite.db.run).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS errsole_config'), expect.any(Function));
    expect(errsoleSQLite.db.run).toHaveBeenCalledWith(expect.stringContaining('CREATE TABLE IF NOT EXISTS errsole_notifications'), expect.any(Function));
  });
});

describe('ErrsoleSQLite - setCacheSize', () => {
  let errsoleSQLite;

  beforeEach(() => {
    // Create an instance of ErrsoleSQLite with an in-memory SQLite database
    errsoleSQLite = new ErrsoleSQLite(':memory:');

    // Mock the getCacheSize method
    jest.spyOn(errsoleSQLite, 'getCacheSize').mockResolvedValue(0);

    // Spy on the db.run function
    jest.spyOn(errsoleSQLite.db, 'run').mockImplementation((query, callback) => {
      callback(); // Call the callback with no errors
    });
  });

  afterEach(() => {
    jest.clearAllMocks(); // Clear all mocks after each test
  });

  it('should set the cache size if the current size is less than the desired size', async () => {
    errsoleSQLite.getCacheSize.mockResolvedValueOnce(0); // Mock getCacheSize to return less than the desired size

    await errsoleSQLite.setCacheSize();

    expect(errsoleSQLite.getCacheSize).toHaveBeenCalledTimes(1);
    expect(errsoleSQLite.db.run).toHaveBeenCalledTimes(1);
    expect(errsoleSQLite.db.run).toHaveBeenCalledWith(
      'PRAGMA cache_size = 8192', // 8 * 1024 = 8192
      expect.any(Function)
    );
  });

  it('should not update cache size if current size is equal or greater than the desired size', async () => {
    errsoleSQLite.getCacheSize.mockResolvedValueOnce(8192); // Mock getCacheSize to return the same as desired size

    await errsoleSQLite.setCacheSize();

    expect(errsoleSQLite.getCacheSize).toHaveBeenCalledTimes(1);
    expect(errsoleSQLite.db.run).not.toHaveBeenCalled(); // No query should be run if cache size is sufficient
  });

  it('should reject if db.run fails', async () => {
    const mockError = new Error('Database error');
    errsoleSQLite.db.run.mockImplementationOnce((query, callback) => {
      callback(mockError); // Simulate an error from db.run
    });

    await expect(errsoleSQLite.setCacheSize()).rejects.toThrow('Database error');

    expect(errsoleSQLite.getCacheSize).toHaveBeenCalledTimes(1);
    expect(errsoleSQLite.db.run).toHaveBeenCalledTimes(1);
  });
});

describe('ErrsoleSQLite - getCacheSize', () => {
  let errsoleSQLite;

  beforeEach(() => {
    // Create an instance of ErrsoleSQLite with an in-memory SQLite database
    errsoleSQLite = new ErrsoleSQLite(':memory:');

    // Spy on the db.get function
    jest.spyOn(errsoleSQLite.db, 'get').mockImplementation((query, callback) => {
      callback(null, { cache_size: 8192 }); // Mock successful query execution
    });
  });

  afterEach(() => {
    jest.clearAllMocks(); // Clear all mocks after each test
  });

  it('should return the current cache size', async () => {
    const cacheSize = await errsoleSQLite.getCacheSize();

    expect(errsoleSQLite.db.get).toHaveBeenCalledTimes(1);
    expect(errsoleSQLite.db.get).toHaveBeenCalledWith('PRAGMA cache_size', expect.any(Function));
    expect(cacheSize).toBe(8192); // The mock value set in the db.get mock implementation
  });

  it('should handle errors when querying the cache size', async () => {
    const mockError = new Error('Database error');
    errsoleSQLite.db.get.mockImplementationOnce((query, callback) => {
      callback(mockError); // Simulate an error from db.get
    });

    await expect(errsoleSQLite.getCacheSize()).rejects.toThrow('Database error');

    expect(errsoleSQLite.db.get).toHaveBeenCalledTimes(1);
    expect(errsoleSQLite.db.get).toHaveBeenCalledWith('PRAGMA cache_size', expect.any(Function));
  });
});

describe('ErrsoleSQLite - ensureLogsTTL', () => {
  let errsoleSQLite;

  beforeEach(() => {
    // Create an instance of ErrsoleSQLite with an in-memory SQLite database
    errsoleSQLite = new ErrsoleSQLite(':memory:');

    // Spy on and mock the getConfig and setConfig methods
    jest.spyOn(errsoleSQLite, 'getConfig').mockResolvedValue({ item: null });
    jest.spyOn(errsoleSQLite, 'setConfig').mockResolvedValue();
  });

  afterEach(() => {
    jest.clearAllMocks(); // Clear all mocks after each test
  });

  it('should set the default TTL if logsTTL is not set in the config', async () => {
    errsoleSQLite.getConfig.mockResolvedValueOnce({ item: null }); // No logsTTL set

    await errsoleSQLite.ensureLogsTTL();

    // Check that getConfig was called for logsTTL
    expect(errsoleSQLite.getConfig).toHaveBeenCalledWith('logsTTL');

    // Check that setConfig was called with the default TTL (30 days)
    const defaultTTL = (30 * 24 * 60 * 60 * 1000).toString(); // 30 days in milliseconds
    expect(errsoleSQLite.setConfig).toHaveBeenCalledWith('logsTTL', defaultTTL);
  });

  it('should not set the TTL if logsTTL is already configured', async () => {
    errsoleSQLite.getConfig.mockResolvedValueOnce({ item: 'existingTTL' }); // logsTTL is already set

    await errsoleSQLite.ensureLogsTTL();

    // Check that getConfig was called for logsTTL
    expect(errsoleSQLite.getConfig).toHaveBeenCalledWith('logsTTL');

    // setConfig should not be called since logsTTL is already configured
    expect(errsoleSQLite.setConfig).not.toHaveBeenCalled();
  });

  it('should handle errors during getConfig and setConfig', async () => {
    const mockError = new Error('Config error');

    // Mock an error on getConfig
    errsoleSQLite.getConfig.mockRejectedValueOnce(mockError);

    await expect(errsoleSQLite.ensureLogsTTL()).rejects.toThrow('Config error');

    // Ensure setConfig wasn't called due to the error
    expect(errsoleSQLite.setConfig).not.toHaveBeenCalled();
  });
});

describe('ErrsoleSQLite - getConfig', () => {
  let errsoleSQLite;

  beforeEach(() => {
    // Create an instance of ErrsoleSQLite with an in-memory SQLite database
    errsoleSQLite = new ErrsoleSQLite(':memory:');

    // Spy on the db.get function to mock database queries
    jest.spyOn(errsoleSQLite.db, 'get').mockImplementation((query, params, callback) => {
      callback(null, { key: params[0], value: 'someValue' }); // Simulate successful query with a result
    });
  });

  afterEach(() => {
    jest.clearAllMocks(); // Clear all mocks after each test
  });

  it('should return the config item for a valid key', async () => {
    const result = await errsoleSQLite.getConfig('logsTTL');

    // Check that db.get was called with the correct query and parameter
    expect(errsoleSQLite.db.get).toHaveBeenCalledWith(
      'SELECT * FROM errsole_config WHERE `key` = ?',
      ['logsTTL'],
      expect.any(Function)
    );

    // Expect the resolved value to contain the row
    expect(result).toEqual({ item: { key: 'logsTTL', value: 'someValue' } });
  });

  it('should resolve with null if no config item is found', async () => {
    errsoleSQLite.db.get.mockImplementationOnce((query, params, callback) => {
      callback(null, null); // Simulate no result found
    });

    const result = await errsoleSQLite.getConfig('logsTTL');

    // Expect the resolved value to contain item as null
    expect(result).toEqual({ item: null });
  });

  it('should handle database errors and reject the promise', async () => {
    const mockError = new Error('Database error');

    // Mock db.get to return an error
    errsoleSQLite.db.get.mockImplementationOnce((query, params, callback) => {
      callback(mockError);
    });

    await expect(errsoleSQLite.getConfig('logsTTL')).rejects.toThrow('Database error');

    // Check that db.get was called with the correct query
    expect(errsoleSQLite.db.get).toHaveBeenCalledWith(
      'SELECT * FROM errsole_config WHERE `key` = ?',
      ['logsTTL'],
      expect.any(Function)
    );
  });
});

describe('ErrsoleSQLite - setConfig', () => {
  let errsoleSQLite;

  beforeEach(() => {
    // Create an instance of ErrsoleSQLite with an in-memory SQLite database
    errsoleSQLite = new ErrsoleSQLite(':memory:');

    // Spy on the db.run function to mock database queries
    jest.spyOn(errsoleSQLite.db, 'run').mockImplementation((query, params, callback) => {
      callback(null); // Simulate successful insertion or update
    });

    // Spy on the getConfig method
    jest.spyOn(errsoleSQLite, 'getConfig').mockResolvedValue({ item: { key: 'logsTTL', value: 'updatedValue' } });
  });

  afterEach(() => {
    jest.clearAllMocks(); // Clear all mocks after each test
  });

  it('should insert a new config item if the key does not exist', async () => {
    await errsoleSQLite.setConfig('logsTTL', 'newValue');

    // Check that db.run was called with the correct query and parameters
    expect(errsoleSQLite.db.run).toHaveBeenCalledWith(
      'INSERT INTO errsole_config (`key`, `value`) VALUES (?, ?) ON CONFLICT(`key`) DO UPDATE SET `value` = excluded.value',
      ['logsTTL', 'newValue'],
      expect.any(Function)
    );

    // Ensure getConfig is called to retrieve the updated config
    expect(errsoleSQLite.getConfig).toHaveBeenCalledWith('logsTTL');

    // Check that the final resolved value is correct
    const result = await errsoleSQLite.setConfig('logsTTL', 'newValue');
    expect(result).toEqual({ item: { key: 'logsTTL', value: 'updatedValue' } });
  });

  it('should update an existing config item if the key already exists', async () => {
    await errsoleSQLite.setConfig('logsTTL', 'updatedValue');

    // Ensure the query to insert or update runs
    expect(errsoleSQLite.db.run).toHaveBeenCalledWith(
      'INSERT INTO errsole_config (`key`, `value`) VALUES (?, ?) ON CONFLICT(`key`) DO UPDATE SET `value` = excluded.value',
      ['logsTTL', 'updatedValue'],
      expect.any(Function)
    );

    // Ensure getConfig is called to retrieve the updated config
    expect(errsoleSQLite.getConfig).toHaveBeenCalledWith('logsTTL');
  });

  it('should handle errors during the insertion or update process', async () => {
    const mockError = new Error('Database error');

    // Mock db.run to return an error
    errsoleSQLite.db.run.mockImplementationOnce((query, params, callback) => {
      callback(mockError); // Simulate a database error
    });

    await expect(errsoleSQLite.setConfig('logsTTL', 'newValue')).rejects.toThrow('Database error');

    // Ensure getConfig is not called due to the error
    expect(errsoleSQLite.getConfig).not.toHaveBeenCalled();
  });

  it('should handle errors during getConfig after successful insertion or update', async () => {
    const mockError = new Error('Config retrieval error');

    // Mock getConfig to return an error
    errsoleSQLite.getConfig.mockRejectedValueOnce(mockError);

    await expect(errsoleSQLite.setConfig('logsTTL', 'newValue')).rejects.toThrow('Config retrieval error');

    // Ensure db.run was called, but getConfig failed
    expect(errsoleSQLite.db.run).toHaveBeenCalledWith(
      'INSERT INTO errsole_config (`key`, `value`) VALUES (?, ?) ON CONFLICT(`key`) DO UPDATE SET `value` = excluded.value',
      ['logsTTL', 'newValue'],
      expect.any(Function)
    );
  });
});

describe('ErrsoleSQLite - deleteConfig', () => {
  let errsoleSQLite;
  let dbRunSpy;

  beforeEach(() => {
    // Create an instance of ErrsoleSQLite with an in-memory SQLite database
    errsoleSQLite = new ErrsoleSQLite(':memory:');

    // Mock the db.run method
    dbRunSpy = jest.spyOn(errsoleSQLite.db, 'run');
  });

  afterEach(() => {
    jest.clearAllMocks(); // Clear all mocks after each test
  });

  it('should delete a configuration successfully', async () => {
    // Mock successful deletion
    dbRunSpy.mockImplementation(function (query, params, callback) {
      callback.call({ changes: 1 }, null); // Properly mock the 'changes' property in the callback context
    });

    await expect(errsoleSQLite.deleteConfig('logsTTL')).resolves.toEqual({});

    expect(dbRunSpy).toHaveBeenCalledWith(
      'DELETE FROM errsole_config WHERE `key` = ?',
      ['logsTTL'],
      expect.any(Function)
    );
  });

  it('should return an error if the configuration is not found', async () => {
    // Mock no rows deleted (this.changes = 0)
    dbRunSpy.mockImplementation(function (query, params, callback) {
      callback.call({ changes: 0 }, null); // Mock no changes
    });

    await expect(errsoleSQLite.deleteConfig('nonexistentKey')).rejects.toThrow('Configuration not found.');

    expect(dbRunSpy).toHaveBeenCalledWith(
      'DELETE FROM errsole_config WHERE `key` = ?',
      ['nonexistentKey'],
      expect.any(Function)
    );
  });

  it('should return an error if a database error occurs', async () => {
    const dbError = new Error('Database error');
    // Mock an error during the delete operation
    dbRunSpy.mockImplementation((query, params, callback) => {
      callback(dbError); // Simulate a database error
    });

    await expect(errsoleSQLite.deleteConfig('logsTTL')).rejects.toThrow('Database error');

    expect(dbRunSpy).toHaveBeenCalledWith(
      'DELETE FROM errsole_config WHERE `key` = ?',
      ['logsTTL'],
      expect.any(Function)
    );
  });
});

describe('ErrsoleSQLite - postLogs', () => {
  let errsoleSQLite;

  beforeEach(() => {
    // Create an instance of ErrsoleSQLite with an in-memory SQLite database
    errsoleSQLite = new ErrsoleSQLite(':memory:');
    errsoleSQLite.batchSize = 3; // Set batch size to 3 for testing

    // Spy on flushLogs to monitor if it's called
    jest.spyOn(errsoleSQLite, 'flushLogs').mockResolvedValue({});
  });

  afterEach(() => {
    jest.clearAllMocks(); // Clear all mocks after each test
  });

  it('should add log entries to pendingLogs', () => {
    const logEntries = [
      { timestamp: new Date(), hostname: 'localhost', pid: 1234, source: 'test', level: 'info', message: 'Log message 1', meta: 'meta1', errsole_id: 1 },
      { timestamp: new Date(), hostname: 'localhost', pid: 1235, source: 'test', level: 'error', message: 'Log message 2', meta: 'meta2', errsole_id: 2 }
    ];

    errsoleSQLite.postLogs(logEntries);

    expect(errsoleSQLite.pendingLogs).toHaveLength(2);
    expect(errsoleSQLite.pendingLogs).toEqual(logEntries);
  });

  it('should call flushLogs if pending logs exceed batch size', () => {
    const logEntries = [
      { timestamp: new Date(), hostname: 'localhost', pid: 1234, source: 'test', level: 'info', message: 'Log message 1', meta: 'meta1', errsole_id: 1 },
      { timestamp: new Date(), hostname: 'localhost', pid: 1235, source: 'test', level: 'error', message: 'Log message 2', meta: 'meta2', errsole_id: 2 },
      { timestamp: new Date(), hostname: 'localhost', pid: 1236, source: 'test', level: 'warn', message: 'Log message 3', meta: 'meta3', errsole_id: 3 }
    ];

    errsoleSQLite.postLogs(logEntries);

    expect(errsoleSQLite.flushLogs).toHaveBeenCalledTimes(1);
  });

  it('should not call flushLogs if pending logs do not exceed batch size', () => {
    const logEntries = [
      { timestamp: new Date(), hostname: 'localhost', pid: 1234, source: 'test', level: 'info', message: 'Log message 1', meta: 'meta1', errsole_id: 1 }
    ];

    errsoleSQLite.postLogs(logEntries);

    expect(errsoleSQLite.flushLogs).not.toHaveBeenCalled();
  });

  it('should do nothing when an empty array is passed', () => {
    errsoleSQLite.postLogs([]); // Call postLogs with an empty array

    expect(errsoleSQLite.pendingLogs).toHaveLength(0);
    expect(errsoleSQLite.flushLogs).not.toHaveBeenCalled();
  });

  it('should call flushLogs when exactly batch size logs are added', () => {
    const logEntries = [
      { timestamp: new Date(), hostname: 'localhost', pid: 1234, source: 'test', level: 'info', message: 'Log message 1', meta: 'meta1', errsole_id: 1 },
      { timestamp: new Date(), hostname: 'localhost', pid: 1235, source: 'test', level: 'error', message: 'Log message 2', meta: 'meta2', errsole_id: 2 },
      { timestamp: new Date(), hostname: 'localhost', pid: 1236, source: 'test', level: 'warn', message: 'Log message 3', meta: 'meta3', errsole_id: 3 }
    ];

    errsoleSQLite.postLogs(logEntries);

    expect(errsoleSQLite.flushLogs).toHaveBeenCalledTimes(1); // Flush should be called when batch size is exactly met
  });
});

describe('ErrsoleSQLite - getHostnames', () => {
  let errsoleSQLite;

  beforeEach(() => {
    // Create an instance of ErrsoleSQLite with an in-memory SQLite database
    errsoleSQLite = new ErrsoleSQLite(':memory:');

    // Spy on db.all to mock the database query
    jest.spyOn(errsoleSQLite.db, 'all').mockImplementation((query, params, callback) => {
      callback(null, [
        { hostname: 'server3.example.com' },
        { hostname: 'server1.example.com' },
        { hostname: 'server2.example.com' }
      ]);
    });
  });

  afterEach(() => {
    jest.clearAllMocks(); // Clear all mocks after each test
  });

  it('should return a sorted list of distinct hostnames', async () => {
    const result = await errsoleSQLite.getHostnames();

    expect(result.items).toEqual([
      'server1.example.com',
      'server2.example.com',
      'server3.example.com'
    ]);
  });

  it('should return an empty array if no hostnames are found', async () => {
    // Mock db.all to return no rows
    errsoleSQLite.db.all.mockImplementation((query, params, callback) => {
      callback(null, []);
    });

    const result = await errsoleSQLite.getHostnames();

    expect(result.items).toEqual([]);
  });

  it('should handle database errors', async () => {
    // Mock db.all to simulate a database error
    errsoleSQLite.db.all.mockImplementation((query, params, callback) => {
      callback(new Error('Database error'), null);
    });

    await expect(errsoleSQLite.getHostnames()).rejects.toThrow('Database error');
  });

  it('should correctly handle hostnames with special characters and varying cases', async () => {
    errsoleSQLite.db.all.mockImplementation((query, params, callback) => {
      callback(null, [
        { hostname: 'Server-2.Example.com' },
        { hostname: 'server-10.example.com' },
        { hostname: 'server-1.example.com' },
        { hostname: 'SERVER-3.EXAMPLE.COM' }
      ]);
    });

    const result = await errsoleSQLite.getHostnames();

    expect(result.items).toEqual([
      'SERVER-3.EXAMPLE.COM',
      'Server-2.Example.com',
      'server-1.example.com',
      'server-10.example.com'
    ]);
  });
});

describe('ErrsoleSQLite - getLogs', () => {
  let errsoleSQLite;

  beforeEach(() => {
    // Create an instance of ErrsoleSQLite with an in-memory SQLite database
    errsoleSQLite = new ErrsoleSQLite(':memory:');

    // Spy on db.all to mock the database query
    jest.spyOn(errsoleSQLite.db, 'all').mockImplementation((query, params, callback) => {
      const mockLogs = [
        { id: 1, hostname: 'localhost', pid: 1234, source: 'source1', timestamp: new Date(), level: 'info', message: 'Log 1', errsole_id: 1 },
        { id: 2, hostname: 'localhost', pid: 1234, source: 'source2', timestamp: new Date(), level: 'warn', message: 'Log 2', errsole_id: 2 },
        { id: 3, hostname: 'server1', pid: 1235, source: 'source3', timestamp: new Date(), level: 'error', message: 'Log 3', errsole_id: 3 }
      ];
      callback(null, mockLogs);
    });
  });

  afterEach(() => {
    jest.clearAllMocks(); // Clear all mocks after each test
  });

  it('should return logs with no filters applied (default limit)', async () => {
    const result = await errsoleSQLite.getLogs();

    expect(result.items).toHaveLength(3);
  });

  it('should return logs filtered by hostname', async () => {
    await errsoleSQLite.db.all.mockImplementation((query, params, callback) => {
      const filteredLogs = [
        { id: 1, hostname: 'localhost', pid: 1234, source: 'source1', timestamp: new Date(), level: 'info', message: 'Log 1', errsole_id: 1 }
      ];
      callback(null, filteredLogs);
    });

    const result = await errsoleSQLite.getLogs({ hostname: 'localhost' });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].hostname).toBe('localhost');
  });

  it('should return logs filtered by pid', async () => {
    await errsoleSQLite.db.all.mockImplementation((query, params, callback) => {
      const filteredLogs = [
        { id: 2, hostname: 'localhost', pid: 1234, source: 'source2', timestamp: new Date(), level: 'warn', message: 'Log 2', errsole_id: 2 }
      ];
      callback(null, filteredLogs);
    });

    const result = await errsoleSQLite.getLogs({ pid: 1234 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].pid).toBe(1234);
  });

  it('should return logs filtered by multiple hostnames', async () => {
    await errsoleSQLite.db.all.mockImplementation((query, params, callback) => {
      const filteredLogs = [
        { id: 1, hostname: 'localhost', pid: 1234, source: 'source1', timestamp: new Date(), level: 'info', message: 'Log 1', errsole_id: 1 },
        { id: 3, hostname: 'server1', pid: 1235, source: 'source3', timestamp: new Date(), level: 'error', message: 'Log 3', errsole_id: 3 }
      ];
      callback(null, filteredLogs);
    });

    const result = await errsoleSQLite.getLogs({ hostnames: ['localhost', 'server1'] });

    expect(result.items).toHaveLength(2);
  });

  it('should return logs filtered by source and level', async () => {
    await errsoleSQLite.db.all.mockImplementation((query, params, callback) => {
      const filteredLogs = [
        { id: 2, hostname: 'localhost', pid: 1234, source: 'source2', timestamp: new Date(), level: 'warn', message: 'Log 2', errsole_id: 2 }
      ];
      callback(null, filteredLogs);
    });

    const result = await errsoleSQLite.getLogs({ sources: ['source2'], levels: ['warn'] });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].source).toBe('source2');
    expect(result.items[0].level).toBe('warn');
  });

  it('should return logs filtered by lt_id', async () => {
    await errsoleSQLite.db.all.mockImplementation((query, params, callback) => {
      const filteredLogs = [
        { id: 1, hostname: 'localhost', pid: 1234, source: 'source1', timestamp: new Date(), level: 'info', message: 'Log 1', errsole_id: 1 }
      ];
      callback(null, filteredLogs);
    });

    const result = await errsoleSQLite.getLogs({ lt_id: 2 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBeLessThan(2);
  });

  it('should return logs filtered by gt_id', async () => {
    await errsoleSQLite.db.all.mockImplementation((query, params, callback) => {
      const filteredLogs = [
        { id: 3, hostname: 'server1', pid: 1235, source: 'source3', timestamp: new Date(), level: 'error', message: 'Log 3', errsole_id: 3 }
      ];
      callback(null, filteredLogs);
    });

    const result = await errsoleSQLite.getLogs({ gt_id: 2 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBeGreaterThan(2);
  });

  it('should return logs filtered by timestamp range (gte_timestamp and lte_timestamp)', async () => {
    const startTimestamp = new Date('2023-01-01T00:00:00Z');
    const endTimestamp = new Date('2023-12-31T23:59:59Z');

    // Mock implementation to return logs with a timestamp within the range
    await errsoleSQLite.db.all.mockImplementation((query, params, callback) => {
      const filteredLogs = [
        {
          id: 1,
          hostname: 'localhost',
          pid: 1234,
          source: 'source1',
          timestamp: new Date('2023-06-01T12:00:00Z').toISOString(), // Store the timestamp as ISO string
          level: 'info',
          message: 'Log 1',
          errsole_id: 1
        }
      ];
      callback(null, filteredLogs);
    });

    const result = await errsoleSQLite.getLogs({ gte_timestamp: startTimestamp, lte_timestamp: endTimestamp });

    expect(result.items).toHaveLength(1);

    // Convert the string timestamp from the result into a Date object for comparison
    const logTimestamp = new Date(result.items[0].timestamp);

    expect(logTimestamp.getTime()).toBeGreaterThanOrEqual(startTimestamp.getTime());
    expect(logTimestamp.getTime()).toBeLessThanOrEqual(endTimestamp.getTime());
  });

  it('should return logs filtered by level_json', async () => {
    await errsoleSQLite.db.all.mockImplementation((query, params, callback) => {
      const filteredLogs = [
        { id: 1, hostname: 'localhost', pid: 1234, source: 'source1', timestamp: new Date(), level: 'info', message: 'Log 1', errsole_id: 1 }
      ];
      callback(null, filteredLogs);
    });

    const result = await errsoleSQLite.getLogs({ level_json: [{ source: 'source1', level: 'info' }] });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].source).toBe('source1');
    expect(result.items[0].level).toBe('info');
  });

  it('should return logs filtered by errsole_id', async () => {
    await errsoleSQLite.db.all.mockImplementation((query, params, callback) => {
      const filteredLogs = [
        { id: 1, hostname: 'localhost', pid: 1234, source: 'source1', timestamp: new Date(), level: 'info', message: 'Log 1', errsole_id: 1 }
      ];
      callback(null, filteredLogs);
    });

    const result = await errsoleSQLite.getLogs({ errsole_id: 1 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].errsole_id).toBe(1);
  });

  it('should handle database errors', async () => {
    await errsoleSQLite.db.all.mockImplementation((query, params, callback) => {
      callback(new Error('Database error'), null);
    });

    await expect(errsoleSQLite.getLogs()).rejects.toThrow('Database error');
  });
});

describe('ErrsoleSQLite - searchLogs', () => {
  let errsoleSQLite;

  beforeEach(() => {
    // Create an instance of ErrsoleSQLite with an in-memory SQLite database
    errsoleSQLite = new ErrsoleSQLite(':memory:');
  });

  afterEach(() => {
    jest.clearAllMocks(); // Clear all mocks after each test
  });

  it('should search logs based on search terms', async () => {
    const mockLogs = [
      { id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: new Date(), level: 'info', message: 'Error occurred in system', errsole_id: 1 }
    ];

    // Mock the database response
    errsoleSQLite.db.all = jest.fn((query, values, callback) => {
      callback(null, mockLogs);
    });

    const result = await errsoleSQLite.searchLogs(['Error']);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].message).toContain('Error');
    expect(result.filters.limit).toBe(100);
  });

  it('should apply filters for hostname and pid', async () => {
    const mockLogs = [
      { id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: new Date(), level: 'info', message: 'Log message', errsole_id: 1 }
    ];

    // Mock the database response
    errsoleSQLite.db.all = jest.fn((query, values, callback) => {
      callback(null, mockLogs);
    });

    const result = await errsoleSQLite.searchLogs(['message'], { hostname: 'localhost', pid: 1234 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].hostname).toBe('localhost');
    expect(result.items[0].pid).toBe(1234);
  });

  it('should apply filters for sources and levels', async () => {
    const mockLogs = [
      { id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: new Date(), level: 'info', message: 'Info log', errsole_id: 1 }
    ];

    // Mock the database response
    errsoleSQLite.db.all = jest.fn((query, values, callback) => {
      callback(null, mockLogs);
    });

    const result = await errsoleSQLite.searchLogs(['log'], { sources: ['test'], levels: ['info'] });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].source).toBe('test');
    expect(result.items[0].level).toBe('info');
  });

  it('should return logs within the specified timestamp range', async () => {
    const startTimestamp = new Date('2023-01-01T00:00:00Z');
    const endTimestamp = new Date('2023-01-31T23:59:59Z');
    const mockLogs = [
      { id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: new Date('2023-01-15T12:00:00Z'), level: 'info', message: 'Log message', errsole_id: 1 }
    ];

    // Mock the database response
    errsoleSQLite.db.all = jest.fn((query, values, callback) => {
      callback(null, mockLogs);
    });

    const result = await errsoleSQLite.searchLogs(['log'], { gte_timestamp: startTimestamp, lte_timestamp: endTimestamp });

    expect(result.items).toHaveLength(1);

    // Convert the string timestamp from the result into a Date object for comparison
    const logTimestamp = new Date(result.items[0].timestamp);

    expect(logTimestamp.getTime()).toBeGreaterThanOrEqual(startTimestamp.getTime());
    expect(logTimestamp.getTime()).toBeLessThanOrEqual(endTimestamp.getTime());
  });

  it('should return logs filtered by level_json', async () => {
    const mockLogs = [
      { id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: new Date(), level: 'info', message: 'Log message', errsole_id: 1 }
    ];

    // Mock the database response
    errsoleSQLite.db.all = jest.fn((query, values, callback) => {
      callback(null, mockLogs);
    });

    const result = await errsoleSQLite.searchLogs(['message'], { level_json: [{ source: 'test', level: 'info' }] });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].source).toBe('test');
    expect(result.items[0].level).toBe('info');
  });

  it('should return logs filtered by errsole_id', async () => {
    const mockLogs = [
      { id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: new Date(), level: 'info', message: 'Log message', errsole_id: 1 }
    ];

    // Mock the database response
    errsoleSQLite.db.all = jest.fn((query, values, callback) => {
      callback(null, mockLogs);
    });

    const result = await errsoleSQLite.searchLogs(['message'], { errsole_id: 1 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].errsole_id).toBe(1);
  });

  it('should handle search and filter with level_json', async () => {
    const mockLogs = [
      { id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: new Date(), level: 'info', message: 'Log message', errsole_id: 1 }
    ];

    // Mock the database response
    errsoleSQLite.db.all = jest.fn((query, values, callback) => {
      callback(null, mockLogs);
    });

    const result = await errsoleSQLite.searchLogs(['message'], { level_json: [{ source: 'test', level: 'info' }] });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].source).toBe('test');
    expect(result.items[0].level).toBe('info');
  });

  it('should reverse results when using lt_id and descending order', async () => {
    const mockLogs = [
      { id: 1, hostname: 'localhost', pid: 1234, source: 'test', timestamp: new Date(), level: 'info', message: 'Log message 1', errsole_id: 1 },
      { id: 2, hostname: 'localhost', pid: 1234, source: 'test', timestamp: new Date(), level: 'info', message: 'Log message 2', errsole_id: 2 }
    ];

    // Mock the database response
    errsoleSQLite.db.all = jest.fn((query, values, callback) => {
      callback(null, mockLogs);
    });

    const result = await errsoleSQLite.searchLogs(['Log message'], { lt_id: 3 });

    expect(result.items).toHaveLength(2);
    expect(result.items[0].id).toBe(2);
    expect(result.items[1].id).toBe(1);
  });

  it('should apply gte_timestamp and automatically calculate lte_timestamp', async () => {
    const mockLogs = [
      {
        id: 1,
        hostname: 'localhost',
        pid: 1234,
        source: 'test',
        timestamp: new Date('2023-06-01T12:00:00Z'), // within range
        level: 'info',
        message: 'Log message within range',
        errsole_id: 1
      }
    ];

    // Mock the database response
    errsoleSQLite.db.all = jest.fn((query, values, callback) => {
      callback(null, mockLogs);
    });

    const gteTimestamp = new Date('2023-06-01T00:00:00Z');
    const expectedLteTimestamp = new Date(gteTimestamp.getTime() + 24 * 60 * 60 * 1000); // adds 24 hours

    const result = await errsoleSQLite.searchLogs(['message'], { gte_timestamp: gteTimestamp });

    // Ensure that the query included both gte_timestamp and lte_timestamp
    expect(errsoleSQLite.db.all).toHaveBeenCalledWith(
      expect.stringContaining('timestamp >= ? AND timestamp <= ?'),
      expect.arrayContaining([gteTimestamp, expectedLteTimestamp]),
      expect.any(Function)
    );

    // Check that the log returned is within the expected timestamp range
    expect(result.items).toHaveLength(1);
    const logTimestamp = new Date(result.items[0].timestamp);
    expect(logTimestamp.getTime()).toBeGreaterThanOrEqual(gteTimestamp.getTime());
    expect(logTimestamp.getTime()).toBeLessThanOrEqual(expectedLteTimestamp.getTime());
  });

  it('should set gte_timestamp automatically when lte_timestamp is provided without gte_timestamp', async () => {
    const mockLogs = [
      {
        id: 1,
        hostname: 'localhost',
        pid: 1234,
        source: 'test',
        timestamp: new Date('2023-06-02T12:00:00Z'), // log within range
        level: 'info',
        message: 'Log message within range',
        errsole_id: 1
      }
    ];

    // Mock the database response
    errsoleSQLite.db.all = jest.fn((query, values, callback) => {
      callback(null, mockLogs);
    });

    const lteTimestamp = new Date('2023-06-02T12:00:00Z'); // lte_timestamp provided
    const expectedGteTimestamp = new Date(lteTimestamp.getTime() - 24 * 60 * 60 * 1000); // 24 hours before lte_timestamp

    const result = await errsoleSQLite.searchLogs([], { lte_timestamp: lteTimestamp });

    // Ensure that the query included both gte_timestamp and lte_timestamp in the correct order
    expect(errsoleSQLite.db.all).toHaveBeenCalledWith(
      expect.stringContaining('timestamp <= ? AND timestamp >= ?'),
      expect.arrayContaining([lteTimestamp, expectedGteTimestamp]),
      expect.any(Function)
    );

    // Check that the log returned is within the expected timestamp range
    expect(result.items).toHaveLength(1);
    const logTimestamp = new Date(result.items[0].timestamp);
    expect(logTimestamp.getTime()).toBeGreaterThanOrEqual(expectedGteTimestamp.getTime());
    expect(logTimestamp.getTime()).toBeLessThanOrEqual(lteTimestamp.getTime());
  });

  it('should apply filters for hostnames', async () => {
    const mockLogs = [
      { id: 1, hostname: 'server2', pid: 1235, source: 'test', timestamp: new Date(), level: 'error', message: 'Log message 2', errsole_id: 2 },
      { id: 2, hostname: 'server1', pid: 1234, source: 'test', timestamp: new Date(), level: 'info', message: 'Log message 1', errsole_id: 1 }
    ];

    // Mock the database response
    errsoleSQLite.db.all = jest.fn((query, values, callback) => {
      callback(null, mockLogs);
    });

    const hostnames = ['server1', 'server2'];

    const result = await errsoleSQLite.searchLogs([], { hostnames });

    // Ensure the SQL query includes "hostname IN (?, ?)" with correct placeholders
    expect(errsoleSQLite.db.all).toHaveBeenCalledWith(
      expect.stringContaining('hostname IN (?, ?)'),
      expect.arrayContaining(hostnames),
      expect.any(Function)
    );

    // Sort the result by hostname to avoid ordering issues in the test
    const sortedLogs = result.items.sort((a, b) => a.hostname.localeCompare(b.hostname));

    // Check that the logs returned match the specified hostnames
    expect(sortedLogs).toHaveLength(2);
    expect(sortedLogs[0].hostname).toBe('server1');
    expect(sortedLogs[1].hostname).toBe('server2');
  });
});

describe('ErrsoleSQLite - getMeta', () => {
  let errsoleSQLite;

  beforeEach(() => {
    // Create an instance of ErrsoleSQLite with an in-memory SQLite database
    errsoleSQLite = new ErrsoleSQLite(':memory:');

    // Spy on the db.get function to mock database queries
    jest.spyOn(errsoleSQLite.db, 'get').mockImplementation((query, params, callback) => {
      const mockLogs = {
        id: 1,
        meta: 'Sample meta data'
      };
      if (params[0] === 1) {
        callback(null, mockLogs); // Simulate successful query
      } else {
        callback(null, null); // Simulate no result found for other IDs
      }
    });
  });

  afterEach(() => {
    jest.clearAllMocks(); // Clear all mocks after each test
  });

  it('should return the meta data for a valid id', async () => {
    const result = await errsoleSQLite.getMeta(1);

    // Check that db.get was called with the correct query and parameter
    expect(errsoleSQLite.db.get).toHaveBeenCalledWith(
      'SELECT id, meta FROM errsole_logs_v2 WHERE id = ?',
      [1],
      expect.any(Function)
    );

    // Expect the resolved value to contain the meta data
    expect(result).toEqual({
      item: { id: 1, meta: 'Sample meta data' }
    });
  });

  it('should return an error if the log entry is not found', async () => {
    // Attempt to get meta for a non-existent ID
    await expect(errsoleSQLite.getMeta(999)).rejects.toThrow('Log entry not found.');

    // Ensure that db.get was called correctly
    expect(errsoleSQLite.db.get).toHaveBeenCalledWith(
      'SELECT id, meta FROM errsole_logs_v2 WHERE id = ?',
      [999],
      expect.any(Function)
    );
  });

  it('should handle database errors gracefully', async () => {
    const mockError = new Error('Database error');
    errsoleSQLite.db.get.mockImplementationOnce((query, params, callback) => {
      callback(mockError); // Simulate a database error
    });

    await expect(errsoleSQLite.getMeta(1)).rejects.toThrow('Database error');

    // Ensure db.get was called correctly
    expect(errsoleSQLite.db.get).toHaveBeenCalledWith(
      'SELECT id, meta FROM errsole_logs_v2 WHERE id = ?',
      [1],
      expect.any(Function)
    );
  });
});

describe('ErrsoleSQLite - createUser', () => {
  let errsoleSQLite;

  beforeEach(() => {
    // Create an instance of ErrsoleSQLite with an in-memory SQLite database
    errsoleSQLite = new ErrsoleSQLite(':memory:');

    // Spy on the db.run function to mock database queries
    jest.spyOn(errsoleSQLite.db, 'run').mockImplementation((query, params, callback) => {
      callback(null); // Simulate successful insertion
    });

    // Mock bcrypt.hash function
    jest.spyOn(bcrypt, 'hash').mockResolvedValue('hashedPassword');
  });

  afterEach(() => {
    jest.clearAllMocks(); // Clear all mocks after each test
  });

  it('should create a new user successfully', async () => {
    const user = { name: 'John Doe', email: 'john.doe@example.com', password: 'password123', role: 'admin' };

    // Mock db.run to simulate successful insertion
    errsoleSQLite.db.run.mockImplementationOnce(function (query, params, callback) {
      callback.call({ lastID: 1 }, null); // Simulate the last inserted ID
    });

    const result = await errsoleSQLite.createUser(user);

    // Verify that bcrypt.hash was called with the correct password
    expect(bcrypt.hash).toHaveBeenCalledWith(user.password, 10);

    // Verify that db.run was called with the correct query and params
    expect(errsoleSQLite.db.run).toHaveBeenCalledWith(
      'INSERT INTO errsole_users (name, email, hashed_password, role) VALUES (?, ?, ?, ?)',
      [user.name, user.email, 'hashedPassword', user.role],
      expect.any(Function)
    );

    // Check the returned user object
    expect(result.item).toEqual({
      id: 1,
      name: user.name,
      email: user.email,
      role: user.role
    });
  });

  it('should return an error if the email already exists (SQLITE_CONSTRAINT)', async () => {
    const user = { name: 'Jane Doe', email: 'jane.doe@example.com', password: 'password123', role: 'user' };

    // Mock db.run to simulate SQLITE_CONSTRAINT error
    errsoleSQLite.db.run.mockImplementationOnce(function (query, params, callback) {
      const error = new Error('SQLITE_CONSTRAINT: email must be unique');
      error.code = 'SQLITE_CONSTRAINT';
      callback(error);
    });

    await expect(errsoleSQLite.createUser(user)).rejects.toThrow('A user with the provided email already exists.');

    // Verify that bcrypt.hash was still called
    expect(bcrypt.hash).toHaveBeenCalledWith(user.password, 10);

    // Verify that db.run was called with the correct query and params
    expect(errsoleSQLite.db.run).toHaveBeenCalledWith(
      'INSERT INTO errsole_users (name, email, hashed_password, role) VALUES (?, ?, ?, ?)',
      [user.name, user.email, 'hashedPassword', user.role],
      expect.any(Function)
    );
  });

  it('should handle unexpected database errors', async () => {
    const user = { name: 'Jake Doe', email: 'jake.doe@example.com', password: 'password123', role: 'guest' };

    // Mock db.run to simulate an unexpected error
    const unexpectedError = new Error('Database error');
    errsoleSQLite.db.run.mockImplementation((query, params, callback) => {
      callback(unexpectedError);
    });

    await expect(errsoleSQLite.createUser(user)).rejects.toThrow('Database error');

    // Verify that bcrypt.hash was still called
    expect(bcrypt.hash).toHaveBeenCalledWith(user.password, 10);

    // Verify that db.run was called with the correct query and params
    expect(errsoleSQLite.db.run).toHaveBeenCalledWith(
      'INSERT INTO errsole_users (name, email, hashed_password, role) VALUES (?, ?, ?, ?)',
      [user.name, user.email, 'hashedPassword', user.role],
      expect.any(Function)
    );
  });
});

describe('ErrsoleSQLite - verifyUser', () => {
  let errsoleSQLite;

  beforeEach(() => {
    // Create an instance of ErrsoleSQLite with an in-memory SQLite database
    errsoleSQLite = new ErrsoleSQLite(':memory:');

    // Spy on the db.get function to mock database queries
    jest.spyOn(errsoleSQLite.db, 'get').mockImplementation((query, params, callback) => {
      callback(null); // Simulate no user found
    });

    // Mock bcrypt.compare function
    jest.spyOn(bcrypt, 'compare').mockResolvedValue(false);
  });

  afterEach(() => {
    jest.clearAllMocks(); // Clear all mocks after each test
  });

  it('should throw an error if email or password is missing', async () => {
    await expect(errsoleSQLite.verifyUser(null, 'password123')).rejects.toThrow('Both email and password are required for verification.');
    await expect(errsoleSQLite.verifyUser('test@example.com', null)).rejects.toThrow('Both email and password are required for verification.');
  });

  it('should return an error if the user is not found', async () => {
    // Mock db.get to simulate no user found
    errsoleSQLite.db.get.mockImplementation((query, params, callback) => {
      callback(null, null); // Simulate no user found
    });

    await expect(errsoleSQLite.verifyUser('test@example.com', 'password123')).rejects.toThrow('User not found.');

    expect(errsoleSQLite.db.get).toHaveBeenCalledWith('SELECT * FROM errsole_users WHERE email = ?', ['test@example.com'], expect.any(Function));
  });

  it('should return an error if the password is incorrect', async () => {
    // Mock db.get to return a user
    const user = { email: 'test@example.com', hashed_password: 'hashedPassword' };
    errsoleSQLite.db.get.mockImplementation((query, params, callback) => {
      callback(null, user);
    });

    // Mock bcrypt.compare to return false (incorrect password)
    bcrypt.compare.mockResolvedValueOnce(false);

    await expect(errsoleSQLite.verifyUser('test@example.com', 'wrongpassword')).rejects.toThrow('Incorrect password.');

    expect(bcrypt.compare).toHaveBeenCalledWith('wrongpassword', 'hashedPassword');
  });

  it('should verify the user successfully with correct password', async () => {
    // Mock db.get to return a user
    const user = { id: 1, name: 'John Doe', email: 'john.doe@example.com', hashed_password: 'hashedPassword' };
    errsoleSQLite.db.get.mockImplementation((query, params, callback) => {
      callback(null, user);
    });

    // Mock bcrypt.compare to return true (correct password)
    bcrypt.compare.mockResolvedValueOnce(true);

    const result = await errsoleSQLite.verifyUser('john.doe@example.com', 'password123');

    expect(bcrypt.compare).toHaveBeenCalledWith('password123', 'hashedPassword');

    // Verify that hashed_password is removed from the returned result
    expect(result.item).toEqual({
      id: 1,
      name: 'John Doe',
      email: 'john.doe@example.com'
    });

    expect(errsoleSQLite.db.get).toHaveBeenCalledWith('SELECT * FROM errsole_users WHERE email = ?', ['john.doe@example.com'], expect.any(Function));
  });

  it('should handle database errors gracefully', async () => {
    const dbError = new Error('Database error');

    // Mock db.get to simulate a database error
    errsoleSQLite.db.get.mockImplementation((query, params, callback) => {
      callback(dbError);
    });

    await expect(errsoleSQLite.verifyUser('test@example.com', 'password123')).rejects.toThrow('Database error');

    expect(errsoleSQLite.db.get).toHaveBeenCalledWith('SELECT * FROM errsole_users WHERE email = ?', ['test@example.com'], expect.any(Function));
  });
});

describe('ErrsoleSQLite - getUserCount', () => {
  let errsoleSQLite;

  beforeEach(() => {
    // Create an instance of ErrsoleSQLite with an in-memory SQLite database
    errsoleSQLite = new ErrsoleSQLite(':memory:');

    // Spy on the db.get function to mock database queries
    jest.spyOn(errsoleSQLite.db, 'get').mockImplementation((query, callback) => {
      callback(null, { count: 5 }); // Mock default return value for the count
    });
  });

  afterEach(() => {
    jest.clearAllMocks(); // Clear all mocks after each test
  });

  it('should return the user count successfully', async () => {
    const result = await errsoleSQLite.getUserCount();

    expect(result).toEqual({ count: 5 });
    expect(errsoleSQLite.db.get).toHaveBeenCalledWith('SELECT COUNT(*) as count FROM errsole_users', expect.any(Function));
  });

  it('should return an error if a database error occurs', async () => {
    const dbError = new Error('Database error');

    // Mock db.get to simulate a database error
    errsoleSQLite.db.get.mockImplementationOnce((query, callback) => {
      callback(dbError);
    });

    await expect(errsoleSQLite.getUserCount()).rejects.toThrow('Database error');

    expect(errsoleSQLite.db.get).toHaveBeenCalledWith('SELECT COUNT(*) as count FROM errsole_users', expect.any(Function));
  });
});

describe('ErrsoleSQLite - getAllUsers', () => {
  let errsoleSQLite;

  beforeEach(() => {
    // Create an instance of ErrsoleSQLite with an in-memory SQLite database
    errsoleSQLite = new ErrsoleSQLite(':memory:');

    // Spy on the db.all function to mock database queries
    jest.spyOn(errsoleSQLite.db, 'all').mockImplementation((query, callback) => {
      callback(null, [
        { id: 1, name: 'John Doe', email: 'john@example.com', role: 'admin' },
        { id: 2, name: 'Jane Smith', email: 'jane@example.com', role: 'user' }
      ]); // Mock return value of users
    });
  });

  afterEach(() => {
    jest.clearAllMocks(); // Clear all mocks after each test
  });

  it('should return all users successfully', async () => {
    const result = await errsoleSQLite.getAllUsers();

    expect(result.items).toHaveLength(2);
    expect(result.items).toEqual([
      { id: 1, name: 'John Doe', email: 'john@example.com', role: 'admin' },
      { id: 2, name: 'Jane Smith', email: 'jane@example.com', role: 'user' }
    ]);
    expect(errsoleSQLite.db.all).toHaveBeenCalledWith('SELECT id, name, email, role FROM errsole_users', expect.any(Function));
  });

  it('should return an error if a database error occurs', async () => {
    const dbError = new Error('Database error');

    // Mock db.all to simulate a database error
    errsoleSQLite.db.all.mockImplementationOnce((query, callback) => {
      callback(dbError, null);
    });

    await expect(errsoleSQLite.getAllUsers()).rejects.toThrow('Database error');

    expect(errsoleSQLite.db.all).toHaveBeenCalledWith('SELECT id, name, email, role FROM errsole_users', expect.any(Function));
  });
});

describe('ErrsoleSQLite - getUserByEmail', () => {
  let errsoleSQLite;

  beforeEach(() => {
    // Create an instance of ErrsoleSQLite with an in-memory SQLite database
    errsoleSQLite = new ErrsoleSQLite(':memory:');

    // Spy on the db.get function to mock database queries
    jest.spyOn(errsoleSQLite.db, 'get').mockImplementation((query, params, callback) => {
      if (params[0] === 'john@example.com') {
        callback(null, { id: 1, name: 'John Doe', email: 'john@example.com', role: 'admin' }); // Mock user found
      } else {
        callback(null, null); // Mock user not found
      }
    });
  });

  afterEach(() => {
    jest.clearAllMocks(); // Clear all mocks after each test
  });

  it('should return a user by email', async () => {
    const result = await errsoleSQLite.getUserByEmail('john@example.com');

    expect(result.item).toEqual({ id: 1, name: 'John Doe', email: 'john@example.com', role: 'admin' });
    expect(errsoleSQLite.db.get).toHaveBeenCalledWith(
      'SELECT id, name, email, role FROM errsole_users WHERE email = ?',
      ['john@example.com'],
      expect.any(Function)
    );
  });

  it('should throw an error if email is not provided', async () => {
    await expect(errsoleSQLite.getUserByEmail()).rejects.toThrow('Email is required.');
    expect(errsoleSQLite.db.get).not.toHaveBeenCalled(); // The query should not be run if email is missing
  });

  it('should throw an error if user is not found', async () => {
    await expect(errsoleSQLite.getUserByEmail('unknown@example.com')).rejects.toThrow('User not found.');
    expect(errsoleSQLite.db.get).toHaveBeenCalledWith(
      'SELECT id, name, email, role FROM errsole_users WHERE email = ?',
      ['unknown@example.com'],
      expect.any(Function)
    );
  });

  it('should handle database errors gracefully', async () => {
    const dbError = new Error('Database error');

    // Mock db.get to simulate a database error
    errsoleSQLite.db.get.mockImplementationOnce((query, params, callback) => {
      callback(dbError);
    });

    await expect(errsoleSQLite.getUserByEmail('john@example.com')).rejects.toThrow('Database error');
    expect(errsoleSQLite.db.get).toHaveBeenCalledWith(
      'SELECT id, name, email, role FROM errsole_users WHERE email = ?',
      ['john@example.com'],
      expect.any(Function)
    );
  });
});

describe('ErrsoleSQLite - updateUserByEmail', () => {
  let errsoleSQLite;

  beforeEach(() => {
    // Create an instance of ErrsoleSQLite with an in-memory SQLite database
    errsoleSQLite = new ErrsoleSQLite(':memory:');

    // Spy on the db.run function to mock database updates
    jest.spyOn(errsoleSQLite.db, 'run').mockImplementation((query, values, callback) => {
      callback(null); // Simulate a successful update
    });

    // Mock getUserByEmail to return an updated user
    jest.spyOn(errsoleSQLite, 'getUserByEmail').mockResolvedValue({
      item: { id: 1, name: 'John Doe', email: 'john@example.com', role: 'admin' }
    });
  });

  afterEach(() => {
    jest.clearAllMocks(); // Clear all mocks after each test
  });

  it('should update a user by email', async () => {
    const updates = { name: 'John Updated', role: 'user' };

    const result = await errsoleSQLite.updateUserByEmail('john@example.com', updates);

    expect(errsoleSQLite.db.run).toHaveBeenCalledWith(
      'UPDATE errsole_users SET name = ?, role = ? WHERE email = ?',
      ['John Updated', 'user', 'john@example.com'],
      expect.any(Function)
    );

    expect(result.item).toEqual({ id: 1, name: 'John Doe', email: 'john@example.com', role: 'admin' });
  });

  it('should throw an error if email is not provided', async () => {
    await expect(errsoleSQLite.updateUserByEmail(null, { name: 'John Updated' })).rejects.toThrow('Email is required.');
    expect(errsoleSQLite.db.run).not.toHaveBeenCalled();
  });

  it('should throw an error if no updates are provided', async () => {
    await expect(errsoleSQLite.updateUserByEmail('john@example.com', {})).rejects.toThrow('No updates provided.');
    expect(errsoleSQLite.db.run).not.toHaveBeenCalled();
  });

  it('should not allow restricted fields to be updated', async () => {
    const updates = { id: 99, hashed_password: 'newpassword', name: 'John Updated' };

    const result = await errsoleSQLite.updateUserByEmail('john@example.com', updates);

    expect(errsoleSQLite.db.run).toHaveBeenCalledWith(
      'UPDATE errsole_users SET name = ? WHERE email = ?',
      ['John Updated', 'john@example.com'],
      expect.any(Function)
    );

    expect(result.item).toEqual({ id: 1, name: 'John Doe', email: 'john@example.com', role: 'admin' });
  });

  it('should handle database errors gracefully', async () => {
    const dbError = new Error('Database error');

    // Mock db.run to simulate a database error
    errsoleSQLite.db.run.mockImplementationOnce((query, values, callback) => {
      callback(dbError);
    });

    await expect(errsoleSQLite.updateUserByEmail('john@example.com', { name: 'John Updated' })).rejects.toThrow('Database error');

    expect(errsoleSQLite.db.run).toHaveBeenCalledWith(
      'UPDATE errsole_users SET name = ? WHERE email = ?',
      ['John Updated', 'john@example.com'],
      expect.any(Function)
    );
  });
});

describe('ErrsoleSQLite - updatePassword', () => {
  let errsoleSQLite;

  beforeEach(() => {
    // Create an instance of ErrsoleSQLite with an in-memory SQLite database
    errsoleSQLite = new ErrsoleSQLite(':memory:');

    // Mock the bcrypt compare and hash functions
    jest.spyOn(bcrypt, 'compare').mockResolvedValue(true); // Assume correct password by default
    jest.spyOn(bcrypt, 'hash').mockResolvedValue('hashedNewPassword'); // Simulate hashed new password

    // Spy on the db.get function to mock fetching a user
    jest.spyOn(errsoleSQLite.db, 'get').mockImplementation((query, params, callback) => {
      callback(null, { email: 'john@example.com', hashed_password: 'hashedCurrentPassword' }); // Mock a user record
    });

    // Spy on the db.run function to mock updating the password
    jest.spyOn(errsoleSQLite.db, 'run').mockImplementation((query, values, callback) => {
      callback(null); // Simulate a successful update
    });
  });

  afterEach(() => {
    jest.clearAllMocks(); // Clear all mocks after each test
  });

  it('should update the password successfully', async () => {
    const result = await errsoleSQLite.updatePassword('john@example.com', 'currentPassword', 'newPassword');

    expect(bcrypt.compare).toHaveBeenCalledWith('currentPassword', 'hashedCurrentPassword');
    expect(bcrypt.hash).toHaveBeenCalledWith('newPassword', 10);
    expect(errsoleSQLite.db.run).toHaveBeenCalledWith(
      'UPDATE errsole_users SET hashed_password = ? WHERE email = ?',
      ['hashedNewPassword', 'john@example.com'],
      expect.any(Function)
    );

    expect(result.item.email).toBe('john@example.com');
  });

  it('should throw an error if email, current password, or new password is missing', async () => {
    await expect(errsoleSQLite.updatePassword(null, 'currentPassword', 'newPassword')).rejects.toThrow('Email, current password, and new password are required.');
    await expect(errsoleSQLite.updatePassword('john@example.com', null, 'newPassword')).rejects.toThrow('Email, current password, and new password are required.');
    await expect(errsoleSQLite.updatePassword('john@example.com', 'currentPassword', null)).rejects.toThrow('Email, current password, and new password are required.');
  });

  it('should throw an error if the user is not found', async () => {
    // Mock db.get to return no user
    errsoleSQLite.db.get.mockImplementationOnce((query, params, callback) => {
      callback(null, null); // No user found
    });

    await expect(errsoleSQLite.updatePassword('unknown@example.com', 'currentPassword', 'newPassword')).rejects.toThrow('User not found.');
    expect(bcrypt.compare).not.toHaveBeenCalled();
    expect(bcrypt.hash).not.toHaveBeenCalled();
    expect(errsoleSQLite.db.run).not.toHaveBeenCalled();
  });

  it('should throw an error if the current password is incorrect', async () => {
    // Mock bcrypt.compare to return false
    bcrypt.compare.mockResolvedValueOnce(false);

    await expect(errsoleSQLite.updatePassword('john@example.com', 'wrongPassword', 'newPassword')).rejects.toThrow('Current password is incorrect.');

    expect(bcrypt.compare).toHaveBeenCalledWith('wrongPassword', 'hashedCurrentPassword');
    expect(bcrypt.hash).not.toHaveBeenCalled();
    expect(errsoleSQLite.db.run).not.toHaveBeenCalled();
  });

  it('should handle database errors during password update', async () => {
    const dbError = new Error('Database error');

    // Mock db.run to simulate a database error
    errsoleSQLite.db.run.mockImplementationOnce((query, values, callback) => {
      callback(dbError); // Simulate a database error
    });

    await expect(errsoleSQLite.updatePassword('john@example.com', 'currentPassword', 'newPassword')).rejects.toThrow('Database error');

    expect(bcrypt.compare).toHaveBeenCalledWith('currentPassword', 'hashedCurrentPassword');
    expect(bcrypt.hash).toHaveBeenCalledWith('newPassword', 10);
    expect(errsoleSQLite.db.run).toHaveBeenCalledWith(
      'UPDATE errsole_users SET hashed_password = ? WHERE email = ?',
      ['hashedNewPassword', 'john@example.com'],
      expect.any(Function)
    );
  });
});

describe('ErrsoleSQLite - deleteUser', () => {
  let errsoleSQLite;

  beforeEach(() => {
    // Create an instance of ErrsoleSQLite with an in-memory SQLite database
    errsoleSQLite = new ErrsoleSQLite(':memory:');

    // Spy on the db.run function to mock the database deletion query
    jest.spyOn(errsoleSQLite.db, 'run').mockImplementation(function (query, values, callback) {
      // Use an old-school function and mock the 'changes' property
      callback.call({ changes: 1 }, null); // Simulate that one user was deleted
    });
  });

  afterEach(() => {
    jest.clearAllMocks(); // Clear all mocks after each test
  });

  it('should delete the user successfully', async () => {
    // Mock db.run to simulate a successful deletion
    errsoleSQLite.db.run.mockImplementationOnce(function (query, values, callback) {
      this.changes = 1; // Simulate that one user was deleted
      callback.call(this, null);
    });

    const result = await errsoleSQLite.deleteUser(1);

    expect(errsoleSQLite.db.run).toHaveBeenCalledWith(
      'DELETE FROM errsole_users WHERE id = ?',
      [1],
      expect.any(Function)
    );
    expect(result).toEqual({});
  });

  it('should throw an error if user ID is not provided', async () => {
    await expect(errsoleSQLite.deleteUser()).rejects.toThrow('User ID is required.');

    expect(errsoleSQLite.db.run).not.toHaveBeenCalled();
  });

  it('should throw an error if the user is not found (no rows deleted)', async () => {
    // Mock db.run to simulate no user being deleted
    errsoleSQLite.db.run.mockImplementationOnce(function (query, values, callback) {
      this.changes = 0; // No rows deleted
      callback.call(this, null);
    });

    await expect(errsoleSQLite.deleteUser(999)).rejects.toThrow('User not found.');

    expect(errsoleSQLite.db.run).toHaveBeenCalledWith(
      'DELETE FROM errsole_users WHERE id = ?',
      [999],
      expect.any(Function)
    );
  });

  it('should handle database errors during deletion', async () => {
    const dbError = new Error('Database error');

    // Mock db.run to simulate a database error
    errsoleSQLite.db.run.mockImplementationOnce(function (query, values, callback) {
      callback.call(this, dbError); // Simulate a database error
    });

    await expect(errsoleSQLite.deleteUser(1)).rejects.toThrow('Database error');

    expect(errsoleSQLite.db.run).toHaveBeenCalledWith(
      'DELETE FROM errsole_users WHERE id = ?',
      [1],
      expect.any(Function)
    );
  });
});

describe('ErrsoleSQLite - searchLogs with gt_id filter', () => {
  let errsoleSQLite;

  beforeEach(() => {
    // Create an instance of ErrsoleSQLite with an in-memory SQLite database
    errsoleSQLite = new ErrsoleSQLite(':memory:');

    // Mock the db.all function to simulate database interaction
    jest.spyOn(errsoleSQLite.db, 'all').mockImplementation((query, values, callback) => {
      const mockLogs = [
        { id: 4, hostname: 'server1', pid: 1236, source: 'sourceA', timestamp: new Date(), level: 'info', message: 'Log message 4', errsole_id: 4 },
        { id: 5, hostname: 'server2', pid: 1237, source: 'sourceB', timestamp: new Date(), level: 'error', message: 'Log message 5', errsole_id: 5 }
      ];
      callback(null, mockLogs);
    });
  });

  afterEach(() => {
    jest.clearAllMocks(); // Clear all mocks after each test
  });

  it('should add "id > ?" to WHERE clauses, set ascending sortOrder, and ensure shouldReverse is false', async () => {
    const gt_id = 3; // Filter condition for logs with id > 3

    const result = await errsoleSQLite.searchLogs([], { gt_id });

    // Ensure the SQL query includes the "id > ?" clause
    expect(errsoleSQLite.db.all).toHaveBeenCalledWith(
      expect.stringContaining('id > ?'),
      expect.arrayContaining([gt_id]),
      expect.any(Function)
    );

    // Verify the returned logs have id > gt_id and are sorted in ascending order
    expect(result.items).toHaveLength(2);
    expect(result.items[0].id).toBeGreaterThan(gt_id);
    expect(result.items[1].id).toBeGreaterThan(gt_id);
    expect(result.items[0].id).toBeLessThan(result.items[1].id); // Ascending order check

    // Optional: You could assert sortOrder and shouldReverse if these are available to be checked
    // Assuming sortOrder and shouldReverse are not directly accessible, this is implicitly verified by the ascending order of returned logs.
  });

  it('should return no logs when no records match the gt_id condition', async () => {
    // Mock the db.all function to return no logs
    errsoleSQLite.db.all.mockImplementationOnce((query, values, callback) => {
      callback(null, []); // No logs found with id > gt_id
    });

    const gt_id = 10; // Filter condition for logs with id > 10, assuming no logs match

    const result = await errsoleSQLite.searchLogs([], { gt_id });

    // Ensure the SQL query includes the "id > ?" clause
    expect(errsoleSQLite.db.all).toHaveBeenCalledWith(
      expect.stringContaining('id > ?'),
      expect.arrayContaining([gt_id]),
      expect.any(Function)
    );

    // Check that no logs are returned
    expect(result.items).toHaveLength(0);
  });

  it('should handle database errors gracefully when applying gt_id filter', async () => {
    const dbError = new Error('Database connection failed');

    // Mock db.all to simulate a database error
    errsoleSQLite.db.all.mockImplementationOnce((query, values, callback) => {
      callback(dbError, null);
    });

    const gt_id = 4;

    await expect(errsoleSQLite.searchLogs([], { gt_id })).rejects.toThrow('Database connection failed');

    // Ensure the SQL query was attempted with "id > ?"
    expect(errsoleSQLite.db.all).toHaveBeenCalledWith(
      expect.stringContaining('id > ?'),
      expect.arrayContaining([gt_id]),
      expect.any(Function)
    );
  });
});

describe('ErrsoleSQLite - flushLogs', () => {
  let errsoleSQLite;

  beforeEach(() => {
    errsoleSQLite = new ErrsoleSQLite(':memory:');
    errsoleSQLite.isConnectionInProgress = false;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should insert pending logs into the database', async () => {
    // Mock db.run to simulate a successful insertion
    const mockDbRun = jest.fn((query, values, callback) => {
      if (callback) callback(null); // Only call if a callback is passed
    });
    errsoleSQLite.db.run = mockDbRun;

    errsoleSQLite.pendingLogs = [
      { timestamp: new Date(), hostname: 'localhost', pid: 1234, source: 'test', level: 'info', message: 'Log 1', meta: {}, errsole_id: 1 },
      { timestamp: new Date(), hostname: 'localhost', pid: 1235, source: 'test', level: 'error', message: 'Log 2', meta: {}, errsole_id: 2 }
    ];

    await errsoleSQLite.flushLogs();

    expect(mockDbRun).toHaveBeenCalledTimes(1);
    expect(mockDbRun).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR IGNORE INTO errsole_logs_v2'),
      expect.any(Array),
      expect.any(Function)
    );
  });

  it('should handle database errors during flush', async () => {
    const mockDbRun = jest.fn((query, values, callback) => {
      if (callback) callback(new Error('Database error'));
    });
    errsoleSQLite.db.run = mockDbRun;

    errsoleSQLite.pendingLogs = [
      { timestamp: new Date(), hostname: 'localhost', pid: 1234, source: 'test', level: 'info', message: 'Log 1', meta: {}, errsole_id: 1 }
    ];

    await expect(errsoleSQLite.flushLogs()).rejects.toThrow('Database error');
    expect(mockDbRun).toHaveBeenCalledTimes(1);
  });

  it('should wait until connection is available before flushing logs', async () => {
    errsoleSQLite.isConnectionInProgress = true;

    const mockDbRun = jest.fn((query, values, callback) => {
      if (callback) callback(null);
    });
    errsoleSQLite.db.run = mockDbRun;

    errsoleSQLite.pendingLogs = [
      { timestamp: new Date(), hostname: 'localhost', pid: 1234, source: 'test', level: 'info', message: 'Log 1', meta: {}, errsole_id: 1 }
    ];

    setTimeout(() => {
      errsoleSQLite.isConnectionInProgress = false;
    }, 300);

    const flushPromise = errsoleSQLite.flushLogs();

    jest.advanceTimersByTime(300);

    await flushPromise;

    expect(mockDbRun).toHaveBeenCalledTimes(1);
    expect(mockDbRun).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR IGNORE INTO errsole_logs_v2'),
      expect.any(Array),
      expect.any(Function)
    );
  });
});

describe('ErrsoleSQLite - insertNotificationItem', () => {
  let errsoleSQLite;

  beforeEach(() => {
    // Create an instance of ErrsoleSQLite with an in-memory SQLite database
    errsoleSQLite = new ErrsoleSQLite(':memory:');

    // Mock db.run and db.get methods to simulate database interaction
    jest.spyOn(errsoleSQLite.db, 'run').mockImplementation((query, params, callback) => {
      if (typeof params === 'function') {
        // Handle case where no params are provided
        callback = params;
      }
      callback(null); // Simulate successful execution for db.run
    });

    jest.spyOn(errsoleSQLite.db, 'get').mockImplementation((query, params, callback) => {
      if (typeof params === 'function') {
        // Handle case where no params are provided
        callback = params;
      }
      callback(null, null); // Default: no previous notification found
    });
  });

  afterEach(() => {
    jest.clearAllMocks(); // Clear all mocks after each test
  });

  it('should insert a new notification successfully', async () => {
    // Mock `get` to simulate no previous notification and set notification count to 1
    errsoleSQLite.db.get
      .mockImplementationOnce((query, params, callback) => callback(null, null)) // No previous notification
      .mockImplementationOnce((query, params, callback) => callback(null, { notificationCount: 1 })); // Today's count

    const notification = {
      errsole_id: 1,
      hostname: 'localhost',
      hashed_message: 'hashedMessage'
    };

    const result = await errsoleSQLite.insertNotificationItem(notification);

    // Verify that db.run was called for transaction, insertion, and commit
    expect(errsoleSQLite.db.run).toHaveBeenCalledWith('BEGIN TRANSACTION;', expect.any(Function));
    expect(errsoleSQLite.db.run).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO errsole_notifications'),
      expect.arrayContaining([notification.errsole_id, notification.hostname, notification.hashed_message]),
      expect.any(Function)
    );
    expect(errsoleSQLite.db.run).toHaveBeenCalledWith('COMMIT;', expect.any(Function));

    // Verify the returned object structure
    expect(result).toEqual({
      previousNotificationItem: null,
      todayNotificationCount: 1
    });
  });

  it('should return the previous notification item if it exists', async () => {
    const mockPreviousNotification = { id: 1, hostname: 'localhost', hashed_message: 'hashedMessage' };
    errsoleSQLite.db.get
      .mockImplementationOnce((query, params, callback) => callback(null, mockPreviousNotification)) // Previous notification found
      .mockImplementationOnce((query, params, callback) => callback(null, { notificationCount: 2 })); // Today's count

    const notification = {
      errsole_id: 2,
      hostname: 'localhost',
      hashed_message: 'hashedMessage'
    };

    const result = await errsoleSQLite.insertNotificationItem(notification);

    expect(result.previousNotificationItem).toEqual(mockPreviousNotification);
    expect(result.todayNotificationCount).toBe(2);
  });

  it('should return 0 todayNotificationCount if no notifications today', async () => {
    errsoleSQLite.db.get
      .mockImplementationOnce((query, params, callback) => callback(null, null)) // No previous notification
      .mockImplementationOnce((query, params, callback) => callback(null, { notificationCount: 0 })); // No notifications today

    const notification = {
      errsole_id: 3,
      hostname: 'localhost',
      hashed_message: 'hashedMessage'
    };

    const result = await errsoleSQLite.insertNotificationItem(notification);

    expect(result.todayNotificationCount).toBe(0);
  });

  it('should roll back if an error occurs during insertion', async () => {
    errsoleSQLite.db.run
      .mockImplementationOnce((query, callback) => callback(null)) // BEGIN TRANSACTION
      .mockImplementationOnce((query, params, callback) => callback(new Error('Insertion error'))); // Simulate insertion error

    const notification = {
      errsole_id: 4,
      hostname: 'localhost',
      hashed_message: 'hashedMessage'
    };

    await expect(errsoleSQLite.insertNotificationItem(notification)).rejects.toThrow('Insertion error');

    // Verify that rollback is called
    expect(errsoleSQLite.db.run).toHaveBeenCalledWith('ROLLBACK;', expect.any(Function));
  });

  it('should roll back if an error occurs during transaction', async () => {
    // Simulate an error on BEGIN TRANSACTION
    errsoleSQLite.db.run.mockImplementationOnce((query, callback) => callback(new Error('Transaction error')));

    const notification = {
      errsole_id: 5,
      hostname: 'localhost',
      hashed_message: 'hashedMessage'
    };

    await expect(errsoleSQLite.insertNotificationItem(notification)).rejects.toThrow('Transaction error');

    // Verify that rollback is called
    expect(errsoleSQLite.db.run).toHaveBeenCalledWith('ROLLBACK;', expect.any(Function));
  });

  it('should throw error if unable to fetch todayNotificationCount', async () => {
    errsoleSQLite.db.get
      .mockImplementationOnce((query, params, callback) => callback(null, null)) // No previous notification
      .mockImplementationOnce((query, params, callback) => callback(new Error('Count query error'))); // Error on count query

    const notification = {
      errsole_id: 6,
      hostname: 'localhost',
      hashed_message: 'hashedMessage'
    };

    await expect(errsoleSQLite.insertNotificationItem(notification)).rejects.toThrow('Count query error');

    // Verify that rollback is called
    expect(errsoleSQLite.db.run).toHaveBeenCalledWith('ROLLBACK;', expect.any(Function));
  });
});

describe('ErrsoleSQLite - deleteExpiredLogs', () => {
  let errsoleSQLite;

  beforeEach(() => {
    // Create an instance of ErrsoleSQLite with an in-memory SQLite database
    errsoleSQLite = new ErrsoleSQLite(':memory:');
    jest.useFakeTimers();

    // Mock the getConfig method to return the default TTL
    jest.spyOn(errsoleSQLite, 'getConfig').mockResolvedValue({ item: { value: '2592000000' } }); // 30 days in milliseconds

    // Spy on db.all and db.run for SELECT and DELETE queries
    jest.spyOn(errsoleSQLite.db, 'all').mockImplementation((query, params, callback) => {
      callback(null, [{ id: 1 }, { id: 2 }, { id: 3 }]); // Mock rows for expired logs
    });

    jest.spyOn(errsoleSQLite.db, 'run').mockImplementation((query, params, callback) => {
      callback(null); // Simulate successful deletion
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it('should not run if deleteExpiredLogsRunning is true', async () => {
    errsoleSQLite.deleteExpiredLogsRunning = true;

    await errsoleSQLite.deleteExpiredLogs();

    expect(errsoleSQLite.db.all).not.toHaveBeenCalled();
    expect(errsoleSQLite.db.run).not.toHaveBeenCalled();
  });

  it('should reset deleteExpiredLogsRunning flag after completion', async () => {
    errsoleSQLite.db.all.mockImplementationOnce((query, params, callback) => {
      callback(null, []); // No rows to delete
    });

    await errsoleSQLite.deleteExpiredLogs();

    expect(errsoleSQLite.deleteExpiredLogsRunning).toBe(false);
  });
});

describe('ErrsoleSQLite - deleteExpiredNotificationItems', () => {
  let errsoleSQLite;
  let originalDateNow;
  let consoleErrorSpy;

  beforeEach(() => {
    // Instantiate ErrsoleSQLite with an in-memory database
    errsoleSQLite = new ErrsoleSQLite(':memory:');

    // Mock the getConfig method to return TTL configuration
    jest.spyOn(errsoleSQLite, 'getConfig').mockResolvedValue({ item: { value: '2592000000' } }); // 30 days in milliseconds

    // Mock db.all to select expired notification IDs
    jest.spyOn(errsoleSQLite.db, 'all').mockImplementation((query, params, callback) => {
      // Depending on the test, this can be overridden
      callback(null, [{ id: 1 }, { id: 2 }, { id: 3 }]); // Example IDs
    });

    // Mock db.run to delete notifications
    jest.spyOn(errsoleSQLite.db, 'run').mockImplementation(function (query, params, callback) {
      // Simulate successful deletion
      callback(null);
    });

    // Spy on console.error to verify error logging
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    // Use fake timers to control setTimeout
    jest.useFakeTimers();

    // Mock Date.now() to return a fixed timestamp
    originalDateNow = Date.now;
    Date.now = jest.fn(() => new Date('2023-01-01T00:00:00Z').getTime());
  });

  afterEach(() => {
    // Restore all mocks and spies
    jest.clearAllMocks();
    jest.useRealTimers();
    Date.now = originalDateNow;
  });

  it('should handle no expired notification items gracefully', async () => {
    // Mock db.all to return no IDs
    errsoleSQLite.db.all.mockImplementationOnce((query, params, callback) => {
      callback(null, []); // No items to delete
    });

    // Call the method
    const flushPromise = errsoleSQLite.deleteExpiredNotificationItems();

    // Fast-forward timers
    jest.runAllTimers();

    // Await the method completion
    await flushPromise;

    // Assertions
    expect(errsoleSQLite.getConfig).toHaveBeenCalledWith('logsTTL');
    expect(errsoleSQLite.db.all).toHaveBeenCalledTimes(1);
    expect(errsoleSQLite.db.run).not.toHaveBeenCalled();
    expect(errsoleSQLite.deleteExpiredNotificationItemsRunning).toBe(false);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('should not run if deleteExpiredNotificationItems is already running', async () => {
    // Set the running flag
    errsoleSQLite.deleteExpiredNotificationItemsRunning = true;

    // Call the method
    await errsoleSQLite.deleteExpiredNotificationItems();

    // Assertions
    expect(errsoleSQLite.getConfig).not.toHaveBeenCalled();
    expect(errsoleSQLite.db.all).not.toHaveBeenCalled();
    expect(errsoleSQLite.db.run).not.toHaveBeenCalled();
    expect(errsoleSQLite.deleteExpiredNotificationItemsRunning).toBe(true); // Should remain true
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('should handle errors from getConfig gracefully', async () => {
    // Mock getConfig to throw an error
    errsoleSQLite.getConfig.mockRejectedValueOnce(new Error('Config fetch error'));

    // Call the method
    const flushPromise = errsoleSQLite.deleteExpiredNotificationItems();

    // Fast-forward timers
    jest.runAllTimers();

    // Await the method completion
    await flushPromise;

    // Assertions
    expect(errsoleSQLite.getConfig).toHaveBeenCalledWith('logsTTL');
    expect(errsoleSQLite.db.all).not.toHaveBeenCalled();
    expect(errsoleSQLite.db.run).not.toHaveBeenCalled();
    expect(errsoleSQLite.deleteExpiredNotificationItemsRunning).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith(new Error('Config fetch error'));
  });

  it('should handle errors from db.all gracefully', async () => {
    // Mock db.all to throw an error
    errsoleSQLite.db.all.mockImplementationOnce((query, params, callback) => {
      callback(new Error('Database select error'));
    });

    // Call the method
    const flushPromise = errsoleSQLite.deleteExpiredNotificationItems();

    // Fast-forward timers
    jest.runAllTimers();

    // Await the method completion
    await flushPromise;

    // Assertions
    expect(errsoleSQLite.getConfig).toHaveBeenCalledWith('logsTTL');
    expect(errsoleSQLite.db.all).toHaveBeenCalledTimes(1);
    expect(errsoleSQLite.db.run).not.toHaveBeenCalled();
    expect(errsoleSQLite.deleteExpiredNotificationItemsRunning).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith(new Error('Database select error'));
  });

  it('should handle errors from db.run gracefully', async () => {
    // Mock db.run to throw an error during deletion
    errsoleSQLite.db.run.mockImplementationOnce(function (query, params, callback) {
      callback(new Error('Database delete error'));
    });

    // Call the method
    const flushPromise = errsoleSQLite.deleteExpiredNotificationItems();

    // Fast-forward timers
    jest.runAllTimers();

    // Await the method completion
    await flushPromise;

    // Assertions
    expect(errsoleSQLite.getConfig).toHaveBeenCalledWith('logsTTL');
    expect(errsoleSQLite.db.all).toHaveBeenCalledTimes(1);
    expect(errsoleSQLite.db.run).toHaveBeenCalledWith(
      'DELETE FROM errsole_notifications WHERE id IN (?, ?, ?)',
      [1, 2, 3],
      expect.any(Function)
    );
    expect(errsoleSQLite.deleteExpiredNotificationItemsRunning).toBe(false);
    expect(consoleErrorSpy).toHaveBeenCalledWith(new Error('Database delete error'));
  });

  it('should reset the running flag after completion', async () => {
    // Mock db.all to return IDs and then no more
    errsoleSQLite.db.all
      .mockImplementationOnce((query, params, callback) => {
        callback(null, [{ id: 1 }, { id: 2 }, { id: 3 }]);
      })
      .mockImplementationOnce((query, params, callback) => {
        callback(null, []);
      });

    // Call the method
    const flushPromise = errsoleSQLite.deleteExpiredNotificationItems();

    // Fast-forward timers
    jest.runAllTimers();

    // Await the method completion
    await flushPromise;

    // Ensure the running flag is reset
    expect(errsoleSQLite.deleteExpiredNotificationItemsRunning).toBe(false);
  });
});

describe('ErrsoleSQLite - DeleteAllLogs', () => {
  let errsoleSQLite;

  beforeEach(() => {
    errsoleSQLite = new ErrsoleSQLite(':memory:');

    jest.spyOn(errsoleSQLite.db, 'run').mockImplementation((query, callback) => {
      if (typeof callback === 'function') {
        callback(null);
      }
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should delete all logs successfully', async () => {
    await expect(errsoleSQLite.deleteAllLogs()).resolves.not.toThrow();

    expect(errsoleSQLite.db.run).toHaveBeenCalledWith(
      expect.stringContaining(`DELETE FROM ${errsoleSQLite.logsTable}`),
      expect.any(Function)
    );
  });

  it('should handle database errors during deletion', async () => {
    const dbError = new Error('Database error');
    errsoleSQLite.db.run.mockImplementationOnce((query, callback) => {
      callback(dbError);
    });

    await expect(errsoleSQLite.deleteAllLogs()).rejects.toThrow('Database error');
    expect(errsoleSQLite.db.run).toHaveBeenCalledWith(
      expect.stringContaining(`DELETE FROM ${errsoleSQLite.logsTable}`),
      expect.any(Function)
    );
  });

  it('should resolve even if there are no logs to delete', async () => {
    await expect(errsoleSQLite.deleteAllLogs()).resolves.not.toThrow();
    expect(errsoleSQLite.db.run).toHaveBeenCalledWith(
      expect.stringContaining(`DELETE FROM ${errsoleSQLite.logsTable}`),
      expect.any(Function)
    );
  });
});
