export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export type TaskPriority = 'low' | 'medium' | 'high';

export interface Agent {
  id: number;
  name: string;
  model: string;
  description: string;
  is_active: boolean;
}

export interface Task {
  id: number;
  telegram_user_id: number;
  agent: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  result?: string;
  error?: string;
  created_at: string;
  updated_at: string;
}

export interface UserSettings {
  telegram_user_id: number;
  default_agent?: string;
  notifications_enabled: boolean;
}

export interface CreateTaskInput {
  telegram_user_id: number;
  agent: string;
  description: string;
  priority?: TaskPriority;
}

export interface UpdateTaskInput {
  status?: TaskStatus;
  result?: string;
  error?: string;
}
