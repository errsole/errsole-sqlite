declare module 'errsole-sqlite' {
  import { Database } from 'sqlite3';
  
  interface Config {
    id?: number;
    key: string;
    value: string;
  }
  
  interface User {
    id?: number;
    name: string;
    email: string;
    role: string;
  }
  
  interface Log {
    id?: number;
    hostname: string;
    pid: number;
    timestamp: Date;
    source: string;
    level: string;
    message: string;
    meta?: string;
    errsole_id?: number;
  }
  
  interface LogFilter {
    lt_id?: number;
    gt_id?: number;
    lte_timestamp?: Date;
    gte_timestamp?: Date;
    hostname?: string;
    level_json?: { source: string; level: string }[];
    errsole_id?: number;
    limit?: number;
  }
  
  interface Notification {
    id?: number;
    errsole_id: number;
    hostname: string;
    hashed_message: string;
    created_at?: Date;
    updated_at?: Date;
  }
  
  class ErrsoleSQLite {
    constructor(filename: string);
    
    getConfig(key: string): Promise<{ item: Config }>;
    setConfig(key: string, value: string): Promise<{ item: Config }>;
    deleteConfig(key: string): Promise<{}>;
    
    createUser(user: { name: string; email: string; password: string; role: string }): Promise<{ item: User }>;
    verifyUser(email: string, password: string): Promise<{ item: User }>;
    getUserCount(): Promise<{ count: number }>;
    getAllUsers(): Promise<{ items: User[] }>;
    getUserByEmail(email: string): Promise<{ item: User }>;
    updateUserByEmail(email: string, updates: Partial<User>): Promise<{ item: User }>;
    updatePassword(email: string, currentPassword: string, newPassword: string): Promise<{ item: User }>;
    deleteUser(id: number): Promise<{}>;
    
    postLogs(logEntries: Log[]): Promise<{}>;
    getLogs(filters?: LogFilter): Promise<{ items: Log[] }>;
    searchLogs(searchTerms: string[], filters?: LogFilter): Promise<{ items: Log[], filters: LogFilter[] }>;
    deleteAllLogs(): Promise<{}>;
    getMeta(id: number): Promise<{ item: { id: number, meta: string } }>;
    
    insertNotificationItem(notification: Notification): Promise<{ previousNotificationItem: Notification | null, todayNotificationCount: number }>;
    
    getHostnames(): Promise<{ items: string[] }>;
  }
  
  export default ErrsoleSQLite;
}
