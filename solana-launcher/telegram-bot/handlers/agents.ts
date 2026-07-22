import { Telegraf, Context } from 'telegraf';
import { agentManager } from '../../lib/telegram/agent-manager';
import { Agent } from '../types';

export function setupAgentHandlers(bot: Telegraf) {
  // /agents command - list all available agents
  bot.command('agents', async (ctx) => {
    const agents = agentManager.getAvailableAgents();
    
    if (agents.length === 0) {
      await ctx.reply('Нет доступных агентов.');
      return;
    }

    let message = '🤖 Доступные AI агенты:\n\n';
    
    agents.forEach((agent, index) => {
      message += `${index + 1}. **${agent.name}**\n`;
      message += `   ${agent.description}\n\n`;
    });

    message += 'Используйте /new для создания задачи с выбором агента.';
    
    await ctx.reply(message, { parse_mode: 'Markdown' });
  });

  // Inline query for agent selection
  bot.action(/select_agent_(.+)/, async (ctx) => {
    if (!('match' in ctx)) return;
    const agentName = ctx.match[1];
    const agent = agentManager.getAgent(agentName);
    
    if (!agent) {
      await ctx.reply(`Агент ${agentName} не найден.`);
      return;
    }

    // Store selected agent in session
    ctx.session = ctx.session || {};
    (ctx.session as any).selectedAgent = agentName;
    
    await ctx.reply(`✅ Выбран агент: ${agent.name}\n\nТеперь введите описание задачи:`);
  });
}
