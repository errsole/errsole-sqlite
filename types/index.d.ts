declare module 'errsole-sqlite' {
    import { Database } from 'sqlite3';
  
    interface Log {
      id?: number;
      hostname: string;
      pid: number;
      source: string;
      timestamp: Date;
      level: string;
      message: string;
      meta?: string;
    }
  
    interface LogFilter {
      hostname?: string;
      pid?: number;
      level_json?: { source: string; level: string }[];
      sources?: string[];
      levels?: string[];
      lt_id?: number;
      gt_id?: number;
      lte_timestamp?: Date;
      gte_timestamp?: Date;
      limit?: number;
    }
  
    interface Config {
      id: number;
      key: string;
      value: string;
    }
  
    interface User {
      id: number;
      name: string;
      email: string;
      role: string;
    }
  
    class ErrsoleSQLite {
      constructor(filename: string);
  
      getConfig(key: string): Promise<{ item: Config }>;
      setConfig(key: string, value: string): Promise<{ item: Config }>;
      deleteConfig(key: string): Promise<{}>;
  
      postLogs(logEntries: Log[]): Promise<{}>;
      getLogs(filters?: LogFilter): Promise<{ items: Log[] }>;
      searchLogs(searchTerms: string[], filters?: LogFilter): Promise<{ items: Log[], filters: LogFilter[] }>;
  
      getMeta(id: number): Promise<{ item: { id: number; meta: string } }>;
  
      createUser(user: { name: string; email: string; password: string; role: string }): Promise<{ item: User }>;
      verifyUser(email: string, password: string): Promise<{ item: User }>;
      getUserCount(): Promise<{ count: number }>;
      getAllUsers(): Promise<{ items: User[] }>;
      getUserByEmail(email: string): Promise<{ item: User }>;
      updateUserByEmail(email: string, updates: Partial<User>): Promise<{ item: User }>;
      updatePassword(email: string, currentPassword: string, newPassword: string): Promise<{ item: User }>;
      deleteUser(userId: number): Promise<{}>;
    }
  
    export default ErrsoleSQLite;
  }
  