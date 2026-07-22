import { Telegraf, Context } from 'telegraf';
import { createTask, getTasksByUserId, getActiveTasksByUserId, deleteTask, getUserSettings, upsertUserSettings } from '../../lib/telegram/db';
import { agentManager } from '../../lib/telegram/agent-manager';
import { TaskPriority, CreateTaskInput } from '../types';

export function setupTaskHandlers(bot: Telegraf) {
  // /new command - create new task
  bot.command('new', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const agents = agentManager.getAvailableAgents();
    
    if (agents.length === 0) {
      await ctx.reply('Нет доступных агентов.');
      return;
    }

    // Check if user has a default agent
    const userSettings = getUserSettings(userId);
    const defaultAgent = userSettings?.default_agent;

    let message = '📝 Создание новой задачи\n\n';
    message += 'Выберите агента для выполнения задачи:\n\n';

    const keyboard = agents.map(agent => [{
      text: `${agent.name} - ${agent.description}`,
      callback_data: `select_agent_${agent.name}`
    }]);

    if (defaultAgent) {
      message += `⭐ Ваш агент по умолчанию: ${defaultAgent}\n`;
      message += 'Используйте /new_default для быстрого создания с вашим агентом.\n\n';
    }

    await ctx.reply(message, {
      reply_markup: {
        inline_keyboard: keyboard
      }
    });
  });

  // /new_default command - create task with default agent
  bot.command('new_default', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const userSettings = getUserSettings(userId);
    if (!userSettings?.default_agent) {
      await ctx.reply('У вас не установлен агент по умолчанию. Используйте /set_default_agent.');
      return;
    }

    ctx.session = ctx.session || {};
    (ctx.session as any).selectedAgent = userSettings.default_agent;
    
    await ctx.reply(`✅ Используется агент по умолчанию: ${userSettings.default_agent}\n\nВведите описание задачи:`);
  });

  // /set_default_agent command
  bot.command('set_default_agent', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const agents = agentManager.getAvailableAgents();
    
    const keyboard = agents.map(agent => [{
      text: agent.name,
      callback_data: `set_default_${agent.name}`
    }]);

    await ctx.reply('Выберите агента по умолчанию:', {
      reply_markup: {
        inline_keyboard: keyboard
      }
    });
  });

  // Handle setting default agent
  bot.action(/set_default_(.+)/, async (ctx) => {
    if (!('match' in ctx)) return;
    const agentName = ctx.match[1];
    const userId = ctx.from?.id;
    if (!userId) return;

    const agent = agentManager.getAgent(agentName);
    if (!agent) {
      await ctx.reply(`Агент ${agentName} не найден.`);
      return;
    }

    upsertUserSettings({
      telegram_user_id: userId,
      default_agent: agentName,
      notifications_enabled: true
    });

    await ctx.reply(`✅ Агент по умолчанию установлен: ${agent.name}`);
  });

  // Handle text input for task description
  bot.on('text', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const session = ctx.session as any;
    
    // Check if user is in task creation mode
    if (session?.selectedAgent) {
      const description = 'text' in ctx.message ? ctx.message.text : undefined;
      if (!description) return;

      const agentName = session.selectedAgent;
      
      // Create task
      const task = createTask({
        telegram_user_id: userId,
        agent: agentName,
        description: description,
        priority: 'medium'
      });

      // Clear session
      session.selectedAgent = null;

      await ctx.reply(`✅ Задача #${task.id} создана!\n\n`);
      await ctx.reply(`🤖 Агент: ${task.agent}\n📝 Описание: ${task.description}\n⏳ Статус: ${task.status}\n🔥 Приоритет: ${task.priority}`);
      
      // Execute task asynchronously
      agentManager.executeTask(task.id).then(async (result) => {
        const userSettings = getUserSettings(userId);
        if (userSettings?.notifications_enabled) {
          if (result.success) {
            await ctx.reply(`✅ Задача #${task.id} выполнена!\n\nРезультат:\n${result.result}`);
          } else {
            await ctx.reply(`❌ Задача #${task.id} не выполнена!\n\nОшибка: ${result.error}`);
          }
        }
      });

      return;
    }
  });

  // /tasks command - list user's tasks
  bot.command('tasks', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const tasks = getTasksByUserId(userId, 10);
    
    if (tasks.length === 0) {
      await ctx.reply('У вас нет задач. Используйте /new для создания первой задачи.');
      return;
    }

    let message = '📋 Ваши задачи:\n\n';
    
    tasks.forEach(task => {
      const statusEmoji = {
        'pending': '⏳',
        'in_progress': '🔄',
        'completed': '✅',
        'failed': '❌'
      }[task.status] || '❓';

      message += `${statusEmoji} #${task.id} - ${task.agent}\n`;
      message += `   ${task.description.substring(0, 50)}${task.description.length > 50 ? '...' : ''}\n`;
      message += `   Статус: ${task.status} | Приоритет: ${task.priority}\n\n`;
    });

    await ctx.reply(message);
  });

  // /active command - list active tasks
  bot.command('active', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const tasks = getActiveTasksByUserId(userId);
    
    if (tasks.length === 0) {
      await ctx.reply('У вас нет активных задач.');
      return;
    }

    let message = '🔄 Активные задачи:\n\n';
    
    tasks.forEach(task => {
      const statusEmoji = task.status === 'in_progress' ? '🔄' : '⏳';
      message += `${statusEmoji} #${task.id} - ${task.agent}\n`;
      message += `   ${task.description.substring(0, 50)}${task.description.length > 50 ? '...' : ''}\n\n`;
    });

    await ctx.reply(message);
  });

  // /cancel command - cancel a task
  bot.command('cancel', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const args = 'text' in ctx.message ? ctx.message.text.split(' ') : [];
    const taskId = args?.[1] ? parseInt(args[1]) : null;

    if (!taskId) {
      await ctx.reply('Использование: /cancel <task_id>');
      return;
    }

    const deleted = deleteTask(taskId);
    
    if (deleted) {
      await ctx.reply(`✅ Задача #${taskId} отменена.`);
    } else {
      await ctx.reply(`❌ Задача #${taskId} не найдена.`);
    }
  });
}
