import Database from 'better-sqlite3';
import path from 'path';
import { Agent, Task, UserSettings, CreateTaskInput, UpdateTaskInput, TaskStatus, TaskPriority } from '../../telegram-bot/types';

const DB_PATH = path.join(process.cwd(), 'data', 'telegram.db');

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initializeSchema();
  }
  return db;
}

function initializeSchema() {
  const db = getDb();

  // Tasks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_user_id INTEGER NOT NULL,
      agent TEXT NOT NULL,
      description TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      priority TEXT DEFAULT 'medium',
      result TEXT,
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Agents table
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      model TEXT NOT NULL,
      description TEXT,
      is_active BOOLEAN DEFAULT 1
    )
  `);

  // User settings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_settings (
      telegram_user_id INTEGER PRIMARY KEY,
      default_agent TEXT,
      notifications_enabled BOOLEAN DEFAULT 1
    )
  `);

  // Indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(telegram_user_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent);
  `);

  // Seed default agents if empty
  const agentCount = db.prepare('SELECT COUNT(*) as count FROM agents').get() as { count: number };
  if (agentCount.count === 0) {
    seedDefaultAgents();
  }
}

function seedDefaultAgents() {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO agents (name, model, description, is_active) VALUES (?, ?, ?, 1)
  `);

  const agents = [
    { name: 'SWE-1.6', model: 'swe-1.6', description: 'Кодинг, debugging, рефакторинг' },
    { name: 'Claude Opus 4.7', model: 'claude-opus-4.7', description: 'Глубокий анализ, сложные задачи' },
    { name: 'Claude 3.5 Sonnet', model: 'claude-3.5-sonnet', description: 'Быстрые задачи, баланс скорости/качества' },
    { name: 'Claude 3 Haiku', model: 'claude-3-haiku', description: 'Максимальная скорость, простые задачи' },
    { name: 'GPT-4', model: 'gpt-4', description: 'Общие задачи, широкий спектр' },
    { name: 'GPT-4 Turbo', model: 'gpt-4-turbo', description: 'Быстрые задачи, обновленные знания' },
    { name: 'GPT-3.5 Turbo', model: 'gpt-3.5-turbo', description: 'Экономичный вариант, простые задачи' },
    { name: 'GPT-5.4', model: 'gpt-5.4', description: 'Продвинутые возможности, мультизадачность' },
    { name: 'GPT-5.5', model: 'gpt-5.5', description: 'Максимальная производительность, сложные сценарии' },
    { name: 'Claude 3 Opus', model: 'claude-3-opus', description: 'Высокое качество, сложные рассуждения' },
    { name: 'Claude 2.1', model: 'claude-2.1', description: 'Стабильная модель, большие контексты' },
  ];

  const insertMany = db.transaction((agentsList: typeof agents) => {
    for (const agent of agentsList) {
      stmt.run(agent.name, agent.model, agent.description);
    }
  });

  insertMany(agents);
}

// Task operations
export function createTask(input: CreateTaskInput): Task {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO tasks (telegram_user_id, agent, description, priority, status)
    VALUES (?, ?, ?, ?, 'pending')
  `);
  const result = stmt.run(input.telegram_user_id, input.agent, input.description, input.priority || 'medium');
  const task = getTaskById(result.lastInsertRowid as number);
  if (!task) {
    throw new Error('Failed to create task');
  }
  return task;
}

export function getTaskById(id: number): Task | undefined {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
  return stmt.get(id) as Task | undefined;
}

export function getTasksByUserId(userId: number, limit = 10): Task[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM tasks 
    WHERE telegram_user_id = ? 
    ORDER BY created_at DESC 
    LIMIT ?
  `);
  return stmt.all(userId, limit) as Task[];
}

export function getActiveTasksByUserId(userId: number): Task[] {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM tasks 
    WHERE telegram_user_id = ? AND status IN ('pending', 'in_progress')
    ORDER BY created_at DESC
  `);
  return stmt.all(userId) as Task[];
}

export function updateTask(id: number, input: UpdateTaskInput): Task | undefined {
  const db = getDb();
  const updates: string[] = [];
  const params: any[] = [];

  if (input.status) {
    updates.push('status = ?');
    params.push(input.status);
  }
  if (input.result !== undefined) {
    updates.push('result = ?');
    params.push(input.result);
  }
  if (input.error !== undefined) {
    updates.push('error = ?');
    params.push(input.error);
  }

  if (updates.length > 0) {
    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(id);
    const stmt = db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`);
    stmt.run(...params);
  }

  return getTaskById(id);
}

export function deleteTask(id: number): boolean {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM tasks WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

// Agent operations
export function getAllAgents(): Agent[] {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM agents WHERE is_active = 1 ORDER BY name');
  return stmt.all() as Agent[];
}

export function getAgentByName(name: string): Agent | undefined {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM agents WHERE name = ?');
  return stmt.get(name) as Agent | undefined;
}

// User settings operations
export function getUserSettings(userId: number): UserSettings | undefined {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM user_settings WHERE telegram_user_id = ?');
  return stmt.get(userId) as UserSettings | undefined;
}

export function upsertUserSettings(settings: UserSettings): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO user_settings (telegram_user_id, default_agent, notifications_enabled)
    VALUES (?, ?, ?)
    ON CONFLICT(telegram_user_id) DO UPDATE SET
      default_agent = excluded.default_agent,
      notifications_enabled = excluded.notifications_enabled
  `);
  stmt.run(settings.telegram_user_id, settings.default_agent, settings.notifications_enabled);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
